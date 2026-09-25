import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../lib/index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fake PTY registry implementing the shipped `read()` contract (offset counted
 * backwards from the newest line, `totalLines`/`lineBegin`/`lineEnd` paging),
 * tagged with a spawn counter so a test can tell which registry a call reached.
 */
function fakeRegistry(tag) {
  let seq = 0
  let buffer = ''
  const sessions = new Map()
  const registry = {
    tag,
    spawnCount: 0,
    /** Append raw PTY output, like a running program. */
    setOutput(text) {
      buffer += text
    },
    /** Replace the retained scrollback, simulating the bounded ring dropping lines. */
    setBuffer(text) {
      buffer = text
    },
    list: () => [...sessions.values()],
    spawn: async () => {
      registry.spawnCount += 1
      const sessionId = `${tag}${++seq}`
      const snap = { sessionId, status: { kind: 'running' }, type: 'shell' }
      sessions.set(sessionId, snap)
      return { ...snap, motd: `${tag} motd` }
    },
    startSend: () => ({
      done: Promise.resolve({ viewport: '', waitReason: 'ready', sessionStatus: { kind: 'running' }, truncated: false }),
    }),
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
  return registry
}

/**
 * Mount the bridge with explicit services published before `apply`,
 * mirroring what a loader row would compose.
 */
function makeCtx(configOverrides = {}, provide = {}) {
  const ctx = new Context()
  const registered = []
  ctx.provide('tools', { register: (tool) => { registered.push(tool); return () => {} } })
  for (const [name, value] of Object.entries(provide)) {
    ctx.provide(name, value)
  }
  const stop = apply(ctx, {
    defaultMode: 'monitor',
    maxSessions: 4,
    outputTailBytes: 4096,
    dispatchQuietMs: 5000,
    dispatchTimeoutMs: 600000,
    monitorCooldownMs: 3000,
    monitorMaxEvents: 100,
    tracePath: '',
    ...configOverrides,
  })
  return { ctx, registered, stop }
}

// ---------- P0-1: seam resolution is per agent, never a silent no-op ----------

test('P0-1: 无任何 PTY 缝隙时工具仍注册，并以可操作的安装指引失败', async () => {
  const { registered, stop } = makeCtx()
  assert.equal(registered.length, 1, '可用性只能在调用点判定：工具必须注册')
  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }
  await assert.rejects(
    () => tool.execute({ action: 'spawn', command: 'npm test' }, exec),
    (error) => {
      assert.match(error.message, /no persistent PTY registry/)
      assert.match(error.message, /agent preset/)
      assert.match(error.message, /dsh-terminal/)
      return true
    },
  )
  stop()
})

test('P0-1: agent preset 隔离域内的 PTY 注册表被优先解析（host 平面读不到也不影响）', async () => {
  const scoped = fakeRegistry('scoped')
  const root = fakeRegistry('root')
  const agentCtx = new Context()
  const { registered, stop } = makeCtx({}, {
    terminals: root,
    agentPresets: {
      serviceFor: (agent, name) => (name === 'terminals' && agent.ctx === agentCtx ? scoped : undefined),
    },
  })
  const tool = registered[0]
  const agent = { id: 'agent-1', ctx: agentCtx, followup: () => {} }
  const exec = { signal: new AbortController().signal, agent }

  const spawned = await tool.execute({ action: 'spawn', command: 'vim a.txt' }, exec)
  assert.match(spawned.text, /scoped motd/)
  assert.equal(scoped.spawnCount, 1, '会话应落在 agent 自己的 preset 注册表里')
  assert.equal(root.spawnCount, 0, 'host 平面注册表不应被使用')

  // 会话存续期内，后续调用仍走同一实例。
  const read = await tool.execute({ action: 'read', sessionId: spawned.sessionId }, exec)
  assert.equal(read.sessionId, spawned.sessionId)
  assert.equal(root.spawnCount, 0)
  stop()
})

// ---------- P0-2: output delta comes from totalLines, not a forward cursor ----------

test('P0-2: monitor 触发只匹配新输出，tail 不得回放陈旧行（原 bug: 把 lineEnd 当前进游标）', async () => {
  const terminals = fakeRegistry('mon')
  const { ctx, registered, stop } = makeCtx({ monitorCooldownMs: 100 }, { terminals })
  const tool = registered[0]
  const events = []
  ctx.on('interactive-shell/monitor-triggered', (payload) => events.push(payload))
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  const spawned = await tool.execute({ action: 'spawn', command: 'node server.js', mode: 'interactive' }, exec)
  terminals.setOutput('banner: dev server starting\n')
  await tool.execute({ action: 'attach-monitor', sessionId: spawned.sessionId, trigger: 'error' }, exec)
  terminals.setOutput('error: port 3000 already in use\n')

  await sleep(900)
  assert.equal(events.length, 1, `应触发一次，实际 ${events.length}`)
  assert.match(events[0].tail, /port 3000 already in use/)
  assert.doesNotMatch(events[0].tail, /banner/, 'tail 不得回放 attach 之前就已消费的旧输出')
  stop()
})

