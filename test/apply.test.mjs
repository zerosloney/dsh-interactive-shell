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
