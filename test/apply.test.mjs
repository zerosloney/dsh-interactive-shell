import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../lib/index.js'

/** Minimal fake terminals seam. */
function fakeTerminals() {
  let seq = 0
  const sessions = new Map()
  // 可控输出：read 返回当前缓冲；setOutput 用于回归测试驱动轮询路径。
  let output = ''
  let line = 0
  return {
    setOutput(text) {
      output = text
      line += 1
    },
    list: () => [...sessions.values()],
    spawn: async () => {
      const sessionId = `t${++seq}`
      const snap = { sessionId, status: { kind: 'running' }, type: 'shell' }
      sessions.set(sessionId, snap)
      return { ...snap, motd: 'welcome' }
    },
    startSend: () => ({ done: Promise.resolve({ viewport: 'sent', waitReason: 'ready', sessionStatus: { kind: 'running' }, truncated: false }) }),
    read: () => ({ text: output, totalLines: 1, lineBegin: 0, lineEnd: line, truncated: false }),
    signal: async () => ({ processGroupId: 1 }),
    kill: async () => true,
  }
}

function makeCtx(overrides = {}) {
  const ctx = new Context()
  const terminals = fakeTerminals()
  ctx.provide('terminals', terminals)
  const registered = []
  ctx.provide('tools', { register: (tool) => { registered.push(tool); return () => {} } })
  const stop = apply(ctx, {
    defaultMode: 'monitor',
    maxSessions: 4,
    outputTailBytes: 4096,
    dispatchQuietMs: 5000,
    dispatchTimeoutMs: 600000,
    monitorCooldownMs: 2000,
    monitorMaxEvents: 100,
    tracePath: '',
    ...overrides,
  })
  return { ctx, registered, stop, terminals }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('apply registers the single interactive_shell tool', () => {
  const { registered } = makeCtx()
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'interactive_shell')
})

test('spawn action starts a session and returns its id + motd', async () => {
  const { registered, stop } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: undefined }
  const result = await tool.execute({ action: 'spawn', command: 'vim config.yaml' }, exec)
  assert.match(result.sessionId, /^t\d+/)
  assert.equal(result.exited, false)
  assert.match(result.text, /welcome/)
  stop()
})

test('send action requires sessionId and input', async () => {
  const { registered, stop } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: undefined }
  await assert.rejects(() => tool.execute({ action: 'send' }, exec), /sessionId and input/)
  stop()
})

test('unknown action rejects with a clear error', async () => {
  const { registered, stop } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: undefined }
  await assert.rejects(() => tool.execute({ action: 'explode' }, exec), /unknown action/)
  stop()
})

// ---------- P0 回归测试（2026-08-25 修复） ----------

test('attach-monitor 设置的 trigger 能真正触发 monitor-triggered（P0: 原实现闭包固化 trigger 永不生效）', async () => {
  const { ctx, registered, stop, terminals } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  const events = []
  ctx.on('interactive-shell/monitor-triggered', (payload) => events.push(payload))

  // interactive 模式 spawn（不带 trigger），然后 attach-monitor 补 trigger。
  const spawned = await tool.execute({ action: 'spawn', command: 'tail -f app.log', mode: 'interactive' }, exec)
  terminals.setOutput('INFO: start\n')
  await tool.execute({ action: 'attach-monitor', sessionId: spawned.sessionId, trigger: 'ERROR' }, exec)
  terminals.setOutput('ERROR: boom\n')

  // 等 ≥2 个 500ms poll tick：monitor 分支应命中 state.trigger 并发出事件。
  await sleep(1400)
  assert.ok(events.length >= 1, `monitor-triggered 应触发，实际 ${events.length} 次`)
  assert.equal(events[0].trigger, 'ERROR')
  assert.match(events[0].tail, /ERROR: boom/)
  stop()
})

