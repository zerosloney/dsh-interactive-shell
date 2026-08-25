import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionRecorder } from '../lib/index.js'

test('SessionRecorder: records frames and exports valid Asciinema v2 (.cast) file', () => {
  const recorder = new SessionRecorder()
  const baseTime = 1700000000000

  recorder.record({
    type: 'term:init',
    sessionId: 'sess_rec_1',
    command: 'htop',
    mode: 'interactive',
    motd: 'Welcome',
    time: baseTime,
  })

  recorder.record({
    type: 'term:output',
    sessionId: 'sess_rec_1',
    chunk: 'CPU: [|||     ] 30%\n',
    lineBegin: 0,
    lineEnd: 1,
    time: baseTime + 500,
  })

  recorder.record({
    type: 'term:output',
    sessionId: 'sess_rec_1',
    chunk: 'MEM: [||||||  ] 60%\n',
    lineBegin: 1,
    lineEnd: 2,
    time: baseTime + 1200,
  })

  recorder.record({
    type: 'term:exit',
    sessionId: 'sess_rec_1',
    exitCode: 0,
    time: baseTime + 2000,
  })

  const castOutput = recorder.exportAsciinema('sess_rec_1', { width: 100, height: 30, title: 'Htop Demo' })
  const lines = castOutput.trim().split('\n')

  assert.equal(lines.length, 3) // header + 2 output events

  // Check header
  const header = JSON.parse(lines[0])
  assert.equal(header.version, 2)
  assert.equal(header.width, 100)
  assert.equal(header.height, 30)
  assert.equal(header.title, 'Htop Demo')

  // Check event lines
  const ev1 = JSON.parse(lines[1])
  assert.equal(ev1[0], 0.5)
  assert.equal(ev1[1], 'o')
  assert.equal(ev1[2], 'CPU: [|||     ] 30%\n')

  const ev2 = JSON.parse(lines[2])
  assert.equal(ev2[0], 1.2)
  assert.equal(ev2[1], 'o')
  assert.equal(ev2[2], 'MEM: [||||||  ] 60%\n')
})

test('SessionRecorder: calculates timeline attribution between Agent and Human takeover', () => {
  const recorder = new SessionRecorder()
  const t0 = 1000

  // 1. Agent runs initial command
  recorder.record({
    type: 'term:output',
    sessionId: 'collab_1',
    chunk: 'agent step 1\n',
    lineBegin: 0,
    lineEnd: 1,
    time: t0 + 100,
  })

  // 2. User takes over
  recorder.record({
    type: 'term:lock',
    sessionId: 'collab_1',
    state: 'user_takeover',
    lockedBy: 'developer',
    time: t0 + 200,
  })

  recorder.record({
    type: 'term:output',
    sessionId: 'collab_1',
    chunk: 'user manual fix\n',
    lineBegin: 1,
    lineEnd: 2,
    time: t0 + 300,
  })

  // 3. User releases back to agent
  recorder.record({
    type: 'term:lock',
    sessionId: 'collab_1',
    state: 'agent_driving',
    time: t0 + 400,
  })

  recorder.record({
    type: 'term:output',
    sessionId: 'collab_1',
    chunk: 'agent resume\n',
    lineBegin: 2,
    lineEnd: 3,
    time: t0 + 500,
  })

  const segments = recorder.getTimelineAttribution('collab_1')
  assert.equal(segments.length, 3)

  assert.equal(segments[0].actor, 'agent')
  assert.equal(segments[0].totalBytes, 'agent step 1\n'.length)

  assert.equal(segments[1].actor, 'user')
  assert.equal(segments[1].totalBytes, 'user manual fix\n'.length)

  assert.equal(segments[2].actor, 'agent')
  assert.equal(segments[2].totalBytes, 'agent resume\n'.length)
})

test('SessionRecorder: reconstructs Time-Travel snapshot at arbitrary timestamps', () => {
  const recorder = new SessionRecorder()
  const t0 = 5000

  recorder.record({
    type: 'term:output',
    sessionId: 'tt_1',
    chunk: 'Line 1: Initial\n',
    lineBegin: 0,
    lineEnd: 1,
    time: t0 + 100,
  })

  recorder.record({
    type: 'term:output',
    sessionId: 'tt_1',
    chunk: 'Line 2: Midpoint\n',
    lineBegin: 1,
    lineEnd: 2,
    time: t0 + 300,
  })

  recorder.record({
    type: 'term:output',
    sessionId: 'tt_1',
    chunk: 'Line 3: Final\n',
    lineBegin: 2,
    lineEnd: 3,
    time: t0 + 500,
  })

  // Snapshot before Line 2
  const snap1 = recorder.getTimeTravelSnapshot('tt_1', t0 + 200)
  assert.deepEqual(snap1, ['Line 1: Initial'])

  // Snapshot after Line 2 but before Line 3
  const snap2 = recorder.getTimeTravelSnapshot('tt_1', t0 + 400)
  assert.deepEqual(snap2, ['Line 1: Initial', 'Line 2: Midpoint'])

  // Snapshot after Line 3
  const snap3 = recorder.getTimeTravelSnapshot('tt_1', t0 + 600)
  assert.deepEqual(snap3, ['Line 1: Initial', 'Line 2: Midpoint', 'Line 3: Final'])

  // Unknown session snapshot returns empty array
  assert.deepEqual(recorder.getTimeTravelSnapshot('unknown', t0), [])
})

test('SessionRecorder: getSession, clear, and non-existent session error handling', () => {
  const recorder = new SessionRecorder()
  recorder.record({
    type: 'term:init',
    sessionId: 'sess_test_clear',
    command: 'top',
    mode: 'interactive',
    time: 1000,
  })

  assert.ok(recorder.getSession('sess_test_clear'))
  assert.equal(recorder.getSession('sess_test_clear').command, 'top')

  // Unknown export throws clear error
  assert.throws(() => {
    recorder.exportAsciinema('non_existent')
  }, /not found/)

  // Timeline attribution for non-existent returns empty array
  assert.deepEqual(recorder.getTimelineAttribution('non_existent'), [])

  // Clear single session
  recorder.clear('sess_test_clear')
  assert.equal(recorder.getSession('sess_test_clear'), undefined)

  // Clear all
  recorder.record({ type: 'term:init', sessionId: 's1', time: 1000 })
  recorder.record({ type: 'term:init', sessionId: 's2', time: 1000 })
  recorder.clear()
  assert.equal(recorder.getSession('s1'), undefined)
  assert.equal(recorder.getSession('s2'), undefined)
})
