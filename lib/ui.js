/**
 * Web UI Overlay Panel & Interaction Controller for dsh-interactive-shell:
 * Provides multi-tab terminal session switching, takeover action bar,
 * quick action dispatchers (Ctrl+C, Ctrl+D, clear), theme switching (dark/light),
 * and responsive panel rendering.
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
    theme;
    operator;
    onQuickAction;
    constructor(options = {}) {
        this.open = options.initialOpen ?? true;
        this.theme = options.theme ?? 'dark';
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
    /** Get current theme scheme. */
    getTheme() {
        return this.theme;
    }
    /** Set theme scheme. */
    setTheme(theme) {
        if (this.theme === theme)
            return;
        this.theme = theme;
        this.notify();
    }
    /** Toggle between dark and light themes. */
    toggleTheme() {
        const nextTheme = this.theme === 'dark' ? 'light' : 'dark';
        this.setTheme(nextTheme);
        return this.theme;
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
 * Render responsive CSS styling for the DSH Interactive Shell Overlay (Dark & Modern Light themes).
 */
export function renderShellPanelCss() {
    return `
.dsh-shell-dock {
  --dsh-bg: #18181b;
  --dsh-bg-header: #202024;
  --dsh-bg-tabs: #141416;
  --dsh-bg-viewport: #09090b;
  --dsh-bg-actions: #18181b;
  --dsh-text-primary: #f4f4f5;
  --dsh-text-secondary: #a1a1aa;
  --dsh-text-muted: #71717a;
  --dsh-border: #27272a;
  --dsh-tab-active-bg: #27272a;
  --dsh-tab-active-border: #3f3f46;
  --dsh-btn-bg: #27272a;
  --dsh-btn-border: #3f3f46;
  --dsh-btn-text: #f4f4f5;
  --dsh-btn-hover: #3f3f46;
  --dsh-shadow: 0 20px 35px -10px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);

  --dsh-badge-running-bg: #064e3b;
  --dsh-badge-running-text: #34d399;
  --dsh-badge-takeover-bg: #7c2d12;
  --dsh-badge-takeover-text: #fb923c;
  --dsh-badge-monitor-bg: #581c87;
  --dsh-badge-monitor-text: #c084fc;
  --dsh-badge-exited-bg: #3f3f46;
  --dsh-badge-exited-text: #a1a1aa;

  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 680px;
  max-width: calc(100vw - 48px);
  height: 440px;
  max-height: calc(100vh - 48px);
  background: var(--dsh-bg);
  color: var(--dsh-text-primary);
  border-radius: 12px;
  border: 1px solid var(--dsh-border);
  box-shadow: var(--dsh-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  z-index: 99999;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.dsh-shell-dock.theme-light {
  --dsh-bg: #ffffff;
  --dsh-bg-header: #f8fafc;
  --dsh-bg-tabs: #f1f5f9;
  --dsh-bg-viewport: #ffffff;
  --dsh-bg-actions: #f8fafc;
  --dsh-text-primary: #0f172a;
  --dsh-text-secondary: #475569;
  --dsh-text-muted: #94a3b8;
  --dsh-border: #e2e8f0;
  --dsh-tab-active-bg: #ffffff;
  --dsh-tab-active-border: #cbd5e1;
  --dsh-btn-bg: #ffffff;
  --dsh-btn-border: #cbd5e1;
  --dsh-btn-text: #1e293b;
  --dsh-btn-hover: #f1f5f9;
  --dsh-shadow: 0 20px 35px -10px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06);

  --dsh-badge-running-bg: #dcfce7;
  --dsh-badge-running-text: #15803d;
  --dsh-badge-takeover-bg: #ffedd5;
  --dsh-badge-takeover-text: #c2410c;
  --dsh-badge-monitor-bg: #f3e8ff;
  --dsh-badge-monitor-text: #7e22ce;
  --dsh-badge-exited-bg: #f1f5f9;
  --dsh-badge-exited-text: #64748b;
}

.dsh-shell-dock.is-collapsed {
  height: 42px;
}
.dsh-shell-header {
  height: 42px;
  padding: 0 14px;
  background: var(--dsh-bg-header);
  border-bottom: 1px solid var(--dsh-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  user-select: none;
}
.dsh-shell-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsh-text-primary);
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
.dsh-badge-running { background: var(--dsh-badge-running-bg); color: var(--dsh-badge-running-text); }
.dsh-badge-takeover { background: var(--dsh-badge-takeover-bg); color: var(--dsh-badge-takeover-text); }
.dsh-badge-monitor { background: var(--dsh-badge-monitor-bg); color: var(--dsh-badge-monitor-text); }
.dsh-badge-exited { background: var(--dsh-badge-exited-bg); color: var(--dsh-badge-exited-text); }

.dsh-shell-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--dsh-bg-tabs);
  padding: 4px 8px;
  border-bottom: 1px solid var(--dsh-border);
  overflow-x: auto;
}
.dsh-shell-tab {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  background: transparent;
  color: var(--dsh-text-secondary);
  cursor: pointer;
  border: 1px solid transparent;
  display: flex;
  align-items: center;
  gap: 6px;
}
.dsh-shell-tab.is-active {
  background: var(--dsh-tab-active-bg);
  color: var(--dsh-text-primary);
  border-color: var(--dsh-tab-active-border);
  font-weight: 500;
}
.dsh-shell-viewport {
  flex: 1;
  padding: 10px 14px;
  background: var(--dsh-bg-viewport);
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--dsh-text-primary);
}
.dsh-shell-actions {
  height: 44px;
  padding: 0 12px;
  background: var(--dsh-bg-actions);
  border-top: 1px solid var(--dsh-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.dsh-btn {
  padding: 4px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--dsh-btn-border);
  background: var(--dsh-btn-bg);
  color: var(--dsh-btn-text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.dsh-btn:hover {
  background: var(--dsh-btn-hover);
}
.dsh-btn-icon {
  padding: 4px 8px;
  font-size: 12px;
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
.dsh-btn-release:hover {
  background: #047857;
}
`;
}
/**
 * Render semantic HTML markup for the current state of DshShellPanelController.
 */
export function renderShellPanelHtml(controller) {
    const open = controller.isOpen();
    const theme = controller.getTheme();
    const states = controller.getSessionStates();
    const activeId = controller.getActiveSessionId();
    const activeClient = controller.getActiveClient();
    const activeState = activeClient?.getState();
    const themeClass = theme === 'light' ? 'theme-light' : 'theme-dark';
    const themeIcon = theme === 'dark' ? '☀️' : '🌙';
    if (states.length === 0) {
        return `
<div class="dsh-shell-dock ${themeClass} ${open ? '' : 'is-collapsed'}">
  <div class="dsh-shell-header">
    <div class="dsh-shell-title">
      <span>🐚 DSH Interactive Shell</span>
      <span class="dsh-shell-badge dsh-badge-exited">idle</span>
    </div>
    <div class="dsh-shell-controls" style="display: flex; gap: 4px; align-items: center;">
      <button class="dsh-btn dsh-btn-icon" data-action="toggle-theme" title="Switch Theme">${themeIcon}</button>
      <button class="dsh-btn" data-action="toggle-open">${open ? '−' : '+'}</button>
    </div>
  </div>
  ${open ? '<div class="dsh-shell-viewport"><div style="color: var(--dsh-text-muted); text-align: center; padding: 40px 0;">No active interactive shell sessions.</div></div>' : ''}
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
<div class="dsh-shell-dock ${themeClass} ${open ? '' : 'is-collapsed'}">
  <div class="dsh-shell-header">
    <div class="dsh-shell-title">
      <span>🐚 DSH Shell</span>
      <span class="dsh-shell-badge ${badgeClass}">${badgeText}</span>
    </div>
    <div class="dsh-shell-controls" style="display: flex; gap: 4px; align-items: center;">
      <button class="dsh-btn dsh-btn-icon" data-action="toggle-theme" title="Switch Theme">${themeIcon}</button>
      <button class="dsh-btn" data-action="toggle-open">${open ? '−' : '+'}</button>
    </div>
  </div>
  ${open
        ? `
  <div class="dsh-shell-tabs">
    ${tabsHtml}
  </div>
  <div class="dsh-shell-viewport" id="dsh-term-viewport">${bufferText || '<span style="color: var(--dsh-text-muted);">Waiting for output...</span>'}</div>
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