import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchCompleted,
  monitorBudgetExhausted,
  monitorCooldownElapsed,
  resolveMode,
  triggerMatches,
  truncateTail,
  underSessionBudget,
} from '../lib/pure.js'
import { TraceSink, DEFAULT_TRACE_PATH, defaultTracePath } from '../lib/trace.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

test('underSessionBudget: allows below the cap, denies at/above it', () => {
  assert.equal(underSessionBudget(0, 4), true)
  assert.equal(underSessionBudget(3, 4), true)
  assert.equal(underSessionBudget(4, 4), false)
  assert.equal(underSessionBudget(5, 4), false)
})

test('monitorCooldownElapsed: no prior event is immediately ready', () => {
  assert.equal(monitorCooldownElapsed(undefined, 1000, 2000), true)
})

test('monitorCooldownElapsed: respects the cooldown window', () => {
  assert.equal(monitorCooldownElapsed(1000, 2500, 2000), false)
  assert.equal(monitorCooldownElapsed(1000, 3000, 2000), true)
})

test('monitorBudgetExhausted: caps at the max', () => {
  assert.equal(monitorBudgetExhausted(99, 100), false)
  assert.equal(monitorBudgetExhausted(100, 100), true)
})

test('dispatchCompleted: exit completes immediately', () => {
  assert.equal(dispatchCompleted({
    exited: true,
    lastOutputAt: 0,
    quietMs: 5000,
    now: 1,
    timeoutMs: 600000,
    startedAt: 0,
  }), true)
})

test('dispatchCompleted: quiet window completes without exit', () => {
  assert.equal(dispatchCompleted({
    exited: false,
    lastOutputAt: 0,
    quietMs: 5000,
    now: 6000,
    timeoutMs: 600000,
    startedAt: 0,
  }), true)
})

test('dispatchCompleted: absolute timeout completes a chatty session', () => {
  assert.equal(dispatchCompleted({
    exited: false,
    lastOutputAt: 1000,
    quietMs: 5000,
    now: 5999,
    timeoutMs: 5000,
    startedAt: 0,
  }), true)
})

test('dispatchCompleted: quiet + timeout both pending keeps running', () => {
  assert.equal(dispatchCompleted({
    exited: false,
    lastOutputAt: 0,
    quietMs: 5000,
    now: 3000,
    timeoutMs: 600000,
    startedAt: 0,
  }), false)
})

test('truncateTail: short text passes through', () => {
  assert.equal(truncateTail('hello', 100), 'hello')
})

test('truncateTail: long text keeps head + omitted marker + tail', () => {
  const long = 'a'.repeat(1000)
  const result = truncateTail(long, 100)
  assert.ok(result.length < 1000)
  assert.match(result, /chars omitted/)
  assert.ok(result.startsWith('aaa'))
  assert.ok(result.endsWith('aaa'))
})

test('triggerMatches: regex match and miss', () => {
  assert.equal(triggerMatches('ERROR', 'line ERROR here'), true)
  assert.equal(triggerMatches('ERROR', 'all fine'), false)
})

test('triggerMatches: malformed regex fails closed', () => {
  assert.equal(triggerMatches('(', 'anything'), false)
})

test('resolveMode: explicit mode wins, default fills omission', () => {
  assert.equal(resolveMode('dispatch', 'monitor'), 'dispatch')
  assert.equal(resolveMode(undefined, 'monitor'), 'monitor')
})

test('TraceSink: creates with defaults and rotates file when exceeding maxBytes', () => {
  const defaultSink = TraceSink.create(undefined)
  assert.equal(defaultSink.path, DEFAULT_TRACE_PATH)
  assert.equal(defaultSink.failureCount, 0)

  // Test custom path with small maxBytes rotation
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-trace-test-'))
  const traceFile = join(tempDir, 'test-trace.jsonl')

  try {
    const sink = TraceSink.create(traceFile, 150)
    sink.record('event_1', { message: 'hello world 1' })
    sink.record('event_2', { message: 'hello world 2' })
    sink.record('event_3', { message: 'hello world 3' })

    const content = readFileSync(traceFile, 'utf8')
    assert.ok(content.includes('event_3'))
    assert.equal(sink.failureCount, 0)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('TraceSink: 默认台账路径落在 harness home（$DSH_HOME，未设置时 ~/.dsh）', () => {
  // 用 tmpdir 构造绝对路径：断言必须与运行平台无关（Windows / Linux / macOS）。
  const home = join(tmpdir(), 'dsh-home')
  assert.equal(
    defaultTracePath({ DSH_HOME: home }),
    join(home, 'interactive-shell', 'traces.jsonl'),
  )
  assert.equal(
    defaultTracePath({ DSH_HOME: '~' }),
    join(homedir(), 'interactive-shell', 'traces.jsonl'),
  )
  assert.equal(
    defaultTracePath({ DSH_HOME: '   ' }),
    join(homedir(), '.dsh', 'interactive-shell', 'traces.jsonl'),
    '空白 DSH_HOME 视为未设置，不得落到当前工作目录',
  )
  assert.equal(
    defaultTracePath({}),
    join(homedir(), '.dsh', 'interactive-shell', 'traces.jsonl'),
  )
  assert.equal(
    DEFAULT_TRACE_PATH,
    defaultTracePath(),
    '导出的常量与当前环境一致',
  )
  assert.equal(
    TraceSink.create(undefined).path,
    defaultTracePath(),
    '创建时按当前环境解析（可感知后续 DSH_HOME 变更）',
  )
})
