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
export type TermFrameType =
  | 'term:init'
  | 'term:output'
  | 'term:event'
  | 'term:lock'
  | 'term:exit'

/** Initial metadata frame sent when a PTY session is spawned. */
export interface TermInitFrame {
  type: 'term:init'
  sessionId: string
  command: string
  mode: string
  motd?: string
  time: number
}

/** Output chunk frame carrying real-time stdout/stderr ANSI text. */
export interface TermOutputFrame {
  type: 'term:output'
  sessionId: string
  chunk: string
  lineBegin: number
  lineEnd: number
  time: number
}

/** Lifecycle event frame (dispatch completed, monitor trigger, kill). */
export interface TermEventFrame {
  type: 'term:event'
  sessionId: string
  event: 'session-started' | 'dispatch-completed' | 'monitor-triggered' | 'session-killed' | 'exited'
  payload: Record<string, unknown>
  time: number
}

/** Control-lock frame indicating whether Agent or Human currently owns the session. */
export interface TermLockFrame {
  type: 'term:lock'
  sessionId: string
  state: 'agent_driving' | 'user_takeover'
  lockedBy?: string
  time: number
}

/** Terminal exit frame carrying process exit code. */
export interface TermExitFrame {
  type: 'term:exit'
  sessionId: string
  exitCode: number | null
  time: number
}

/** Discriminated union of all server-to-client streaming frames. */
export type TermFrame =
  | TermInitFrame
  | TermOutputFrame
  | TermEventFrame
  | TermLockFrame
  | TermExitFrame

export type TermStreamListener = (frame: TermFrame) => void

export interface StreamHubOptions {
  /** Maximum number of history frames retained per session for replay (default: 50). */
  maxHistoryFrames?: number
  /** Optional callback invoked on every broadcast (e.g. to emit Cordis events). */
  onBroadcast?: (frame: TermFrame) => void
  /** Handler for direct user input (PTY write) during takeover. */
  onUserInput?: (sessionId: string, input: string) => Promise<string | void> | string | void
  /** Handler called when user releases takeover lock (for agent wakeup and context sync). */
  onReleaseLock?: (sessionId: string, summary?: string) => void
}

/**
 * In-memory stream broadcaster and subscriber hub with history caching and lock state.
 */
export class StreamHub {
  private readonly listeners = new Set<TermStreamListener>()
  private readonly sessionListeners = new Map<string, Set<TermStreamListener>>()
  private readonly history = new Map<string, TermFrame[]>()
  private readonly lockStates = new Map<string, { state: 'agent_driving' | 'user_takeover'; lockedBy?: string }>()
  private readonly maxHistory: number
  private readonly onBroadcast?: (frame: TermFrame) => void
  private readonly onUserInput?: (sessionId: string, input: string) => Promise<string | void> | string | void
  private readonly onReleaseLock?: (sessionId: string, summary?: string) => void

  constructor(options: StreamHubOptions = {}) {
    this.maxHistory = options.maxHistoryFrames ?? 50
    this.onBroadcast = options.onBroadcast
    this.onUserInput = options.onUserInput
    this.onReleaseLock = options.onReleaseLock
  }

