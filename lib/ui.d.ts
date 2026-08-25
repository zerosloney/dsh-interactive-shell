/**
 * Web UI Overlay Panel & Interaction Controller for dsh-interactive-shell:
 * Provides multi-tab terminal session switching, takeover action bar,
 * quick action dispatchers (Ctrl+C, Ctrl+D, clear), theme switching (dark/light),
 * and responsive panel rendering.
 *
 * @module
 */
import type { ClientSessionState, TermStreamClient } from './client.js';
/** Quick control actions available in the UI panel. */
export type QuickActionKind = 'ctrl-c' | 'ctrl-d' | 'enter' | 'clear' | 'kill';
/** Theme color schemes supported by the Web UI panel. */
export type ThemeKind = 'dark' | 'light';
export interface DshShellPanelOptions {
    /** Initial visibility state of the overlay panel (default: true). */
    initialOpen?: boolean;
    /** Initial theme mode ('dark' | 'light', default: 'dark'). */
    theme?: ThemeKind;
    /** Current human operator name for takeover requests (default: 'user'). */
    operatorName?: string;
    /** Callback when user invokes a quick action or command. */
    onQuickAction?: (sessionId: string, action: QuickActionKind) => void;
}
/**
 * State & Interaction Controller for the DSH Shell Web UI Overlay Panel.
 */
export declare class DshShellPanelController {
    private readonly clients;
    private readonly clientDisposers;
    private readonly changeListeners;
    private activeId;
    private open;
    private theme;
    private operator;
    private readonly onQuickAction?;
    constructor(options?: DshShellPanelOptions);
    /** Whether the floating overlay panel is currently visible/expanded. */
    isOpen(): boolean;
    /** Set or toggle overlay panel visibility. */
    setOpen(open: boolean): void;
    /** Toggle open state. */
    toggleOpen(): boolean;
    /** Get current theme scheme. */
    getTheme(): ThemeKind;
    /** Set theme scheme. */
    setTheme(theme: ThemeKind): void;
    /** Toggle between dark and light themes. */
    toggleTheme(): ThemeKind;
    /** Get active session ID. */
    getActiveSessionId(): string | null;
    /** Get active client instance. */
    getActiveClient(): TermStreamClient | undefined;
    /** Get list of all registered session states. */
    getSessionStates(): ClientSessionState[];
    /** Register a terminal session stream client into the panel. */
    addSession(client: TermStreamClient): void;
    /** Remove a session from the panel. */
    removeSession(sessionId: string): void;
    /** Switch active tab session. */
    selectSession(sessionId: string): boolean;
    /**
     * Toggle user takeover for the active (or specified) session.
     */
    toggleTakeover(sessionId?: string, note?: string): boolean;
    /**
     * Dispatch a quick action (Ctrl+C, Ctrl+D, clear, enter, kill) to active session.
     */
    dispatchQuickAction(action: QuickActionKind, sessionId?: string): void;
    /** Subscribe to UI state updates. */
    subscribe(listener: () => void): () => void;
    private notify;
    /** Dispose all resources. */
    dispose(): void;
}
/**
 * Render responsive CSS styling for the DSH Interactive Shell Overlay (Dark & Modern Light themes).
 */
export declare function renderShellPanelCss(): string;
/**
 * Render semantic HTML markup for the current state of DshShellPanelController.
 */
export declare function renderShellPanelHtml(controller: DshShellPanelController): string;
