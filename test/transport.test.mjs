import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  StreamHub,
  LocalStreamTransport,
  WsClientTransport,
  attachWsServerConnection,
  defineDshShellComponent,
} from '../lib/index.js'

test('LocalStreamTransport: forwards input and lock control to StreamHub and receives frames', () => {
  const inputs = []
  const hub = new StreamHub({
    onUserInput: (sId, data) => inputs.push({ sId, data }),
  })

  const transport = new LocalStreamTransport(hub)
  const receivedFrames = []
  const unsubscribe = transport.onFrame((frame) => receivedFrames.push(frame))

  // Send input through transport
  transport.send({ type: 'input', sessionId: 's_1', data: 'pwd\n' })
  assert.equal(inputs.length, 1)
  assert.deepEqual(inputs[0], { sId: 's_1', data: 'pwd\n' })

  // Lock acquisition through transport
  transport.send({ type: 'acquire_lock', sessionId: 's_1', lockedBy: 'alice' })
  assert.equal(hub.getLockState('s_1').state, 'user_takeover')
  assert.equal(hub.getLockState('s_1').lockedBy, 'alice')

  // Lock release through transport
  transport.send({ type: 'release_lock', sessionId: 's_1', summary: 'done editing' })
  assert.equal(hub.getLockState('s_1').state, 'agent_driving')

  // Broadcast frame from hub
  hub.broadcast({
    type: 'term:output',
    sessionId: 's_1',
    chunk: '/home/user\n',
    lineBegin: 0,
    lineEnd: 1,
    time: Date.now(),
  })

  assert.equal(receivedFrames.length, 3) // lock, unlock, output
  assert.equal(receivedFrames[2].type, 'term:output')

  unsubscribe()
  transport.close()
  hub.dispose()
})

test('attachWsServerConnection: bridges WebSocket messages and Hub stream frames', () => {
  const inputs = []
  const hub = new StreamHub({
    onUserInput: (sId, data) => inputs.push({ sId, data }),
  })

  // Mock server-side WebSocket client socket
  const sentMessages = []
  let messageHandler = null
  let closeHandler = null

  const mockWs = {
    send: (data) => sentMessages.push(JSON.parse(data)),
    close: () => closeHandler?.(),
    on: (type, handler) => {
      if (type === 'message') messageHandler = handler
      if (type === 'close') closeHandler = handler
    },
  }

  const detach = attachWsServerConnection(mockWs, hub)

  // 1. Client sends ping -> receives pong
  messageHandler(JSON.stringify({ type: 'ping' }))
  assert.equal(sentMessages.length, 1)
  assert.deepEqual(sentMessages[0], { type: 'pong' })

  // 2. Client sends user input
  messageHandler(JSON.stringify({ type: 'input', sessionId: 'ws_s1', data: 'echo test\n' }))
  assert.equal(inputs.length, 1)
  assert.deepEqual(inputs[0], { sId: 'ws_s1', data: 'echo test\n' })

  // 3. Client acquires lock
  messageHandler(JSON.stringify({ type: 'acquire_lock', sessionId: 'ws_s1', lockedBy: 'bob' }))
  assert.equal(hub.getLockState('ws_s1').state, 'user_takeover')

  // 4. Hub emits output -> WS receives serialized frame
  hub.broadcast({
    type: 'term:output',
    sessionId: 'ws_s1',
    chunk: 'test output\n',
    lineBegin: 0,
    lineEnd: 1,
    time: 12345,
  })

  assert.ok(sentMessages.some((m) => m.type === 'frame' && m.frame.type === 'term:output'))

  // 5. Malformed message handling
  messageHandler('invalid json payload {{{')
  assert.ok(sentMessages.some((m) => m.type === 'error'))

  detach()
  hub.dispose()
})