test('P0-2: 轮询只广播新增量，同一行既不丢失也不重复', async () => {
  const terminals = fakeRegistry('dlt')
  const { ctx, registered, stop } = makeCtx({ monitorCooldownMs: 100 }, { terminals })
  const tool = registered[0]
  const frames = []
  ctx.on('interactive-shell/stream-frame', (frame) => frames.push(frame))
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  await tool.execute({
    action: 'spawn',
    command: 'npm run dev',
    mode: 'monitor',
    trigger: 'NEVER_MATCHES',
  }, exec)

  terminals.setOutput('banner: start\n')
  await sleep(700)
  terminals.setOutput('listening on http://localhost:3000\n')
  await sleep(700)

  const chunks = frames.filter((frame) => frame.type === 'term:output').map((frame) => frame.chunk).join('')
  assert.equal((chunks.match(/banner: start/g) ?? []).length, 1, `新行应恰好交付一次: ${JSON.stringify(chunks)}`)
  assert.equal((chunks.match(/listening on http/g) ?? []).length, 1, `新行应恰好交付一次: ${JSON.stringify(chunks)}`)
  stop()
})

test('P0-2: 同一行被原地改写（进度条）也要交付', async () => {
  const terminals = fakeRegistry('prg')
  const { ctx, registered, stop } = makeCtx({ monitorCooldownMs: 100 }, { terminals })
  const tool = registered[0]
  const events = []
  ctx.on('interactive-shell/monitor-triggered', (payload) => events.push(payload))
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  await tool.execute({
    action: 'spawn',
    command: 'npm run build',
    mode: 'monitor',
    trigger: '99%',
  }, exec)

  terminals.setOutput('progress 10%')
  await sleep(300)
  terminals.setOutput(' → 99%')
  await sleep(900)

  assert.equal(events.length, 1, `原地改写应触发，实际 ${events.length}`)
  assert.match(events[0].tail, /99%/)
  stop()
})

test('P0-2: 有界 scrollback 被裁剪后重新对齐，最新输出仍会交付', async () => {
  const terminals = fakeRegistry('ring')
  const { ctx, registered, stop } = makeCtx({ monitorCooldownMs: 100 }, { terminals })
  const tool = registered[0]
  const events = []
  ctx.on('interactive-shell/monitor-triggered', (payload) => events.push(payload))
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1' } }

  await tool.execute({
    action: 'spawn',
    command: 'tail -f app.log',
    mode: 'monitor',
    trigger: 'fatal',
  }, exec)

  terminals.setOutput('line1\nline2\nline3\nline4\n')
  await sleep(300)
  // 有界环形缓冲丢弃前几行，同时写入触发行。
  terminals.setBuffer('line4\nfatal: disk full\n')
  await sleep(900)

  assert.equal(events.length, 1, `裁剪后仍应交付最新输出，实际 ${events.length}`)
  assert.match(events[0].tail, /fatal: disk full/)
  stop()
})

// ---------- P0-3: the retired catch-all `plugin` source kind is gone ----------

test('P0-3: 唤醒消息声明本插件自己的 source kind，并对 summary 施加 120 字符上界', async () => {
  const terminals = fakeRegistry('wake')
  const { registered, stop } = makeCtx({ monitorCooldownMs: 100 }, { terminals })
  const tool = registered[0]
  const wokeMessages = []
  const longTrigger = 'x'.repeat(150)
  const agent = { id: 'agent-1', followup: (msg) => wokeMessages.push(msg) }
  const exec = { signal: new AbortController().signal, agent }

  const spawned = await tool.execute({
    action: 'spawn',
    command: 'tail -f app.log',
    mode: 'monitor',
    trigger: longTrigger,
  }, exec)
  await sleep(300)
  terminals.setOutput(`${longTrigger}\n`)
  await sleep(900)

  assert.ok(wokeMessages.length >= 1, `应唤醒 Agent，实际 ${wokeMessages.length}`)
  const msg = wokeMessages[0]
  assert.equal(msg.role, 'user')
  assert.equal(msg.source.kind, 'interactive-shell', '0.1.7 起 `plugin` 通配 kind 已被 session 格式拒绝')
  assert.equal(msg.source.form, 'notice')
  assert.ok(msg.source.summary.length <= 120, `summary 必须受 boundContextSummary 约束: ${msg.source.summary.length}`)
  assert.match(msg.source.summary, new RegExp(`Shell session ${spawned.sessionId} triggered`))
  assert.ok(msg.content[0].text.includes(longTrigger.slice(0, 40)))
  stop()
})
