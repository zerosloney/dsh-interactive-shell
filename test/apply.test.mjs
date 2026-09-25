import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../lib/index.js'

/**
 * Faithful terminals seam double: one shared scrollback buffer driven by
 * `setOutput()` (which appends, like a live PTY) and a `read()` implementing
 * the shipped `LocalPtySession.read()` contract — offset counted backwards
 * from the newest line, `count`-bounded page, `totalLines`/`lineBegin`/`lineEnd`
 * accounting. A fake that returned the whole buffer behind a forward cursor
 * masked the delta defect this suite now pins.
 */
function fakeTerminals() {
  let seq = 0
  const sessions = new Map()
  const spawnRequests = []
  let buffer = ''
  return {
    /** Append raw PTY output; repeated calls accumulate like a running program. */
    setOutput(text) {
      buffer += text
    },
    /** Register a session owned by another tool (e.g. tool-bash-persistent). */
    addForeignSession(id) {
      sessions.set(id, { sessionId: id, status: { kind: 'running' }, type: 'shell' })
    },
    /** The request the most recent spawn() received. */
    lastSpawnRequest() {
      return spawnRequests[spawnRequests.length - 1]
    },
    list: () => [...sessions.values()],
    spawn: async (_agent, request) => {
      spawnRequests.push(request)
      const sessionId = `t${++seq}`
      const snap = { sessionId, status: { kind: 'running' }, type: 'shell' }
      sessions.set(sessionId, snap)
      return { ...snap, motd: 'welcome' }
    },
    startSend: () => ({ done: Promise.resolve({ viewport: 'sent', waitReason: 'ready', sessionStatus: { kind: 'running' }, truncated: false }) }),
    read: (_agent, _id, request = {}) => {
      const offset = request.offset ?? 0
      const count = request.count ?? 500
      const lines = buffer.length === 0 ? [] : buffer.split('\n')
      const totalLines = lines.length
      if (offset >= totalLines) {
        return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: false }
      }
      const end = totalLines - offset
      const start = Math.max(0, end - count)
      const text = lines.slice(start, end).join('\n')
      const returnedLines = text.length === 0 ? 0 : text.split('\n').length
      return { text, totalLines, lineBegin: offset, lineEnd: offset + returnedLines, truncated: false }
    },
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
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  const result = await tool.execute({ action: 'spawn', command: 'vim config.yaml' }, exec)
  assert.match(result.sessionId, /^t\d+/)
  assert.equal(result.exited, false)
  assert.match(result.text, /welcome/)
  stop()
})

test('spawn without a calling agent is refused with the owner-scoping reason', async () => {
  const { registered, stop } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: undefined }
  await assert.rejects(
    () => tool.execute({ action: 'spawn', command: 'vim config.yaml' }, exec),
    /requires a calling agent/,
  )
  stop()
})

test('send action requires sessionId and input', async () => {
  const { registered, stop } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: undefined }
  await assert.rejects(() => tool.execute({ action: 'send' }, exec), /sessionId and input/)
  stop()
})

test('未知 action 由参数 schema 拒绝（defineTool 在 execute 之前校验）', async () => {
  const { registered, stop } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  await assert.rejects(() => tool.execute({ action: 'explode' }, exec), /invalid arguments/)
  stop()
})

