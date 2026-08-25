import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DshShellDockElement,
  defineDshShellComponent,
  TermStreamClient,
} from '../lib/index.js'

test('DshShellDockElement: observedAttributes and basic construction', () => {
  assert.deepEqual(DshShellDockElement.observedAttributes, ['theme', 'open'])

  const el = new DshShellDockElement()
  assert.ok(el.panelController)
  assert.equal(el.panelController.getTheme(), 'dark')
})

test('DshShellDockElement: attributeChangedCallback updates controller state', () => {
  const el = new DshShellDockElement()

  // No-op when old === new
  el.attributeChangedCallback('theme', 'dark', 'dark')
  assert.equal(el.panelController.getTheme(), 'dark')

  // Theme change
  el.attributeChangedCallback('theme', 'dark', 'light')
  assert.equal(el.panelController.getTheme(), 'light')

  // Open change
  el.attributeChangedCallback('open', 'true', 'false')
  assert.equal(el.panelController.isOpen(), false)

  el.attributeChangedCallback('open', 'false', 'true')
  assert.equal(el.panelController.isOpen(), true)
})

test('DshShellDockElement: lifecycle and Shadow DOM event delegation', () => {
  const el = new DshShellDockElement()

  // Setup mock ShadowRoot & event emitter
  const dispatchedEvents = []
  const mockShadowRoot = {
    innerHTML: '',
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn
    },
    removeEventListener(type) {
      delete this.listeners[type]
    },
  }

  // Inject mock properties
  el.root = mockShadowRoot
  el.dispatchEvent = (event) => {
    dispatchedEvents.push(event)
    return true
  }

  // Lifecycle: connectedCallback
  el.connectedCallback()
  assert.ok(mockShadowRoot.innerHTML.includes('dsh-shell-dock'))
  assert.ok(typeof mockShadowRoot.listeners.click === 'function')

  const clickHandler = mockShadowRoot.listeners.click

  // 1. Click without action (noop)
  clickHandler({
    target: {
      closest: () => null,
    },
  })

  // 2. Click toggle-dock
  clickHandler({
    target: {
      closest: () => ({
        getAttribute: (attr) => attr === 'data-action' ? 'toggle-dock' : null,
      }),
    },
  })
  assert.equal(el.panelController.isOpen(), false)

  // 3. Click toggle-theme
  clickHandler({
    target: {
      closest: () => ({
        getAttribute: (attr) => attr === 'data-action' ? 'toggle-theme' : null,
      }),
    },
  })
  assert.equal(el.panelController.getTheme(), 'light')
  assert.equal(dispatchedEvents.length, 1)
  assert.equal(dispatchedEvents[0].type, 'dsh:theme-change')
  assert.equal(dispatchedEvents[0].detail.theme, 'light')

  // Add mock active sessions
  const client1 = new TermStreamClient('sess_1')
  const client2 = new TermStreamClient('sess_2')
  el.panelController.addSession(client1)
  el.panelController.addSession(client2)

  // 4. Click tab to switch session
  clickHandler({
    target: {
      closest: () => ({
        getAttribute: (attr) => attr === 'data-tab' ? 'sess_2' : null,
      }),
    },
  })
  assert.equal(el.panelController.getActiveSessionId(), 'sess_2')

  // 5. Click toggle-takeover
  clickHandler({
    target: {
      closest: () => ({
        getAttribute: (attr) => attr === 'data-action' ? 'toggle-takeover' : null,
      }),
    },
  })
  assert.equal(dispatchedEvents.length, 2)
  assert.equal(dispatchedEvents[1].type, 'dsh:takeover')
  assert.equal(dispatchedEvents[1].detail.sessionId, 'sess_2')
  assert.equal(dispatchedEvents[1].detail.takeover, true)

  // 6. Click quick action (ctrl-c)
  clickHandler({
    target: {
      closest: () => ({
        getAttribute: (attr) => attr === 'data-action' ? 'ctrl-c' : null,
      }),
    },
  })
  assert.equal(dispatchedEvents.length, 3)
  assert.equal(dispatchedEvents[2].type, 'dsh:action')
  assert.equal(dispatchedEvents[2].detail.action, 'ctrl-c')

  // Lifecycle: disconnectedCallback
  el.disconnectedCallback()
  assert.equal(mockShadowRoot.listeners.click, undefined)
})

test('defineDshShellComponent: registers with customElements in browser environment', () => {
  let registeredName = ''
  let registeredClass = null

  // Mock global customElements
  globalThis.customElements = {
    get: (name) => (name === registeredName ? registeredClass : undefined),
    define: (name, cls) => {
      registeredName = name
      registeredClass = cls
    },
  }

  try {
    defineDshShellComponent('test-shell-dock')
    assert.equal(registeredName, 'test-shell-dock')
    assert.equal(registeredClass, DshShellDockElement)
  } finally {
    delete globalThis.customElements
  }
})