test('dispatch 静默窗：持续输出不完成，静默后完成（P0: 原实现 lastOutputAt 恒等于 now 导致静默窗架空）', async () => {
  const { ctx, registered, stop, terminals } = makeCtx({ dispatchQuietMs: 300 })
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  const events = []
  ctx.on('interactive-shell/dispatch-completed', (payload) => events.push(payload))

  terminals.setOutput('tick output\n')
  await tool.execute({ action: 'spawn', command: 'npm run dev', mode: 'dispatch' }, exec)

  // 持续有输出 → lastOutputAt 不断刷新 → 不应提前完成。
  await sleep(1100)
  assert.equal(events.length, 0, '持续输出时 dispatch 不应完成')

  // 静默 → 超过 quietMs 后应完成一次并清理。
  terminals.setOutput('')
  await sleep(1100)
  assert.ok(events.length >= 1, '静默窗后应触发 dispatch-completed')
  assert.equal(events[0].tail, '')
  stop()
})

test('spawn 超过会话预算时拒绝（异常路径，预算守卫）', async () => {
  const { registered, stop } = makeCtx({ maxSessions: 1 })
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  const first = await tool.execute({ action: 'spawn', command: 'vim a.txt' }, exec)
  assert.ok(first.sessionId)
  await assert.rejects(
    () => tool.execute({ action: 'spawn', command: 'vim b.txt' }, exec),
    /budget exceeded/,
  )
  stop()
})

test('kill 已存在会话返回终止并写入台账（可追踪审计）', async () => {
  const tracePath = join(tmpdir(), `sh-trace-${process.pid}-${Date.now()}.jsonl`)
  const { registered, stop } = makeCtx({ tracePath })
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  const spawned = await tool.execute({ action: 'spawn', command: 'top' }, exec)
  const killed = await tool.execute({ action: 'kill', sessionId: spawned.sessionId }, exec)
  assert.equal(killed.text, 'terminated')
  assert.equal(killed.exited, true)
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(trace.some((e) => e.event === 'session-killed'), '应记录 session-killed 事件')
  assert.ok(trace.some((e) => e.event === 'session-started'), '应记录 session-started 事件')
  stop()
})

test('unknown action 的错误写入 trace 台账（异常路径可追溯）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sh-trace-'))
  const tracePath = join(dir, 'traces.jsonl')
  const { registered, stop } = makeCtx({ tracePath })
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  await assert.rejects(() => tool.execute({ action: 'explode' }, exec), /unknown action/)
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(trace[0].event, 'error')
  assert.match(trace[0].detail.message, /unknown action/)
  stop()
})

// ---------- P0/P1/P2 闭环与生命周期测试 ----------

test('P0: dispatch 完成时通过 agent.followup 唤醒 Agent', async () => {
  const { registered, stop, terminals } = makeCtx({ dispatchQuietMs: 200 })
  const tool = registered[0]
  const wokeMessages = []
  const agent = {
    id: 'agent-1',
    followup: (msg) => wokeMessages.push(msg),
  }
  const exec = { signal: new AbortController().signal, agent }

  terminals.setOutput('building...\n')
  await tool.execute({ action: 'spawn', command: 'npm run build', mode: 'dispatch' }, exec)
  terminals.setOutput('')

  // 等待静默完成
  await sleep(1000)
  assert.ok(wokeMessages.length >= 1, `Agent 应收到 followup 唤醒消息，实际收到 ${wokeMessages.length}`)
  const msg = wokeMessages[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'plugin')
  assert.equal(msg.source.plugin, 'interactive-shell')
  assert.match(msg.content[0].text, /completed/)
  stop()
})

test('P0: monitor 触发时通过 agent.followup 唤醒 Agent', async () => {
  const { registered, stop, terminals } = makeCtx({ monitorCooldownMs: 100 })
  const tool = registered[0]
  const wokeMessages = []
  const agent = {
    id: 'agent-1',
    followup: (msg) => wokeMessages.push(msg),
  }
  const exec = { signal: new AbortController().signal, agent }

  const spawned = await tool.execute({ action: 'spawn', command: 'tail -f logs', mode: 'interactive' }, exec)
  await tool.execute({ action: 'attach-monitor', sessionId: spawned.sessionId, trigger: 'FATAL' }, exec)

  terminals.setOutput('FATAL: disk full\n')
  await sleep(1200)

  assert.ok(wokeMessages.length >= 1, `Monitor 触发后 Agent 应收到 followup 消息，实际 ${wokeMessages.length}`)
  const msg = wokeMessages[0]
  assert.match(msg.content[0].text, /FATAL/)
  assert.equal(msg.source.summary, `Shell session ${spawned.sessionId} triggered on /FATAL/`)
  stop()
})

