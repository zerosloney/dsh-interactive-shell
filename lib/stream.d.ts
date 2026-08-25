/**
 * Streaming adapter and terminal frame protocol for dsh-interactive-shell:
 * provides real-time ANSI stream broadcasting, history ring-buffer replay,
 * and dual-writer (agent/human takeover) lock management for Web UI overlays.
 *
 * @module
 */
/**
 * Types of streaming frames broadcasted from the interactive-shell backend
 * to Web UI and other stream listeners.
 */
export type TermFrameType = 'term:init' | 'term:output' | 'term:event' | 'term:lock' | 'term:exit';
/** Initial metadata frame sent when a PTY session is spawned. */
export interface TermInitFrame {
    type: 'term:init';
    sessionId: string;
    command: string;
    mode: string;
    motd?: string;
    time: number;
}
/** Output chunk frame carrying real-time stdout/stderr ANSI text. */
export interface TermOutputFrame {
    type: 'term:output';
    sessionId: string;
    chunk: string;
    lineBegin: number;
    lineEnd: number;
    time: number;
}
/** Lifecycle event frame (dispatch completed, monitor trigger, kill). */
export interface TermEventFrame {
    type: 'term:event';
    sessionId: string;
    event: 'session-started' | 'dispatch-completed' | 'monitor-triggered' | 'session-killed' | 'exited';
    payload: Record<string, unknown>;
    time: number;
}
/** Control-lock frame indicating whether Agent or Human currently owns the session. */
export interface TermLockFrame {
    type: 'term:lock';
    sessionId: string;
    state: 'agent_driving' | 'user_takeover';
    lockedBy?: string;
    time: number;
}
/** Terminal exit frame carrying process exit code. */
export interface TermExitFrame {
    type: 'term:exit';
    sessionId: string;
    exitCode: number | null;
    time: number;
}
/** Discriminated union of all server-to-client streaming frames. */
export type TermFrame = TermInitFrame | TermOutputFrame | TermEventFrame | TermLockFrame | TermExitFrame;
export type TermStreamListener = (frame: TermFrame) => void;
export interface StreamHubOptions {
    /** Maximum number of history frames retained per session for replay (default: 50). */
    maxHistoryFrames?: number;
    /** Optional callback invoked on every broadcast (e.g. to emit Cordis events). */
    onBroadcast?: (frame: TermFrame) => void;
    /** Handler for direct user input (PTY write) during takeover. */
    onUserInput?: (sessionId: string, input: string) => Promise<string | void> | string | void;
    /** Handler called when user releases takeover lock (for agent wakeup and context sync). */
    onReleaseLock?: (sessionId: string, summary?: string) => void;
}
/**
 * In-memory stream broadcaster and subscriber hub with history caching and lock state.
 */
export declare class StreamHub {
    private readonly listeners;
    private readonly sessionListeners;
    private readonly history;
    private readonly lockStates;
    private readonly maxHistory;
    private readonly onBroadcast?;
    private readonly onUserInput?;
    private readonly onReleaseLock?;
    constructor(options?: StreamHubOptions);
    /**
     * Subscribe to stream frames across all sessions.
     * @returns Disposer to unsubscribe.
     */
    subscribeAll(listener: TermStreamListener): () => void;
    /**
     * Subscribe to stream frames for a specific session ID, and optionally replay recent history frames.
     * @param sessionId Target session ID.
     * @param listener Callback for each frame.
     * @param replayHistory Whether to immediately replay cached frames to this listener (default: true).
     * @returns Disposer to unsubscribe.
     */
    subscribe(sessionId: string, listener: TermStreamListener, replayHistory?: boolean): () => void;
    /**
     * Broadcast one frame to all global and session-specific subscribers, and record into history ring buffer.
     */
    broadcast(frame: TermFrame): void;
    /** Get current lock state of a session. */
    getLockState(sessionId: string): {
        state: 'agent_driving' | 'user_takeover';
        lockedBy?: string;
    };
    /** Acquire user takeover lock for a session. Returns true if state changed. */
    acquireLock(sessionId: string, user?: string): boolean;
    /**
     * Send user input directly to the backend PTY session (Takeover Mode).
     */
    sendUserInput(sessionId: string, input: string): Promise<string | void>;
    /**
     * Release user takeover lock back to agent driving and notify agent of handback.
     * Returns true if state changed.
     */
    releaseLock(sessionId: string, summary?: string): boolean;
    /**
     * Alias for releaseLock: explicitly yields interactive control back to the agent.
     */
    handback(sessionId: string, summary?: string): boolean;
    /** Retrieve recent history frames for a session. */
    getHistory(sessionId: string): readonly TermFrame[];
    /** Clean up all cached resources for a finished/killed session. */
    cleanup(sessionId: string): void;
    /** Dispose all listeners and cached buffers. */
    dispose(): void;
}
