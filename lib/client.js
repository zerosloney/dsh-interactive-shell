/**
 * Web UI Client & Viewport Adapter for dsh-interactive-shell:
 * Provides client-side state management, virtual ANSI buffer tracking,
 * pluggable Xterm/Canvas renderer binding, and stream event ingestion.
 *
 * @module
 */
/** ANSI Escape Sequence Regular Expression for text stripping. */
const ESC_CHAR = '\\u001B';
const CSI_CHAR = '\\u009B';
const ANSI_PATTERN = '[' +
    ESC_CHAR +
    CSI_CHAR +
    '][\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%_~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%_~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))';
const ANSI_REGEX = new RegExp(ANSI_PATTERN, 'g');
/** Strip ANSI color/control codes from a string for plain-text extraction. */
export function stripAnsi(text) {
    return text.replace(ANSI_REGEX, '');
}
/**
 * Headless in-memory virtual terminal buffer: maintains lines and raw ANSI text
 * with a bounded scrollback limit.
 */
export class VirtualTerminalBuffer {
    rawChunks = [];
    plainLines = [];
    maxLines;
    constructor(maxLines = 1000) {
        this.maxLines = maxLines;
    }
    /** Append an output chunk into the buffer. */
    append(chunk) {
        this.rawChunks.push(chunk);
        const stripped = stripAnsi(chunk);
        if (stripped.length === 0)
            return;
        const newLines = stripped.split(/\r?\n/);
        if (this.plainLines.length === 0) {
            this.plainLines.push(...newLines);
        }
        else {
            // The first segment merges with the last line of the buffer
            this.plainLines[this.plainLines.length - 1] += newLines[0];
            for (let i = 1; i < newLines.length; i++) {
                this.plainLines.push(newLines[i]);
            }
        }
        // Retain up to maxLines (+ 1 if trailing line is an open newline)
        const maxEntries = this.plainLines.length > 0 && this.plainLines[this.plainLines.length - 1] === ''
            ? this.maxLines + 1
            : this.maxLines;
        if (this.plainLines.length > maxEntries) {
            this.plainLines = this.plainLines.slice(this.plainLines.length - maxEntries);
        }
    }
    /** Get all plain text lines. */
    getLines() {
        if (this.plainLines.length > 0 && this.plainLines[this.plainLines.length - 1] === '') {
            return this.plainLines.slice(0, -1);
        }
        return this.plainLines;
    }
    /** Get full plain text as a single string. */
    getText() {
        return this.getLines().join('\n');
    }
    /** Get raw concatenated ANSI text. */
    getRawText() {
        return this.rawChunks.join('');
    }
    /** Clear all buffer content. */
    clear() {
        this.rawChunks = [];
        this.plainLines = [];
    }
}
/**
 * Client-side session manager: consumes stream frames, maintains live session
 * state, populates virtual buffer, and feeds attached terminal renderers (Xterm.js).
 */