test('WsClientTransport: connects, queues messages prior to open, and forwards frames', () => {
  const sentData = []
  let openHandler = null
  let messageHandler = null
  let closeHandler = null

  const mockClientSocket = {
    send: (data) => sentData.push(JSON.parse(data)),
    close: () => closeHandler?.(),
    addEventListener: (type, handler) => {
      if (type === 'open') openHandler = handler
      if (type === 'message') messageHandler = handler
      if (type === 'close') closeHandler = handler
    },
  }

  const transport = new WsClientTransport({
    sessionId: 'session_123',
    webSocketFactory: () => mockClientSocket,
  })

  const receivedFrames = []
  const unsubscribe = transport.onFrame((frame) => receivedFrames.push(frame))

  // 1. Send before open -> queued
  transport.send({ type: 'input', sessionId: 'session_123', data: 'ls -la\n' })
  assert.equal(sentData.length, 0)

  // 2. Open connection -> automatically subscribes and flushes queue
  transport.connect('ws://localhost:9999/stream')
  openHandler()
  assert.equal(sentData.length, 2)
  assert.deepEqual(sentData[0], { type: 'subscribe', sessionId: 'session_123' })
  assert.deepEqual(sentData[1], { type: 'input', sessionId: 'session_123', data: 'ls -la\n' })

  // 3. Receive incoming server frame
  messageHandler({
    data: JSON.stringify({
      type: 'frame',
      frame: {
        type: 'term:output',
        sessionId: 'session_123',
        chunk: 'total 0\n',
        lineBegin: 0,
        lineEnd: 1,
        time: 1000,
      },
    }),
  })
  assert.equal(receivedFrames.length, 1)
  assert.equal(receivedFrames[0].type, 'term:output')

  unsubscribe()
  transport.close()
})

test('LocalStreamTransport: session filtering only receives frames for bound sessionId', () => {
  const hub = new StreamHub()
  const transport = new LocalStreamTransport(hub, 'only_session_1')
  const received = []
  transport.onFrame((f) => received.push(f))

  hub.broadcast({
    type: 'term:output',
    sessionId: 'other_session',
    chunk: 'ignore me\n',
    lineBegin: 0,
    lineEnd: 1,
    time: 100,
  })

  hub.broadcast({
    type: 'term:output',
    sessionId: 'only_session_1',
    chunk: 'accept me\n',
    lineBegin: 0,
    lineEnd: 1,
    time: 101,
  })

  assert.equal(received.length, 1)
  assert.equal(received[0].chunk, 'accept me\n')

  transport.close()
  hub.dispose()
})

test('attachWsServerConnection & WsClientTransport: EventEmitter / DOM compatibility', () => {
  const hub = new StreamHub()
  const serverSent = []
  let serverMessageHandler = null
  let serverCloseHandler = null

  // DOM EventListener style for attachWsServerConnection
  const mockDomServerWs = {
    send: (d) => serverSent.push(JSON.parse(d)),
    close: () => serverCloseHandler?.(),
    addEventListener: (type, handler) => {
      if (type === 'message') serverMessageHandler = handler
      if (type === 'close') serverCloseHandler = handler
    },
  }

  const detach = attachWsServerConnection(mockDomServerWs, hub)
  serverMessageHandler({ data: JSON.stringify({ type: 'ping' }) })
  assert.equal(serverSent.length, 1)
  assert.deepEqual(serverSent[0], { type: 'pong' })

  // EventEmitter style for WsClientTransport
  const clientSent = []
  let clientOpenHandler = null
  let clientMessageHandler = null

  const mockEmitterClientWs = {
    send: (d) => clientSent.push(JSON.parse(d)),
    close: () => {},
    on: (type, handler) => {
      if (type === 'open') clientOpenHandler = handler
      if (type === 'message') clientMessageHandler = handler
    },
  }

  const clientTransport = new WsClientTransport({
    url: 'ws://localhost:8080',
    webSocketFactory: () => mockEmitterClientWs,
  })

  const clientReceived = []
  clientTransport.onFrame((f) => clientReceived.push(f))

  clientOpenHandler()
  clientTransport.send({ type: 'ping' })
  assert.equal(clientSent.length, 1)

  clientMessageHandler(JSON.stringify({
    type: 'frame',
    frame: {
      type: 'term:output',
      sessionId: 'ws_emitter_s1',
      chunk: 'emitter stream data\n',
      lineBegin: 0,
      lineEnd: 1,
      time: 500,
    },
  }))
  assert.equal(clientReceived.length, 1)
  assert.equal(clientReceived[0].chunk, 'emitter stream data\n')

  detach()
  clientTransport.close()
  hub.dispose()
})

test('defineDshShellComponent: can be safely invoked in headless / node environment', () => {
  // In Node.js without browser DOM globals, defineDshShellComponent executes cleanly without error
  assert.doesNotThrow(() => {
    defineDshShellComponent('dsh-shell-dock')
  })
})
