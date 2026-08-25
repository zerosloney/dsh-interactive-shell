import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StreamHub } from '../lib/stream.js'
import { TermStreamClient } from '../lib/client.js'
import {
  DshShellPanelController,
  renderShellPanelCss,
  renderShellPanelHtml,
} from '../lib/ui.js'

test('DshShellPanelController: manages open state and active tabs', () => {
  const panel = new DshShellPanelController({ initialOpen: true, operatorName: 'alice' })
  assert.equal(panel.isOpen(), true)
  assert.equal(panel.getActiveSessionId(), null)
  assert.equal(panel.getSessionStates().length, 0)

  // Toggle open
  assert.equal(panel.toggleOpen(), false)
  assert.equal(panel.isOpen(), false)
  panel.setOpen(true)
  assert.equal(panel.isOpen(), true)

  const hub = new StreamHub()
  const client1 = new TermStreamClient('s1', { initialCommand: 'vim file.txt', initialMode: 'interactive' })
  client1.connectHub(hub)

  const client2 = new TermStreamClient('s2', { initialCommand: 'npm run dev', initialMode: 'monitor' })
  client2.connectHub(hub)

  // Add session 1
  let updates = 0
  const unsub = panel.subscribe(() => {
    updates++
  })

  panel.addSession(client1)
  assert.equal(panel.getActiveSessionId(), 's1')
  assert.equal(panel.getSessionStates().length, 1)
  assert.ok(updates > 0)

  // Add session 2
  panel.addSession(client2)
  assert.equal(panel.getActiveSessionId(), 's1') // Remains s1
  assert.equal(panel.getSessionStates().length, 2)

  // Select session 2
  assert.equal(panel.selectSession('s2'), true)
  assert.equal(panel.getActiveSessionId(), 's2')
  assert.equal(panel.getActiveClient()?.sessionId, 's2')

  // Select non-existent session
  assert.equal(panel.selectSession('s_unknown'), false)

  // Remove active session s2 -> fallbacks to s1
  panel.removeSession('s2')
  assert.equal(panel.getActiveSessionId(), 's1')
  assert.equal(panel.getSessionStates().length, 1)

  // Remove s1 -> active becomes null
  panel.removeSession('s1')
  assert.equal(panel.getActiveSessionId(), null)
  assert.equal(panel.getSessionStates().length, 0)

  unsub()
  panel.dispose()
  hub.dispose()
})

test('DshShellPanelController: toggleTakeover and quick actions dispatch', () => {
  const hub = new StreamHub()
  const client = new TermStreamClient('s1', { initialCommand: 'psql' })
  client.connectHub(hub)

  const quickActions = []
  const panel = new DshShellPanelController({
    operatorName: 'developer-dave',
    onQuickAction: (sessionId, action) => quickActions.push({ sessionId, action }),
  })
  panel.addSession(client)

  // Direct takeover toggle: agent_driving -> user_takeover
  const locked = panel.toggleTakeover()
  assert.equal(locked, true)
  assert.equal(client.getState().lockState, 'user_takeover')
  assert.equal(client.getState().lockedBy, 'developer-dave')

  // Toggle again: user_takeover -> agent_driving
  const unlocked = panel.toggleTakeover()
  assert.equal(unlocked, false)
  assert.equal(client.getState().lockState, 'agent_driving')

  // Quick actions: ctrl-c, ctrl-d, enter, clear, kill
  const sentInputs = []
  client.onSendInput = (_sessionId, input) => sentInputs.push(input)

  panel.dispatchQuickAction('ctrl-c')
  assert.equal(sentInputs[0], '\x03')

  panel.dispatchQuickAction('ctrl-d')
  assert.equal(sentInputs[1], '\x04')

  panel.dispatchQuickAction('enter')
  assert.equal(sentInputs[2], '\r')

  client.getBuffer().write('hello world\n')
  assert.equal(client.getBuffer().getLines().length, 1)
  panel.dispatchQuickAction('clear')
  assert.equal(client.getBuffer().getLines().length, 0)

  panel.dispatchQuickAction('kill')
  const killAction = quickActions.find((a) => a.action === 'kill')
  assert.ok(killAction)
  assert.equal(killAction.sessionId, 's1')

  panel.dispose()
  hub.dispose()
})

test('renderShellPanelCss: produces CSS rules for overlay dock and badges', () => {
  const css = renderShellPanelCss()
  assert.ok(css.includes('.dsh-shell-dock'))
  assert.ok(css.includes('.dsh-badge-running'))
  assert.ok(css.includes('.dsh-badge-takeover'))
  assert.ok(css.includes('.dsh-btn-takeover'))
  assert.ok(css.includes('.dsh-btn-release'))
})

test('renderShellPanelHtml: renders empty and active states with takeover buttons', () => {
  const panel = new DshShellPanelController({ operatorName: 'alice' })

  // 1. Empty state
  const emptyHtml = renderShellPanelHtml(panel)
  assert.ok(emptyHtml.includes('No active interactive shell sessions'))
  assert.ok(emptyHtml.includes('dsh-badge-exited'))

  // 2. Active running session
  const hub = new StreamHub()
  const client = new TermStreamClient('s1', { initialCommand: 'python server.py', initialMode: 'interactive' })
  client.connectHub(hub)
  panel.addSession(client)

  hub.broadcast({
    type: 'term:output',
    sessionId: 's1',
    chunk: 'Listening on http://localhost:8000\n',
    lineBegin: 0,
    lineEnd: 1,
    time: Date.now(),
  })

  const runningHtml = renderShellPanelHtml(panel)
  assert.ok(runningHtml.includes('python server.py'))
  assert.ok(runningHtml.includes('Listening on http://localhost:8000'))
  assert.ok(runningHtml.includes('dsh-btn-takeover'))
  assert.ok(runningHtml.includes('Take Over'))

  // 3. User Takeover state
  panel.toggleTakeover('s1')
  const takeoverHtml = renderShellPanelHtml(panel)
  assert.ok(takeoverHtml.includes('dsh-badge-takeover'))
  assert.ok(takeoverHtml.includes('takeover (alice)'))
  assert.ok(takeoverHtml.includes('dsh-btn-release'))
  assert.ok(takeoverHtml.includes('Hand Back to Agent'))

  // 4. Collapsed state
  panel.setOpen(false)
  const collapsedHtml = renderShellPanelHtml(panel)
  assert.ok(collapsedHtml.includes('is-collapsed'))

  panel.dispose()
  hub.dispose()
})
