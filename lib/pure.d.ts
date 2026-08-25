/**
 * Pure, dependency-free logic for dsh-interactive-shell: mode selection,
 * event detection, output-tail truncation, and session-budget guards. Free
 * of @deepseek-ai imports so the node:test suite exercises it standalone.
 *
 * @module
 */
/** One of the four session modes. */
export type ShellMode = 'interactive' | 'hands-free' | 'dispatch' | 'monitor';
/** Actions the single `interactive_shell` tool accepts. */
export type ShellAction = 'spawn' | 'send' | 'status' | 'read' | 'kill' | 'attach-monitor';
/** Parsed tool arguments (the tool's JSON contract, validated by the model). */
export interface ShellToolArgs {
    action: ShellAction;
    command?: string;
    mode?: ShellMode;
    sessionId?: string;
    input?: string;
    submit?: boolean;
    /** Monitor trigger: a regex matched against new output. */
    trigger?: string;
    /** Monitor trigger: a file path watched for content change. */
    watch?: string;
    /** Dispatch: absolute deadline in ms. */
    timeoutMs?: number;
}
/** Budget check: whether one more session may spawn for an owner. */
export declare function underSessionBudget(live: number, maxSessions: number): boolean;
/** Budget check: a monitor attach is allowed only while a session is live. */
export declare function monitorBudgetError(live: number, maxSessions: number): string | undefined;
/** Cooldown check: whether a monitor trigger may wake the agent again. */
export declare function monitorCooldownElapsed(lastEventAt: number | undefined, now: number, cooldownMs: number): boolean;
/** Monitor event budget: auto-detach once exhausted. */
export declare function monitorBudgetExhausted(eventsFired: number, maxEvents: number): boolean;
/**
 * Detect a dispatch completion: the session exited, or the quiet window
 * elapsed since the last output, or the absolute deadline passed.
 */
export interface DispatchFacts {
    exited: boolean;
    lastOutputAt: number;
    quietMs: number;
    now: number;
    timeoutMs: number;
    startedAt: number;
}
export declare function dispatchCompleted(facts: DispatchFacts): boolean;
/**
 * Truncate an output tail to a byte-ish character budget, preserving the
 * most recent content and marking the cut.
 */
export declare function truncateTail(text: string, maxChars: number): string;
/** A monitor trigger match against new output. */
export declare function triggerMatches(trigger: string, newText: string): boolean;
/** A monitor wake-up payload (what the agent sees on a trigger). */
export interface MonitorWake {
    sessionId: string;
    trigger: string;
    tail: string;
}
/** A dispatch completion payload. */
export interface DispatchComplete {
    sessionId: string;
    exitCode: number | null;
    tail: string;
}
/** Resolve the effective mode from tool args, falling back to the default. */
export declare function resolveMode(mode: ShellMode | undefined, defaultMode: ShellMode): ShellMode;
