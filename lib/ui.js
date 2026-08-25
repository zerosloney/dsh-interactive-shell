/**
 * Web UI Overlay Panel & Interaction Controller for dsh-interactive-shell:
 * Provides multi-tab terminal session switching, takeover action bar,
 * quick action dispatchers (Ctrl+C, Ctrl+D, clear), and responsive panel rendering.
 *
 * @module
 */
/**
 * State & Interaction Controller for the DSH Shell Web UI Overlay Panel.
 */
export class DshShellPanelController {
    clients = new Map();
    clientDisposers = new Map();
    changeListeners = new Set();
    activeId = null;
    open;
    operator;
    onQuickAction;
    constructor(options = {}) {
        this.open = options.initialOpen ?? true;
        this.operator = options.operatorName ?? 'user';
        this.onQuickAction = options.onQuickAction;
    }
    /** Whether the floating overlay panel is currently visible/expanded. */
    isOpen() {
        return this.open;
    }
    /** Set or toggle overlay panel visibility. */
    setOpen(open) {
        if (this.open === open)
            return;
        this.open = open;
        this.notify();
    }
    /** Toggle open state. */
    toggleOpen() {
        this.setOpen(!this.open);
        return this.open;
    }
    /** Get active session ID. */
    getActiveSessionId() {
        return this.activeId;
    }
    /** Get active client instance. */
    getActiveClient() {
        return this.activeId !== null ? this.clients.get(this.activeId) : undefined;
    }
    /** Get list of all registered session states. */
    getSessionStates() {
        const states = [];
        for (const client of this.clients.values()) {
            states.push(client.getState());
        }
        return states;
    }
    /** Register a terminal session stream client into the panel. */
    addSession(client) {
        if (this.clients.has(client.sessionId))
            return;
        this.clients.set(client.sessionId, client);
        // Select if first session
        if (this.activeId === null) {
            this.activeId = client.sessionId;
        }
        const unState = client.onStateChange(() => this.notify());
        const unOut = client.onOutput(() => this.notify());
        this.clientDisposers.set(client.sessionId, () => {
            unState();
            unOut();
        });
        this.notify();
    }
    /** Remove a session from the panel. */
    removeSession(sessionId) {
        const client = this.clients.get(sessionId);
        if (client === undefined)
            return;
        const unsub = this.clientDisposers.get(sessionId);
        unsub?.();
        this.clientDisposers.delete(sessionId);
        this.clients.delete(sessionId);
        if (this.activeId === sessionId) {
            const remaining = Array.from(this.clients.keys());
            this.activeId = remaining.length > 0 ? remaining[0] : null;
        }
        this.notify();
    }
    /** Switch active tab session. */
    selectSession(sessionId) {
        if (!this.clients.has(sessionId))
            return false;
        if (this.activeId === sessionId)
            return true;
        this.activeId = sessionId;
        this.notify();
        return true;
    }
    /**
     * Toggle user takeover for the active (or specified) session.
     */
    toggleTakeover(sessionId, note) {
        const targetId = sessionId ?? this.activeId;
        if (targetId === null)
            return false;
        const client = this.clients.get(targetId);
        if (client === undefined)
            return false;
        const state = client.getState();
        if (state.lockState === 'agent_driving') {
            client.requestTakeover(this.operator);
            return true;
        }
        else {
            client.releaseTakeover(note);
            return false;
        }
    }
    /**
     * Dispatch a quick action (Ctrl+C, Ctrl+D, clear, enter, kill) to active session.
     */
    dispatchQuickAction(action, sessionId) {
        const targetId = sessionId ?? this.activeId;
        if (targetId === null)
            return;
        const client = this.clients.get(targetId);
        if (client === undefined)
            return;
        switch (action) {
            case 'ctrl-c':
                client.sendInput('\x03');
                break;
            case 'ctrl-d':
                client.sendInput('\x04');
                break;
            case 'enter':
                client.sendInput('\r');
                break;
            case 'clear':
                client.getBuffer().clear();
                this.notify();
                break;
            case 'kill':
                this.onQuickAction?.(targetId, 'kill');
                break;
        }
        this.onQuickAction?.(targetId, action);
    }
    /** Subscribe to UI state updates. */
    subscribe(listener) {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }
    notify() {
        for (const listener of this.changeListeners) {
            try {
                listener();
            }
            catch {
                // Safe dispatch
            }
        }
    }
    /** Dispose all resources. */
    dispose() {
        for (const unsub of this.clientDisposers.values()) {
            unsub();
        }
        this.clientDisposers.clear();
        this.clients.clear();
        this.changeListeners.clear();
    }
}
/**
 * Render responsive CSS styling for the DSH Interactive Shell Overlay.
 */
