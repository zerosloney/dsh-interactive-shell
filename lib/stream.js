/**
 * Streaming adapter and terminal frame protocol for dsh-interactive-shell:
 * provides real-time ANSI stream broadcasting, history ring-buffer replay,
 * and dual-writer (agent/human takeover) lock management for Web UI overlays.
 *
 * @module
 */
/**
 * In-memory stream broadcaster and subscriber hub with history caching and lock state.
 */
export class StreamHub {
    listeners = new Set();
    sessionListeners = new Map();
    history = new Map();
    lockStates = new Map();
    maxHistory;
    onBroadcast;
    onUserInput;
    onReleaseLock;
    constructor(options = {}) {
        this.maxHistory = options.maxHistoryFrames ?? 50;
        this.onBroadcast = options.onBroadcast;
        this.onUserInput = options.onUserInput;
        this.onReleaseLock = options.onReleaseLock;
    }
    /**
     * Subscribe to stream frames across all sessions.
     * @returns Disposer to unsubscribe.
     */
    subscribeAll(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    /**
     * Alias for subscribeAll: subscribe to all broadcast stream frames.
     */
    onFrame(listener) {
        return this.subscribeAll(listener);
    }
    /**
     * Subscribe to stream frames for a specific session ID, and optionally replay recent history frames.
     * @param sessionId Target session ID.
     * @param listener Callback for each frame.
     * @param replayHistory Whether to immediately replay cached frames to this listener (default: true).
     * @returns Disposer to unsubscribe.
     */
    subscribe(sessionId, listener, replayHistory = true) {
        let set = this.sessionListeners.get(sessionId);
        if (set === undefined) {
            set = new Set();
            this.sessionListeners.set(sessionId, set);
        }
        set.add(listener);
        if (replayHistory) {
            const frames = this.history.get(sessionId) ?? [];
            for (const frame of frames) {
                try {
                    listener(frame);
                }
                catch {
                    // Safe dispatch: subscriber error does not abort subscription
                }
            }
        }
        return () => {
            set.delete(listener);
            if (set.size === 0) {
                this.sessionListeners.delete(sessionId);
            }
        };
    }
    /**
     * Broadcast one frame to all global and session-specific subscribers, and record into history ring buffer.
     */
    broadcast(frame) {
        // Record into history buffer
        let frames = this.history.get(frame.sessionId);
        if (frames === undefined) {
            frames = [];
            this.history.set(frame.sessionId, frames);
        }
        frames.push(frame);
        if (frames.length > this.maxHistory) {
            frames.shift();
        }
        // Update lock state tracking
        if (frame.type === 'term:lock') {
            this.lockStates.set(frame.sessionId, { state: frame.state, lockedBy: frame.lockedBy });
        }
        // Trigger external hook
        try {
            this.onBroadcast?.(frame);
        }
        catch {
            // Safe dispatch
        }
        // Notify global listeners
        for (const listener of this.listeners) {
            try {
                listener(frame);
            }
            catch {
                // Safe dispatch
            }
        }
        // Notify session-specific listeners
        const sessionSubs = this.sessionListeners.get(frame.sessionId);
        if (sessionSubs !== undefined) {
            for (const listener of sessionSubs) {
                try {
                    listener(frame);
                }
                catch {
                    // Safe dispatch
                }
            }
        }
    }
    /** Get current lock state of a session. */
    getLockState(sessionId) {
        return this.lockStates.get(sessionId) ?? { state: 'agent_driving' };
    }
    /** Acquire user takeover lock for a session. Returns true if state changed. */
    acquireLock(sessionId, user = 'user') {
        const current = this.getLockState(sessionId);
        if (current.state === 'user_takeover')
            return false;
        this.broadcast({
            type: 'term:lock',
            sessionId,
            state: 'user_takeover',
            lockedBy: user,
            time: Date.now(),
        });
        return true;
    }
    /**
     * Send user input directly to the backend PTY session (Takeover Mode).
     */
    async sendUserInput(sessionId, input) {
        if (this.onUserInput === undefined) {
            throw new Error('StreamHub: no onUserInput handler registered');
        }
        return await this.onUserInput(sessionId, input);
    }
    /**
     * Release user takeover lock back to agent driving and notify agent of handback.
     * Returns true if state changed.
     */
    releaseLock(sessionId, summary) {
        const current = this.getLockState(sessionId);
        if (current.state === 'agent_driving')
            return false;
        this.broadcast({
            type: 'term:lock',
            sessionId,
            state: 'agent_driving',
            lockedBy: undefined,
            time: Date.now(),
        });
        try {
            this.onReleaseLock?.(sessionId, summary);
        }
        catch {
            // Safe dispatch
        }
        return true;
    }
    /**
     * Alias for releaseLock: explicitly yields interactive control back to the agent.
     */
    handback(sessionId, summary) {
        return this.releaseLock(sessionId, summary);
    }
    /** Retrieve recent history frames for a session. */
    getHistory(sessionId) {
        return this.history.get(sessionId) ?? [];
    }
    /** Clean up all cached resources for a finished/killed session. */
    cleanup(sessionId) {
        this.history.delete(sessionId);
        this.lockStates.delete(sessionId);
        this.sessionListeners.delete(sessionId);
    }
    /** Dispose all listeners and cached buffers. */
    dispose() {
        this.listeners.clear();
        this.sessionListeners.clear();
        this.history.clear();
        this.lockStates.clear();
    }
}
//# sourceMappingURL=stream.js.map