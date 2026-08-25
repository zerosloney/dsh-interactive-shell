/**
 * Native Custom Elements (Web Component) wrapper for dsh-interactive-shell.
 *
 * Provides a framework-agnostic `<dsh-shell-dock>` element with Shadow DOM
 * encapsulation, reactive attribute observation, and custom event dispatches.
 *
 * Isomorphic & SSR-safe: does not crash when imported in Node.js / headless environments.
 *
 * @module
 */

import { DshShellPanelController, renderShellPanelCss, renderShellPanelHtml } from './ui.js'
import type { ThemeKind } from './ui.js'

/** Universal base class for SSR / Node.js headless compatibility. */
const BaseElement: typeof HTMLElement = typeof HTMLElement !== 'undefined'
  ? HTMLElement
  : (class DummyElement {} as unknown as typeof HTMLElement)

/**
 * Standard Web Component for the interactive shell floating dock.
 */
export class DshShellDockElement extends BaseElement {
  static get observedAttributes(): string[] {
    return ['theme', 'open']
  }

  private root?: ShadowRoot
  private controller: DshShellPanelController
  private unsubscribe?: () => void

  constructor() {
    super()
    if (typeof this.attachShadow === 'function') {
      this.root = this.attachShadow({ mode: 'open' })
    }
    const initialTheme = (typeof this.getAttribute === 'function' ? this.getAttribute('theme') as ThemeKind : null) || 'dark'
    this.controller = new DshShellPanelController({ theme: initialTheme })
  }

  /** Expose underlying panel controller for advanced programmatic control. */
  get panelController(): DshShellPanelController {
    return this.controller
  }

  connectedCallback(): void {
    // Initial render
    this.render()

    // Subscribe to state changes from controller
    this.unsubscribe = this.controller.subscribe(() => {
      this.render()
    })

    // Bind event delegation for Shadow DOM button clicks
    this.root?.addEventListener('click', this.handleClick)
  }

  disconnectedCallback(): void {
    this.unsubscribe?.()
    this.root?.removeEventListener('click', this.handleClick)
    this.controller.dispose()
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue === newValue) return
    if (name === 'theme' && (newValue === 'dark' || newValue === 'light')) {
      this.controller.setTheme(newValue)
    } else if (name === 'open') {
      this.controller.setOpen(newValue !== 'false')
    }
  }

  /** Render styles and HTML into Shadow Root. */
  render(): void {
    if (!this.root) return
    const css = renderShellPanelCss()
    const html = renderShellPanelHtml(this.controller)
    this.root.innerHTML = `<style>${css}</style>${html}`
  }

  private handleClick = (e: Event): void => {
    const target = (e.target as HTMLElement)?.closest?.('[data-action], [data-tab]') as HTMLElement | null
    if (!target) return

    const action = target.getAttribute('data-action')
    const tabSessionId = target.getAttribute('data-tab-id') || target.getAttribute('data-tab')
    const activeId = this.controller.getActiveSessionId()

    if (tabSessionId) {
      this.controller.selectSession(tabSessionId)
      return
    }

    if (!action) return

    if (action === 'toggle-dock' || action === 'toggle-open') {
      this.controller.setOpen(!this.controller.isOpen())
    } else if (action === 'toggle-theme') {
      const nextTheme = this.controller.toggleTheme()
      if (typeof this.dispatchEvent === 'function') {
        this.dispatchEvent(new CustomEvent('dsh:theme-change', {
          detail: { theme: nextTheme },
          bubbles: true,
          composed: true,
        }))
      }
    } else if (action === 'toggle-takeover' && activeId) {
      const isTakenOver = this.controller.toggleTakeover(activeId)
      if (typeof this.dispatchEvent === 'function') {
        this.dispatchEvent(new CustomEvent('dsh:takeover', {
          detail: { sessionId: activeId, takeover: isTakenOver },
          bubbles: true,
          composed: true,
        }))
      }
    } else if (['ctrl-c', 'ctrl-d', 'enter', 'clear', 'kill'].includes(action) && activeId) {
      this.controller.dispatchQuickAction(action as any, activeId)
      if (typeof this.dispatchEvent === 'function') {
        this.dispatchEvent(new CustomEvent('dsh:action', {
          detail: { sessionId: activeId, action },
          bubbles: true,
          composed: true,
        }))
      }
    }
  }
}

/**
 * Register the <dsh-shell-dock> Custom Element globally if in browser environment.
 */
export function defineDshShellComponent(tagName = 'dsh-shell-dock'): void {
  if (typeof customElements !== 'undefined' && typeof customElements.define === 'function' && !customElements.get(tagName)) {
    customElements.define(tagName, DshShellDockElement)
  }
}