export function renderShellPanelCss() {
    return `
.dsh-shell-dock {
  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 680px;
  max-width: calc(100vw - 48px);
  height: 440px;
  max-height: calc(100vh - 48px);
  background: #18181b;
  color: #f4f4f5;
  border-radius: 12px;
  border: 1px solid #27272a;
  box-shadow: 0 20px 35px -10px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  z-index: 99999;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}
.dsh-shell-dock.is-collapsed {
  height: 42px;
}
.dsh-shell-header {
  height: 42px;
  padding: 0 14px;
  background: #202024;
  border-bottom: 1px solid #27272a;
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
}
.dsh-shell-title {
  font-size: 13px;
  font-weight: 600;
  color: #e4e4e7;
  display: flex;
  align-items: center;
  gap: 8px;
}
.dsh-shell-badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 500;
  text-transform: uppercase;
}
.dsh-badge-running { background: #064e3b; color: #34d399; }
.dsh-badge-takeover { background: #7c2d12; color: #fb923c; }
.dsh-badge-monitor { background: #581c87; color: #c084fc; }
.dsh-badge-exited { background: #3f3f46; color: #a1a1aa; }

.dsh-shell-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #141416;
  padding: 4px 8px;
  border-bottom: 1px solid #27272a;
  overflow-x: auto;
}
.dsh-shell-tab {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  background: transparent;
  color: #a1a1aa;
  cursor: pointer;
  border: 1px solid transparent;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh-shell-tab.is-active {
  background: #27272a;
  color: #fafafa;
  border-color: #3f3f46;
}
.dsh-shell-viewport {
  flex: 1;
  padding: 10px 14px;
  background: #09090b;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
}
.dsh-shell-actions {
  height: 44px;
  padding: 0 12px;
  background: #18181b;
  border-top: 1px solid #27272a;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-btn {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid #3f3f46;
  background: #27272a;
  color: #f4f4f5;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dsh-btn:hover {
  background: #3f3f46;
}
.dsh-btn-takeover {
  background: #ea580c;
  border-color: #f97316;
  color: #ffffff;
  font-weight: 600;
}
.dsh-btn-takeover:hover {
  background: #c2410c;
}
.dsh-btn-release {
  background: #059669;
  border-color: #10b981;
  color: #ffffff;
}
`;
}
/**
 * Render semantic HTML markup for the current state of DshShellPanelController.
 */
export function renderShellPanelHtml(controller) {
    const open = controller.isOpen();
    const states = controller.getSessionStates();
    const activeId = controller.getActiveSessionId();
    const activeClient = controller.getActiveClient();
    const activeState = activeClient?.getState();
    if (states.length === 0) {
        return `
<div class="dsh-shell-dock ${open ? '' : 'is-collapsed'}">
  <div class="dsh-shell-header">
    <div class="dsh-shell-title">
      <span>🐚 DSH Interactive Shell</span>
      <span class="dsh-shell-badge dsh-badge-exited">idle</span>
    </div>
    <div class="dsh-shell-controls">
      <button class="dsh-btn" data-action="toggle-open">${open ? '−' : '+'}</button>
    </div>
  </div>
  ${open ? '<div class="dsh-shell-viewport"><div style="color: #71717a; text-align: center; padding: 40px 0;">No active interactive shell sessions.</div></div>' : ''}
</div>`;
    }
    const badgeClass = activeState?.lockState === 'user_takeover'
        ? 'dsh-badge-takeover'
        : activeState?.status === 'running'
            ? 'dsh-badge-running'
            : activeState?.mode === 'monitor'
                ? 'dsh-badge-monitor'
                : 'dsh-badge-exited';
    const badgeText = activeState?.lockState === 'user_takeover'
        ? `takeover (${activeState.lockedBy ?? 'user'})`
        : activeState?.status ?? 'idle';
    const tabsHtml = states
        .map((s) => `
    <button class="dsh-shell-tab ${s.sessionId === activeId ? 'is-active' : ''}" data-tab-id="${s.sessionId}">
      <span>${s.lockState === 'user_takeover' ? '🟠' : s.status === 'running' ? '🟢' : '⚪'}</span>
      <span>${s.command ? s.command.slice(0, 20) : s.sessionId}</span>
    </button>`)
        .join('');
    const bufferText = activeClient?.getBuffer().getText() ?? '';
    return `
<div class="dsh-shell-dock ${open ? '' : 'is-collapsed'}">
  <div class="dsh-shell-header">
    <div class="dsh-shell-title">
      <span>🐚 DSH Shell</span>
      <span class="dsh-shell-badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="dsh-shell-controls">
      <button class="dsh-btn" data-action="toggle-open">${open ? '−' : '+'}</button>
    </div>
  </div>
  ${open
        ? `
  <div class="dsh-shell-tabs">
    ${tabsHtml}
  </div>
  <div class="dsh-shell-viewport" id="dsh-term-viewport">${bufferText || '<span style="color: #52525b;">Waiting for output...</span>'}</div>
  <div class="dsh-shell-actions">
    <div style="display: flex; gap: 6px;">
      ${activeState?.lockState === 'user_takeover'
            ? `<button class="dsh-btn dsh-btn-release" data-action="release-takeover">🖐 Hand Back to Agent</button>`
            : `<button class="dsh-btn dsh-btn-takeover" data-action="acquire-takeover">⚡ Take Over</button>`}
    </div>
    <div style="display: flex; gap: 6px;">
      <button class="dsh-btn" data-action="quick-ctrl-c">Ctrl+C</button>
      <button class="dsh-btn" data-action="quick-ctrl-d">Ctrl+D</button>
      <button class="dsh-btn" data-action="quick-clear">Clear</button>
    </div>
  </div>`
        : ''}
</div>`;
}
//# sourceMappingURL=ui.js.map