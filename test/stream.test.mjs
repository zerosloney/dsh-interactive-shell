import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamHub } from '../lib/stream.js'

test('StreamHub: broadcast notifies global listeners', () => {
  const hub = new StreamHub()
  const received = []
  const unsubscribe = hub.subscribeAll((frame) => received.push(frame))

  hub.broadcast({
    type: 'term:init',
    sessionId: 's1',
    command: 'top',
    mode: 'interactive',
    time: 1000,
  })

  assert.equal(received.length, 1)
  assert.equal(received[0].type, 'term:init')
  assert.equal(received[0].sessionId, 's1')

  unsubscribe()
  hub.broadcast({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'output',
    lineBegin: 0,
    lineEnd: 1,
    time: 1001,
  })
  assert.equal(received.length, 1, 'Unsubscribed listener should not receive further frames')
  hub.dispose()
})

test('StreamHub: session subscription receives matching frames and history replay', () => {
  const hub = new StreamHub({ maxHistoryFrames: 3 })
  hub.broadcast({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'chunk1\n',
    lineBegin: 0,
    lineEnd: 1,
    time: 1000,
  })
  hub.broadcast({
    type: 'term:output',
    sessionId: 's2',
    chunk: 'other session\n',
    lineBegin: 0,
    lineEnd: 1,
    time: 1001,
  })
  hub.broadcast({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'chunk2\n',
    lineBegin: 1,
    lineEnd: 2,
    time: 1002,
  })

  // Late-connecting subscriber for s1: should immediately replay 2 frames of s1 (not s2)
  const received = []
  const unsubscribe = hub.subscribe('s1', (frame) => received.push(frame))
  assert.equal(received.length, 2)
  assert.equal(received[0].chunk, 'chunk1\n')
  assert.equal(received[1].chunk, 'chunk2\n')

  // Live broadcast
  hub.broadcast({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'chunk3\n',
    lineBegin: 2,
    lineEnd: 3,
    time: 1003,
  })
  assert.equal(received.length, 3)
  assert.equal(received[2].chunk, 'chunk3\n')

  unsubscribe()
  hub.dispose()
})

test('StreamHub: history ring buffer respects maxHistoryFrames', () => {
  const hub = new StreamHub({ maxHistoryFrames: 2 })
  hub.broadcast({ type: 'term:output', sessionId: 's1', chunk: '1', lineBegin: 0, lineEnd: 1, time: 1 })
  hub.broadcast({ type: 'term:output', sessionId: 's1', chunk: '2', lineBegin: 1, lineEnd: 2, time: 2 })
  hub.broadcast({ type: 'term:output', sessionId: 's1', chunk: '3', lineBegin: 2, lineEnd: 3, time: 3 })

  const history = hub.getHistory('s1')
  assert.equal(history.length, 2)
  assert.equal(history[0].chunk, '2')
  assert.equal(history[1].chunk, '3')
  hub.dispose()
})

test('StreamHub: takeover lock state management (acquireLock / releaseLock)', () => {
  const hub = new StreamHub()
  const lockFrames = []
  hub.subscribeAll((frame) => {
    if (frame.type === 'term:lock') lockFrames.push(frame)
  })

  assert.equal(hub.getLockState('s1').state, 'agent_driving')

  // Acquire lock
  const acquired = hub.acquireLock('s1', 'alice')
  assert.equal(acquired, true)
  assert.equal(hub.getLockState('s1').state, 'user_takeover')
  assert.equal(hub.getLockState('s1').lockedBy, 'alice')
  assert.equal(lockFrames.length, 1)

  // Re-acquiring already held lock returns false
  assert.equal(hub.acquireLock('s1', 'bob'), false)

  // Release lock
  const released = hub.releaseLock('s1')
  assert.equal(released, true)
  assert.equal(hub.getLockState('s1').state, 'agent_driving')
  assert.equal(hub.getLockState('s1').lockedBy, undefined)
  assert.equal(lockFrames.length, 2)

  // Re-releasing idle lock returns false
  assert.equal(hub.releaseLock('s1'), false)
  hub.dispose()
})

test('StreamHub: cleanup removes history and session listeners', () => {
  const hub = new StreamHub()
  hub.broadcast({ type: 'term:output', sessionId: 's1', chunk: 'data', lineBegin: 0, lineEnd: 1, time: 1 })
  assert.equal(hub.getHistory('s1').length, 1)

  hub.cleanup('s1')
  assert.equal(hub.getHistory('s1').length, 0)
  assert.equal(hub.getLockState('s1').state, 'agent_driving')
  hub.dispose()
})

test('StreamHub: handles failing listener gracefully without disrupting other listeners', () => {
  const hub = new StreamHub()
  const okReceived = []

  hub.subscribeAll(() => {
    throw new Error('boom subscriber')
  })
  hub.subscribeAll((f) => okReceived.push(f))

  assert.doesNotThrow(() => {
    hub.broadcast({
      type: 'term:init',
      sessionId: 's1',
      command: 'ls',
      mode: 'interactive',
      time: 1,
    })
  })
  assert.equal(okReceived.length, 1)
  hub.dispose()
})