export class TermStreamClient {
    sessionId;
    state;
    buffer;
    renderers = new Set();
    stateListeners = new Set();
    outputListeners = new Set();
    onSendInput;
    onLockRequest;
    streamDisposer;
    constructor(sessionId, options = {}) {
        this.sessionId = sessionId;
        this.buffer = new VirtualTerminalBuffer(options.maxScrollback ?? 1000);
        this.onSendInput = options.onSendInput;
        this.onLockRequest = options.onLockRequest;
        this.state = {
            sessionId,
            command: '',
            mode: 'interactive',
            status: 'starting',
            exitCode: null,
            lockState: 'agent_driving',
            totalLines: 0,
            updatedAt: Date.now(),
        };
    }
    /** Get current snapshot of the session state. */
    getState() {
        return this.state;
    }
    /** Get the virtual terminal buffer. */
    getBuffer() {
        return this.buffer;
    }
    /**
     * Ingest and process a streaming frame from the backend.
     */
    handleFrame(frame) {
        if (frame.sessionId !== this.sessionId)
            return;
        switch (frame.type) {
            case 'term:init': {
                this.state = {
                    ...this.state,
                    command: frame.command,
                    mode: frame.mode,
                    status: 'running',
                    updatedAt: frame.time,
                };
                if (frame.motd) {
                    this.writeOutput(frame.motd + '\r\n');
                }
                this.notifyState();
                break;
            }
            case 'term:output': {
                this.writeOutput(frame.chunk);
                this.state = {
                    ...this.state,
                    status: 'running',
                    totalLines: frame.lineEnd,
                    updatedAt: frame.time,
                };
                this.notifyState();
                break;
            }
            case 'term:lock': {
                const lockFrame = frame;
                this.state = {
                    ...this.state,
                    lockState: lockFrame.state,
                    lockedBy: lockFrame.lockedBy,
                    updatedAt: lockFrame.time,
                };
                this.notifyState();
                break;
            }
            case 'term:event': {
                if (frame.event === 'session-killed') {
                    this.state = {
                        ...this.state,
                        status: 'killed',
                        lastEvent: frame.event,
                        updatedAt: frame.time,
                    };
                }
                else if (frame.event === 'dispatch-completed') {
                    this.state = {
                        ...this.state,
                        status: 'exited',
                        lastEvent: frame.event,
                        updatedAt: frame.time,
                    };
                }
                else {
                    this.state = {
                        ...this.state,
                        lastEvent: frame.event,
                        updatedAt: frame.time,
                    };
                }
                this.notifyState();
                break;
            }
            case 'term:exit': {
                this.state = {
                    ...this.state,
                    status: 'exited',
                    exitCode: frame.exitCode,
                    updatedAt: frame.time,
                };
                this.notifyState();
                break;
            }
        }
    }
    /** Write an output chunk to buffer, renderers, and output listeners. */
    writeOutput(chunk) {
        this.buffer.append(chunk);
        for (const renderer of this.renderers) {
            try {
                renderer.write(chunk);
            }
            catch {
                // Safe dispatch to renderers
            }
        }
        for (const listener of this.outputListeners) {
            try {
                listener(chunk);
            }
            catch {
                // Safe dispatch
            }
        }
    }
    /** Notify state change listeners. */
    notifyState() {
        for (const listener of this.stateListeners) {
            try {
                listener(this.state);
            }
            catch {
                // Safe dispatch
            }
        }
    }
    /**
     * Attach a terminal renderer (e.g. Xterm.js instance).
     * Replays current buffer to the renderer immediately.
     * @returns Disposer function to detach renderer.
     */
    attachRenderer(renderer) {
        this.renderers.add(renderer);
        // Replay current raw buffer into renderer
        const raw = this.buffer.getRawText();
        if (raw.length > 0) {
            try {
                renderer.write(raw);
            }
            catch {
                // Safe replay
            }
        }
        return () => {
            this.renderers.delete(renderer);
        };
    }
    /**
     * Send user input keystrokes from the Web UI to the backend PTY (Takeover Mode).
     */
    sendInput(input) {
        this.onSendInput?.(this.sessionId, input);
    }
    /**
     * Request user takeover of the terminal session.
     */
    requestTakeover(user = 'user') {
        this.onLockRequest?.(this.sessionId, 'acquire', user);
    }
    /**
     * Release takeover back to agent driving.
     */
    releaseTakeover() {
        this.onLockRequest?.(this.sessionId, 'release');
    }
    /** Subscribe to state change notifications. */
    onStateChange(listener) {
        this.stateListeners.add(listener);
        listener(this.state);
        return () => this.stateListeners.delete(listener);
    }
    /** Subscribe to raw output chunks. */
    onOutput(listener) {
        this.outputListeners.add(listener);
        return () => this.outputListeners.delete(listener);
    }
    /**
     * Connect this client directly to a StreamHub instance with automatic history replay.
     */
    connectHub(hub, replay = true) {
        this.streamDisposer?.();
        const unsub = hub.subscribe(this.sessionId, (frame) => this.handleFrame(frame), replay);
        this.streamDisposer = unsub;
        return unsub;
    }
    /** Dispose all resources, listeners, and renderer attachments. */
    dispose() {
        this.streamDisposer?.();
        this.streamDisposer = undefined;
        for (const renderer of this.renderers) {
            try {
                renderer.dispose?.();
            }
            catch {
                // Safe cleanup
            }
        }
        this.renderers.clear();
        this.stateListeners.clear();
        this.outputListeners.clear();
        this.buffer.clear();
    }
}
//# sourceMappingURL=client.js.map