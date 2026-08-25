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