test('P1: status 发现会话已退出时清理内部状态 Map', async () => {
  let snapStatus = { kind: 'running' }
  const fakeTerm = {
    list: () => [{ sessionId: 't1', status: snapStatus, type: 'shell' }],
    spawn: async () => ({ sessionId: 't1', status: snapStatus, type: 'shell', motd: 'ok' }),
    read: () => ({ text: 'exited output', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false }),
    kill: async () => true,
  }
  const ctx = new Context()
  ctx.provide('terminals', fakeTerm)
  const registered = []
  ctx.provide('tools', { register: (tool) => { registered.push(tool); return () => {} } })
  const stop = apply(ctx, {
    defaultMode: 'interactive',
    maxSessions: 4,
    outputTailBytes: 4096,
    dispatchQuietMs: 5000,
    dispatchTimeoutMs: 600000,
    monitorCooldownMs: 2000,
    monitorMaxEvents: 100,
    tracePath: '',
  })
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  await tool.execute({ action: 'spawn', command: 'python script.py', mode: 'interactive' }, exec)
  // 模拟进程退出
  snapStatus = { kind: 'exited', exitCode: 0 }
  const statusRes = await tool.execute({ action: 'status', sessionId: 't1' }, exec)
  assert.equal(statusRes.exited, true)
  assert.match(statusRes.text, /status=exited exit=0/)

  stop()
})

test('P2: watch 监听文件变化并在 monitor 模式下触发通知与唤醒', async () => {
  const { writeFileSync } = await import('node:fs')
  const dir = mkdtempSync(join(tmpdir(), 'sh-watch-'))
  const watchFile = join(dir, 'test.log')
  writeFileSync(watchFile, 'initial line\n', 'utf8')

  const { ctx, registered, stop } = makeCtx({ monitorCooldownMs: 100 })
  const tool = registered[0]
  const wokeMessages = []
  const agent = {
    id: 'agent-1',
    followup: (msg) => wokeMessages.push(msg),
  }
  const exec = { signal: new AbortController().signal, agent }
  const events = []
  ctx.on('interactive-shell/monitor-triggered', (payload) => events.push(payload))

  const spawned = await tool.execute({
    action: 'spawn',
    command: 'tail -f test.log',
    mode: 'monitor',
    watch: watchFile,
  }, exec)
  assert.ok(spawned.sessionId)

  // 修改被监听的文件
  await sleep(100)
  writeFileSync(watchFile, 'updated line\n', 'utf8')
  await sleep(600)

  assert.ok(events.length >= 1, `watch 文件变化后应触发 monitor-triggered，实际 ${events.length}`)
  assert.equal(events[0].trigger, `watch:${watchFile}`)
  assert.ok(wokeMessages.length >= 1, `watch 触发后 Agent 应收到 followup，实际 ${wokeMessages.length}`)
  stop()
})

// ---------- M4 Phase 1: 流式适配层与事件广播测试 ----------

test('M4 Phase 1: 挂载 interactiveShellStream 并广播 stream-frame (init / output / event)', async () => {
  const { ctx, registered, stop, terminals } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  const streamFrames = []
  ctx.on('interactive-shell/stream-frame', (frame) => streamFrames.push(frame))

  assert.ok(ctx.interactiveShellStream, 'Context 应挂载 interactiveShellStream Hub 实例')

  // 1. spawn 时派发 init 与 session-started 帧
  const spawned = await tool.execute({ action: 'spawn', command: 'node server.js', mode: 'interactive' }, exec)
  assert.ok(spawned.sessionId)

  const initFrames = streamFrames.filter((f) => f.type === 'term:init')
  assert.equal(initFrames.length, 1)
  assert.equal(initFrames[0].sessionId, spawned.sessionId)
  assert.equal(initFrames[0].command, 'node server.js')

  // 2. 产生输出并读取时派发 output 帧
  terminals.setOutput('Server running on port 3000\n')
  await tool.execute({ action: 'read', sessionId: spawned.sessionId }, exec)

  // 3. kill 时派发 session-killed 帧并清理
  await tool.execute({ action: 'kill', sessionId: spawned.sessionId }, exec)
  const killFrames = streamFrames.filter((f) => f.type === 'term:event' && f.event === 'session-killed')
  assert.equal(killFrames.length, 1)

  stop()
})

