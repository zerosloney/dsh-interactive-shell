import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  stripAnsi,
  VirtualTerminalBuffer,
  TermStreamClient,
} from '../lib/client.js'
import { StreamHub } from '../lib/stream.js'

test('stripAnsi: removes ANSI color and control escape codes', () => {
  const colored = '\u001b[31mError:\u001b[0m \u001b[32mSuccess\u001b[0m\r\n'
  assert.equal(stripAnsi(colored), 'Error: Success\r\n')
})

test('VirtualTerminalBuffer: tracks plain text lines and respects max scrollback', () => {
  const buf = new VirtualTerminalBuffer(3)
  buf.append('line 1\n')
  buf.append('line 2\n')
  buf.append('line 3\n')
  buf.append('line 4\n')

  const lines = buf.getLines()
  assert.equal(lines.length, 3)
  assert.equal(lines[0], 'line 2')
  assert.equal(lines[1], 'line 3')
  assert.equal(lines[2], 'line 4')
  assert.match(buf.getText(), /line 2\nline 3\nline 4/)

  buf.clear()
  assert.equal(buf.getLines().length, 0)
  assert.equal(buf.getText(), '')
})

test('TermStreamClient: initializes and transitions state through stream frames', () => {
  const client = new TermStreamClient('s1')
  assert.equal(client.getState().status, 'starting')

  // 1. term:init
  client.handleFrame({
    type: 'term:init',
    sessionId: 's1',
    command: 'npm run dev',
    mode: 'dispatch',
    motd: 'Welcome to PTY',
    time: 1000,
  })
  assert.equal(client.getState().status, 'running')
  assert.equal(client.getState().command, 'npm run dev')
  assert.equal(client.getState().mode, 'dispatch')
  assert.match(client.getBuffer().getText(), /Welcome to PTY/)

  // 2. term:output
  client.handleFrame({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'Vite ready in 200ms\n',
    lineBegin: 1,
    lineEnd: 2,
    time: 1010,
  })
  assert.equal(client.getState().totalLines, 2)
  assert.match(client.getBuffer().getText(), /Vite ready in 200ms/)

  // 3. term:lock
  client.handleFrame({
    type: 'term:lock',
    sessionId: 's1',
    state: 'user_takeover',
    lockedBy: 'developer',
    time: 1020,
  })
  assert.equal(client.getState().lockState, 'user_takeover')
  assert.equal(client.getState().lockedBy, 'developer')

  // 4. term:event (dispatch-completed)
  client.handleFrame({
    type: 'term:event',
    sessionId: 's1',
    event: 'dispatch-completed',
    payload: { exitCode: 0 },
    time: 1030,
  })
  assert.equal(client.getState().status, 'exited')
  assert.equal(client.getState().lastEvent, 'dispatch-completed')

  // 5. term:exit
  client.handleFrame({
    type: 'term:exit',
    sessionId: 's1',
    exitCode: 0,
    time: 1040,
  })
  assert.equal(client.getState().exitCode, 0)
  assert.equal(client.getState().status, 'exited')

  // Ignores frames for different sessionId
  client.handleFrame({
    type: 'term:output',
    sessionId: 'other-session',
    chunk: 'ignored\n',
    lineBegin: 0,
    lineEnd: 1,
    time: 1050,
  })
  assert.equal(client.getBuffer().getText().includes('ignored'), false)

  client.dispose()
})

test('TermStreamClient: attachRenderer replays history and receives live writes', () => {
  const client = new TermStreamClient('s1')
  client.handleFrame({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'Initial text\n',
    lineBegin: 0,
    lineEnd: 1,
    time: 1,
  })

  const written = []
  const mockRenderer = {
    write: (data) => written.push(data),
    dispose: () => {},
  }

  // Attach: should immediately replay 'Initial text\n'
  const detach = client.attachRenderer(mockRenderer)
  assert.equal(written.length, 1)
  assert.equal(written[0], 'Initial text\n')

  // Live frame write
  client.handleFrame({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'Second line\n',
    lineBegin: 1,
    lineEnd: 2,
    time: 2,
  })
  assert.equal(written.length, 2)
  assert.equal(written[1], 'Second line\n')

  detach()
  // After detach, no more writes received
  client.handleFrame({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'Third line\n',
    lineBegin: 2,
    lineEnd: 3,
    time: 3,
  })
  assert.equal(written.length, 2)

  client.dispose()
})

test('TermStreamClient: user takeover and input callbacks', () => {
  const sentInputs = []
  const lockRequests = []

  const client = new TermStreamClient('s1', {
    onSendInput: (id, text) => sentInputs.push({ id, text }),
    onLockRequest: (id, action, user) => lockRequests.push({ id, action, user }),
  })

  client.sendInput('ls -la\n')
  assert.equal(sentInputs.length, 1)
  assert.equal(sentInputs[0].id, 's1')
  assert.equal(sentInputs[0].text, 'ls -la\n')

  client.requestTakeover('alice')
  assert.equal(lockRequests.length, 1)
  assert.equal(lockRequests[0].action, 'acquire')
  assert.equal(lockRequests[0].user, 'alice')

  client.releaseTakeover()
  assert.equal(lockRequests.length, 2)
  assert.equal(lockRequests[1].action, 'release')

  client.dispose()
})

test('TermStreamClient: connectHub binds directly to StreamHub', () => {
  const hub = new StreamHub()
  const client = new TermStreamClient('s1')

  client.connectHub(hub)

  hub.broadcast({
    type: 'term:init',
    sessionId: 's1',
    command: 'htop',
    mode: 'interactive',
    time: 100,
  })
  hub.broadcast({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'CPU [|||||| 50%]\n',
    lineBegin: 0,
    lineEnd: 1,
    time: 101,
  })

  assert.equal(client.getState().command, 'htop')
  assert.match(client.getBuffer().getText(), /CPU \[\|\|\|\|\|\| 50%\]/)

  client.dispose()
  hub.dispose()
})
