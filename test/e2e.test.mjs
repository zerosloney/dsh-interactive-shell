import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  apply,
  TermStreamClient,
  DshShellPanelController,
  renderShellPanelHtml,
} from '../lib/index.js'

/**
 * Faithful terminals seam double (same contract as `apply.test.mjs`): shared
 * scrollback appended by `setOutput()`, with `read()` implementing the shipped
 * newest-relative offset / `totalLines` paging.
 */
function fakeTerminals() {
  let seq = 0
  const sessions = new Map()
  let buffer = ''
  return {
    setOutput(text) {
      buffer += text
    },
    list: () => [...sessions.values()],
    spawn: async () => {
      const sessionId = `term_${++seq}`
      const snap = { sessionId, status: { kind: 'running' }, type: 'shell' }
      sessions.set(sessionId, snap)
      return { ...snap, motd: 'Session initialized' }
    },
    startSend: (_agent, _id, options) => {
      if (options?.text) {
        buffer += options.text
      }
      return {
        done: Promise.resolve({
          viewport: buffer,
          waitReason: 'ready',
          sessionStatus: { kind: 'running' },
          truncated: false,
        }),
      }
    },
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

function createTestEnvironment() {
  const ctx = new Context()
  const terminals = fakeTerminals()
  ctx.provide('terminals', terminals)
  const tools = []
  ctx.provide('tools', { register: (t) => { tools.push(t); return () => {} } })

  const stop = apply(ctx, {
    defaultMode: 'interactive',
    maxSessions: 5,
    outputTailBytes: 4096,
    dispatchQuietMs: 500,
    dispatchTimeoutMs: 5000,
    monitorCooldownMs: 1000,
    monitorMaxEvents: 50,
    tracePath: '',
  })

  return { ctx, tool: tools[0], stop, terminals }
}

test('E2E: Full Interactive Lifecycle (Spawn -> Stream -> Takeover -> Direct Input -> Handback -> Agent Wakeup)', async () => {
  const { ctx, tool, stop, terminals } = createTestEnvironment()
  const agentFollowupNotes = []
  const mockAgent = {
    id: 'deepseek-coder-agent',
    followup: (msg) => agentFollowupNotes.push(msg),
  }
  const exec = { signal: new AbortController().signal, agent: mockAgent }

  // 1. Agent spawns interactive shell session
  const spawnRes = await tool.execute(
    { action: 'spawn', command: 'node repl.js', mode: 'interactive' },
    exec,
  )
  const sessionId = spawnRes.sessionId
  assert.ok(sessionId)

  // 2. Web UI attaches to the backend StreamHub via Client & PanelController
  const streamHub = ctx.interactiveShellStream
  assert.ok(streamHub)

  const client = new TermStreamClient(sessionId, { initialCommand: 'node repl.js', initialMode: 'interactive' })
  client.connectHub(streamHub)

  const panel = new DshShellPanelController({ operatorName: 'lead-developer' })
  panel.addSession(client)

  // Verify initial state
  assert.equal(panel.getActiveSessionId(), sessionId)
  assert.equal(client.getState().lockState, 'agent_driving')

  // 3. Output arrives from backend PTY
  terminals.setOutput('> welcome to node repl\n> ')
  streamHub.broadcast({
    type: 'term:output',
    sessionId,
    chunk: '> welcome to node repl\n> ',
    lineBegin: 0,
    lineEnd: 2,
    time: Date.now(),
  })

  // Web UI has captured the output
  assert.ok(client.getBuffer().getText().includes('welcome to node repl'))
  const html1 = renderShellPanelHtml(panel)
  assert.ok(html1.includes('welcome to node repl'))
  assert.ok(html1.includes('dsh-btn-takeover'))

  // 4. Human developer takes over the terminal in Web UI
  const takeoverOk = panel.toggleTakeover(sessionId)
  assert.equal(takeoverOk, true)
  assert.equal(client.getState().lockState, 'user_takeover')
  assert.equal(client.getState().lockedBy, 'lead-developer')

  // 5. Agent attempts to call `send` during human takeover -> blocked safely
  await assert.rejects(
    () => tool.execute({ action: 'send', sessionId, input: 'const x = 1;\n' }, exec),
    /locked by user takeover \(lead-developer\)/,
  )

  // 6. Human developer sends direct keystrokes through the Web UI panel
  await streamHub.sendUserInput(sessionId, 'const secretKey = "api_key_123";\n')
  streamHub.broadcast({
    type: 'term:output',
    sessionId,
    chunk: 'const secretKey = "api_key_123";\nundefined\n> ',
    lineBegin: 2,
    lineEnd: 4,
    time: Date.now(),
  })

  // 7. Human developer hands back control with handback notes
  const releaseOk = panel.toggleTakeover(sessionId, 'Configured API secret key in memory')
  assert.equal(releaseOk, false)
  assert.equal(client.getState().lockState, 'agent_driving')

  // 8. Agent receives followup user-turn notification
  assert.equal(agentFollowupNotes.length, 1)
  const notice = agentFollowupNotes[0]
  assert.equal(notice.source.form, 'notice')
  assert.match(notice.source.summary, /User released control of shell session/)
  assert.match(notice.content[0].text, /Configured API secret key in memory/)

  // 9. Agent now resumes tool calls freely
  const agentSendRes = await tool.execute(
    { action: 'send', sessionId, input: 'console.log("ready");\n' },
    exec,
  )
  assert.ok(agentSendRes)
  assert.equal(agentSendRes.exited, false)

  // 10. Kill session and cleanup
  await tool.execute({ action: 'kill', sessionId }, exec)
  panel.removeSession(sessionId)
  assert.equal(panel.getActiveSessionId(), null)

  panel.dispose()
  client.dispose()
  stop()
})

test('E2E: Multi-Session Tabs, Monitor Trigger Wakeup & Quick Actions', async () => {
  const { ctx, tool, stop } = createTestEnvironment()
  const agentFollowupNotes = []
  const mockAgent = {
    id: 'agent-devops',
    followup: (msg) => agentFollowupNotes.push(msg),
  }
  const exec = { signal: new AbortController().signal, agent: mockAgent }
  const streamHub = ctx.interactiveShellStream

  // Spawn Session 1 (Dev Server in Monitor mode)
  const s1 = await tool.execute(
    { action: 'spawn', command: 'npm run dev', mode: 'monitor', trigger: 'ready on http' },
    exec,
  )

  // Spawn Session 2 (PostgreSQL CLI)
  const s2 = await tool.execute(
    { action: 'spawn', command: 'psql -U admin', mode: 'interactive' },
    exec,
  )

  const panel = new DshShellPanelController({ operatorName: 'bob' })
  const client1 = new TermStreamClient(s1.sessionId, { initialCommand: 'npm run dev', initialMode: 'monitor' })
  const client2 = new TermStreamClient(s2.sessionId, { initialCommand: 'psql -U admin', initialMode: 'interactive' })
  client1.connectHub(streamHub)
  client2.connectHub(streamHub)

  panel.addSession(client1)
  panel.addSession(client2)

  assert.equal(panel.getSessionStates().length, 2)
  assert.equal(panel.getActiveSessionId(), s1.sessionId)

  // Switch tab to session 2
  panel.selectSession(s2.sessionId)
  assert.equal(panel.getActiveSessionId(), s2.sessionId)

  // Render multi-tab HTML
  const multiHtml = renderShellPanelHtml(panel)
  assert.ok(multiHtml.includes('npm run dev'))
  assert.ok(multiHtml.includes('psql -U admin'))

  // Quick Action Ctrl+C on session 2
  let s2Inputs = []
  client2.onSendInput = (_id, input) => s2Inputs.push(input)
  panel.dispatchQuickAction('ctrl-c')
  assert.equal(s2Inputs[0], '\x03')

  // Clean up
  panel.dispose()
  client1.dispose()
  client2.dispose()
  stop()
})