test('M4 Phase 1: 控制权锁变更时广播 lock 帧与 lock-changed 事件', async () => {
  const { ctx, stop } = makeCtx()
  const lockEvents = []
  ctx.on('interactive-shell/lock-changed', (payload) => lockEvents.push(payload))

  const streamHub = ctx.interactiveShellStream
  assert.ok(streamHub)

  // 获取接管锁
  const acquired = streamHub.acquireLock('t1', 'developer-bob')
  assert.equal(acquired, true)
  assert.equal(lockEvents.length, 1)
  assert.equal(lockEvents[0].sessionId, 't1')
  assert.equal(lockEvents[0].state, 'user_takeover')
  assert.equal(lockEvents[0].lockedBy, 'developer-bob')

  // 释放接管锁
  const released = streamHub.releaseLock('t1')
  assert.equal(released, true)
  assert.equal(lockEvents.length, 2)
  assert.equal(lockEvents[1].state, 'agent_driving')
  assert.equal(lockEvents[1].lockedBy, undefined)

  stop()
})

// ---------- M4 Phase 3: 双向交互与接管协议测试 ----------

test('M4 Phase 3: 用户接管状态下 sendUserInput 直通 PTY 写入', async () => {
  const { ctx, registered, stop, terminals } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  const spawned = await tool.execute({ action: 'spawn', command: 'psql', mode: 'interactive' }, exec)
  const streamHub = ctx.interactiveShellStream
  assert.ok(streamHub)

  // 用户接管
  streamHub.acquireLock(spawned.sessionId, 'alice')

  // 用户直接通过 streamHub 敲击键盘/发送输入
  terminals.setOutput('psql (16.0)\npostgres=> ')
  const viewport = await streamHub.sendUserInput(spawned.sessionId, 'SELECT 1;\n')
  assert.ok(viewport !== undefined)

  stop()
})

test('M4 Phase 3: 用户接管时拦截 Agent send 工具调用并明确报错', async () => {
  const { ctx, registered, stop } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  const spawned = await tool.execute({ action: 'spawn', command: 'vim config.yml', mode: 'interactive' }, exec)
  const streamHub = ctx.interactiveShellStream
  assert.ok(streamHub)

  // 用户接管
  streamHub.acquireLock(spawned.sessionId, 'bob')

  // Agent 试图 send 时被拦截
  await assert.rejects(
    () => tool.execute({ action: 'send', sessionId: spawned.sessionId, input: ':wq\n' }, exec),
    /locked by user takeover \(bob\)/,
  )

  // 用户交还控制权后 Agent 恢复可用
  streamHub.releaseLock(spawned.sessionId)
  const sent = await tool.execute({ action: 'send', sessionId: spawned.sessionId, input: ':wq\n' }, exec)
  assert.ok(sent)

  stop()
})

test('M4 Phase 3: 交还控制权 (handback / releaseLock) 自动唤醒 Agent 并注入上下文通知', async () => {
  const { ctx, registered, stop } = makeCtx()
  const tool = registered[0]
  const wokeMessages = []
  const agent = {
    id: 'agent-1',
    followup: (msg) => wokeMessages.push(msg),
  }
  const exec = { signal: new AbortController().signal, agent }

  const spawned = await tool.execute({ action: 'spawn', command: 'htop', mode: 'interactive' }, exec)
  const streamHub = ctx.interactiveShellStream
  assert.ok(streamHub)

  // 用户接管
  streamHub.acquireLock(spawned.sessionId, 'alice')

  // 用户交还控制权并附带操作备注
  streamHub.handback(spawned.sessionId, '已杀死占用 99% CPU 的死循环进程 PID 4321')

  assert.equal(wokeMessages.length, 1)
  assert.equal(wokeMessages[0].source.form, 'notice')
  assert.match(wokeMessages[0].source.summary, /User released control of shell session/)
  assert.match(wokeMessages[0].content[0].text, /已杀死占用 99% CPU 的死循环进程 PID 4321/)

  stop()
})