test('非法 mode 由参数 schema 拒绝（枚举校验）', async () => {
  const { registered, stop } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  await assert.rejects(
    () => tool.execute({ action: 'spawn', command: 'vim a.txt', mode: 'turbo' }, exec),
    /invalid arguments/,
  )
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

test('attach-monitor 瞬时零等待即检：挂载瞬间若已有命中内容立即触发无需等待 tick', async () => {
  const { ctx, registered, stop, terminals } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  const events = []
  ctx.on('interactive-shell/monitor-triggered', (payload) => events.push(payload))

  const spawned = await tool.execute({ action: 'spawn', command: 'node server.js', mode: 'interactive' }, exec)
  terminals.setOutput('Server started on port 3000\n')

  // attach-monitor 挂载瞬间，执行第 0 次零等待探测
  await tool.execute({ action: 'attach-monitor', sessionId: spawned.sessionId, trigger: 'Server started' }, exec)

  // 验证无需等待 500ms 即刻触发
  assert.equal(events.length, 1)
  assert.equal(events[0].trigger, 'Server started')
  assert.match(events[0].tail, /port 3000/)
  stop()
})

test('dispatch 静默窗：持续输出不完成，静默后完成（P0: 原实现 lastOutputAt 恒等于 now 导致静默窗架空）', async () => {
  const { ctx, registered, stop, terminals } = makeCtx({ dispatchQuietMs: 300 })
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  const events = []
  ctx.on('interactive-shell/dispatch-completed', (payload) => events.push(payload))

  const spawned = await tool.execute({ action: 'spawn', command: 'npm run dev', mode: 'dispatch' }, exec)
  assert.ok(spawned.sessionId)

  // 持续产生真实增量输出 → 每个 tick 都刷新 lastOutputAt → 不应提前完成。
  for (let i = 0; i < 6; i += 1) {
    terminals.setOutput(`tick ${i}\n`)
    await sleep(100)
  }
  assert.equal(events.length, 0, '持续输出时 dispatch 不应完成')

  // 静默 → 超过 quietMs 后应完成一次并清理。
  await sleep(1100)
  assert.ok(events.length >= 1, '静默窗后应触发 dispatch-completed')
  assert.equal(typeof events[0].tail, 'string')
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

test('动作期校验失败写入 trace 台账（异常路径可追溯）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sh-trace-'))
  const tracePath = join(dir, 'traces.jsonl')
  const { registered, stop } = makeCtx({ tracePath })
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  await assert.rejects(() => tool.execute({ action: 'read' }, exec), /read requires sessionId/)
  const trace = readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(trace[0].event, 'error')
  assert.match(trace[0].detail.message, /read requires sessionId/)
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
  // dsh 0.1.7 退役了通配的 `plugin` 源类型；本插件声明自己的 kind。
  assert.equal(msg.source.kind, 'interactive-shell')
  assert.equal(msg.source.form, 'notice')
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

// ---------- 工具契约 / 缝隙用法回归（dsh 0.1.7） ----------

test('spawn 使用配置的 backendType，且不占用 PTY 显示名（避免 DUPLICATE_NAME）', async () => {
  const { registered, stop, terminals } = makeCtx({ backendType: 'custom-pty' })
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  const first = await tool.execute({ action: 'spawn', command: 'npm test' }, exec)
  assert.equal(terminals.lastSpawnRequest().type, 'custom-pty')
  assert.equal(terminals.lastSpawnRequest().name, undefined, 'PTY 显示名留给宿主，同命令并行不应冲突')
  const second = await tool.execute({ action: 'spawn', command: 'npm test' }, exec)
  assert.notEqual(first.sessionId, second.sessionId)
  stop()
})

test('会话预算只统计本插件的存活会话（不受其他工具持有的 PTY 影响）', async () => {
  const { registered, stop, terminals } = makeCtx({ maxSessions: 1 })
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  terminals.addForeignSession('other-tool-pty')
  const first = await tool.execute({ action: 'spawn', command: 'vim a.txt' }, exec)
  assert.ok(first.sessionId)
  await assert.rejects(
    () => tool.execute({ action: 'spawn', command: 'vim b.txt' }, exec),
    /budget exceeded/,
  )

  // 释放自己的会话后可再开一个；别人持有的 PTY 始终不占预算。
  await tool.execute({ action: 'kill', sessionId: first.sessionId }, exec)
  const second = await tool.execute({ action: 'spawn', command: 'vim c.txt' }, exec)
  assert.ok(second.sessionId)
  stop()
})

test('dispatch 的 per-call timeoutMs 生效（不依赖静默窗）', async () => {
  const { ctx, registered, stop } = makeCtx({ dispatchQuietMs: 600000, dispatchTimeoutMs: 600000 })
  const tool = registered[0]
  const events = []
  ctx.on('interactive-shell/dispatch-completed', (payload) => events.push(payload))
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  await tool.execute(
    { action: 'spawn', command: 'sleep 60', mode: 'dispatch', timeoutMs: 1000 },
    exec,
  )
  await sleep(1500)
  assert.equal(events.length, 1, `到达 deadline 应完成一次，实际 ${events.length}`)
  stop()
})

test('timeoutMs 越界时报出可操作错误', async () => {
  const { registered, stop } = makeCtx()
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  await assert.rejects(
    () => tool.execute({ action: 'spawn', command: 'npm test', mode: 'dispatch', timeoutMs: 10 }, exec),
    /timeoutMs must be between/,
  )
  stop()
})

test('流式镜像受 maxOutputBytesPerSec 限流（熔断器已接入广播路径）', async () => {
  const { ctx, registered, stop, terminals } = makeCtx({ maxOutputBytesPerSec: 1024 })
  const tool = registered[0]
  const frames = []
  ctx.on('interactive-shell/stream-frame', (frame) => frames.push(frame))
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  await tool.execute({
    action: 'spawn',
    command: 'tail -f huge.log',
    mode: 'monitor',
    trigger: 'NEVER_MATCHES',
  }, exec)
  terminals.setOutput(`${'x'.repeat(4096)}\n`)
  await sleep(400)

  const throttled = frames.filter((frame) => frame.type === 'term:event' && frame.event === 'output-throttled')
  assert.equal(throttled.length, 1, '应广播一次限流事件')
  assert.equal(frames.filter((frame) => frame.type === 'term:output').length, 0, '超限窗口内不再广播输出帧')
  stop()
})