  /**
   * Subscribe to stream frames across all sessions.
   * @returns Disposer to unsubscribe.
   */
  subscribeAll(listener: TermStreamListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Alias for subscribeAll: subscribe to all broadcast stream frames.
   */
  onFrame(listener: TermStreamListener): () => void {
    return this.subscribeAll(listener)
  }

  /**
   * Subscribe to stream frames for a specific session ID, and optionally replay recent history frames.
   * @param sessionId Target session ID.
   * @param listener Callback for each frame.
   * @param replayHistory Whether to immediately replay cached frames to this listener (default: true).
   * @returns Disposer to unsubscribe.
   */
  subscribe(sessionId: string, listener: TermStreamListener, replayHistory = true): () => void {
    let set = this.sessionListeners.get(sessionId)
    if (set === undefined) {
      set = new Set()
      this.sessionListeners.set(sessionId, set)
    }
    set.add(listener)

    if (replayHistory) {
      const frames = this.history.get(sessionId) ?? []
      for (const frame of frames) {
        try {
          listener(frame)
        } catch {
          // Safe dispatch: subscriber error does not abort subscription
        }
      }
    }

    return () => {
      set.delete(listener)
      if (set.size === 0) {
        this.sessionListeners.delete(sessionId)
      }
    }
  }

  /**
   * Broadcast one frame to all global and session-specific subscribers, and record into history ring buffer.
   */
  broadcast(frame: TermFrame): void {
    // Record into history buffer
    let frames = this.history.get(frame.sessionId)
    if (frames === undefined) {
      frames = []
      this.history.set(frame.sessionId, frames)
    }
    frames.push(frame)
    if (frames.length > this.maxHistory) {
      frames.shift()
    }

    // Update lock state tracking
    if (frame.type === 'term:lock') {
      this.lockStates.set(frame.sessionId, { state: frame.state, lockedBy: frame.lockedBy })
    }

    // Trigger external hook
    try {
      this.onBroadcast?.(frame)
    } catch {
      // Safe dispatch
    }

    // Notify global listeners
    for (const listener of this.listeners) {
      try {
        listener(frame)
      } catch {
        // Safe dispatch
      }
    }

    // Notify session-specific listeners
    const sessionSubs = this.sessionListeners.get(frame.sessionId)
    if (sessionSubs !== undefined) {
      for (const listener of sessionSubs) {
        try {
          listener(frame)
        } catch {
          // Safe dispatch
        }
      }
    }
  }

  /** Get current lock state of a session. */
  getLockState(sessionId: string): { state: 'agent_driving' | 'user_takeover'; lockedBy?: string } {
    return this.lockStates.get(sessionId) ?? { state: 'agent_driving' }
  }

  /** Acquire user takeover lock for a session. Returns true if state changed. */
  acquireLock(sessionId: string, user = 'user'): boolean {
    const current = this.getLockState(sessionId)
    if (current.state === 'user_takeover') return false
    this.broadcast({
      type: 'term:lock',
      sessionId,
      state: 'user_takeover',
      lockedBy: user,
      time: Date.now(),
    })
    return true
  }

  /**
   * Send user input directly to the backend PTY session (Takeover Mode).
   */
  async sendUserInput(sessionId: string, input: string): Promise<string | void> {
    if (this.onUserInput === undefined) {
      throw new Error('StreamHub: no onUserInput handler registered')
    }
    return await this.onUserInput(sessionId, input)
  }

  /**
   * Release user takeover lock back to agent driving and notify agent of handback.
   * Returns true if state changed.
   */
  releaseLock(sessionId: string, summary?: string): boolean {
    const current = this.getLockState(sessionId)
    if (current.state === 'agent_driving') return false
    this.broadcast({
      type: 'term:lock',
      sessionId,
      state: 'agent_driving',
      lockedBy: undefined,
      time: Date.now(),
    })
    try {
      this.onReleaseLock?.(sessionId, summary)
    } catch {
      // Safe dispatch
    }
    return true
  }

  /**
   * Alias for releaseLock: explicitly yields interactive control back to the agent.
   */
  handback(sessionId: string, summary?: string): boolean {
    return this.releaseLock(sessionId, summary)
  }

  /** Retrieve recent history frames for a session. */
  getHistory(sessionId: string): readonly TermFrame[] {
    return this.history.get(sessionId) ?? []
  }

  /** Clean up all cached resources for a finished/killed session. */
  cleanup(sessionId: string): void {
    this.history.delete(sessionId)
    this.lockStates.delete(sessionId)
    this.sessionListeners.delete(sessionId)
  }

  /** Dispose all listeners and cached buffers. */
  dispose(): void {
    this.listeners.clear()
    this.sessionListeners.clear()
    this.history.clear()
    this.lockStates.clear()
  }
}
