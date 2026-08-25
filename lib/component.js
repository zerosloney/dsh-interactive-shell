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
import { DshShellPanelController, renderShellPanelCss, renderShellPanelHtml } from './ui.js';
/** Universal base class for SSR / Node.js headless compatibility. */
const BaseElement = typeof HTMLElement !== 'undefined'
    ? HTMLElement
    : class DummyElement {
    };
/**
 * Standard Web Component for the interactive shell floating dock.
 */
export class DshShellDockElement extends BaseElement {
    static get observedAttributes() {
        return ['theme', 'open'];
    }
    root;
    controller;
    unsubscribe;
    constructor() {
        super();
        if (typeof this.attachShadow === 'function') {
            this.root = this.attachShadow({ mode: 'open' });
        }
        const initialTheme = (typeof this.getAttribute === 'function' ? this.getAttribute('theme') : null) || 'dark';
        this.controller = new DshShellPanelController({ theme: initialTheme });
    }
    /** Expose underlying panel controller for advanced programmatic control. */
    get panelController() {
        return this.controller;
    }
    connectedCallback() {
        // Initial render
        this.render();
        // Subscribe to state changes from controller
        this.unsubscribe = this.controller.subscribe(() => {
            this.render();
        });
        // Bind event delegation for Shadow DOM button clicks
        this.root?.addEventListener('click', this.handleClick);
    }
    disconnectedCallback() {
        this.unsubscribe?.();
        this.root?.removeEventListener('click', this.handleClick);
        this.controller.dispose();
    }
    attributeChangedCallback(name, oldValue, newValue) {
        if (oldValue === newValue)
            return;
        if (name === 'theme' && (newValue === 'dark' || newValue === 'light')) {
            this.controller.setTheme(newValue);
        }
        else if (name === 'open') {
            this.controller.setOpen(newValue !== 'false');
        }
    }
    /** Render styles and HTML into Shadow Root. */
    render() {
        if (!this.root)
            return;
        const css = renderShellPanelCss();
        const html = renderShellPanelHtml(this.controller);
        this.root.innerHTML = `<style>${css}</style>${html}`;
    }
    handleClick = (e) => {
        const target = e.target?.closest?.('[data-action], [data-tab]');
        if (!target)
            return;
        const action = target.getAttribute('data-action');
        const tabSessionId = target.getAttribute('data-tab-id') || target.getAttribute('data-tab');
        const activeId = this.controller.getActiveSessionId();
        if (tabSessionId) {
            this.controller.selectSession(tabSessionId);
            return;
        }
        if (!action)
            return;
        if (action === 'toggle-dock' || action === 'toggle-open') {
            this.controller.setOpen(!this.controller.isOpen());
        }
        else if (action === 'toggle-theme') {
            const nextTheme = this.controller.toggleTheme();
            if (typeof this.dispatchEvent === 'function') {
                this.dispatchEvent(new CustomEvent('dsh:theme-change', {
                    detail: { theme: nextTheme },
                    bubbles: true,
                    composed: true,
                }));
            }
        }
        else if (action === 'toggle-takeover' && activeId) {
            const isTakenOver = this.controller.toggleTakeover(activeId);
            if (typeof this.dispatchEvent === 'function') {
                this.dispatchEvent(new CustomEvent('dsh:takeover', {
                    detail: { sessionId: activeId, takeover: isTakenOver },
                    bubbles: true,
                    composed: true,
                }));
            }
        }
        else if (['ctrl-c', 'ctrl-d', 'enter', 'clear', 'kill'].includes(action) && activeId) {
            this.controller.dispatchQuickAction(action, activeId);
            if (typeof this.dispatchEvent === 'function') {
                this.dispatchEvent(new CustomEvent('dsh:action', {
                    detail: { sessionId: activeId, action },
                    bubbles: true,
                    composed: true,
                }));
            }
        }
    };
}
/**
 * Register the <dsh-shell-dock> Custom Element globally if in browser environment.
 */
export function defineDshShellComponent(tagName = 'dsh-shell-dock') {
    if (typeof customElements !== 'undefined' && typeof customElements.define === 'function' && !customElements.get(tagName)) {
        customElements.define(tagName, DshShellDockElement);
    }
}
//# sourceMappingURL=component.js.map