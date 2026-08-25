/**
 * Pure, dependency-free logic for dsh-interactive-shell: mode selection,
 * event detection, output-tail truncation, and session-budget guards. Free
 * of @deepseek-ai imports so the node:test suite exercises it standalone.
 *
 * @module
 */

/** One of the four session modes. */
export type ShellMode = 'interactive' | 'hands-free' | 'dispatch' | 'monitor'

/** Actions the single `interactive_shell` tool accepts. */
export type ShellAction =
  | 'spawn'
  | 'send'
  | 'status'
  | 'read'
  | 'kill'
  | 'attach-monitor'

/** Parsed tool arguments (the tool's JSON contract, validated by the model). */
export interface ShellToolArgs {
  action: ShellAction
  command?: string
  mode?: ShellMode
  sessionId?: string
  input?: string
  submit?: boolean
  /** Monitor trigger: a regex matched against new output. */
  trigger?: string
  /** Monitor trigger: a file path watched for content change. */
  watch?: string
  /** Dispatch: absolute deadline in ms. */
  timeoutMs?: number
}

/** Budget check: whether one more session may spawn for an owner. */
export function underSessionBudget(live: number, maxSessions: number): boolean {
  return live < maxSessions
}

/** Budget check: a monitor attach is allowed only while a session is live. */
export function monitorBudgetError(
  live: number,
  maxSessions: number,
): string | undefined {
  if (live >= maxSessions) return `session budget exceeded (${live}/${maxSessions})`
  return undefined
}

/** Cooldown check: whether a monitor trigger may wake the agent again. */
export function monitorCooldownElapsed(lastEventAt: number | undefined, now: number, cooldownMs: number): boolean {
  if (lastEventAt === undefined) return true
  return now - lastEventAt >= cooldownMs
}

/** Monitor event budget: auto-detach once exhausted. */
export function monitorBudgetExhausted(eventsFired: number, maxEvents: number): boolean {
  return eventsFired >= maxEvents
}

/**
 * Detect a dispatch completion: the session exited, or the quiet window
 * elapsed since the last output, or the absolute deadline passed.
 */
export interface DispatchFacts {
  exited: boolean
  lastOutputAt: number
  quietMs: number
  now: number
  timeoutMs: number
  startedAt: number
}

export function dispatchCompleted(facts: DispatchFacts): boolean {
  if (facts.exited) return true
  if (facts.now - facts.lastOutputAt >= facts.quietMs) return true
  return facts.now - facts.startedAt >= facts.timeoutMs
}

/**
 * Truncate an output tail to a byte-ish character budget, preserving the
 * most recent content and marking the cut.
 */
export function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, Math.floor(maxChars / 4))
  const tail = text.slice(text.length - Math.ceil(maxChars * 0.75))
  return `${head}\n…[${text.length - head.length - tail.length} chars omitted]…\n${tail}`
}

/** A monitor trigger match against new output. */
export function triggerMatches(trigger: string, newText: string): boolean {
  try {
    return new RegExp(trigger).test(newText)
  } catch {
    return false // a malformed trigger never fires; fail closed, not loud
  }
}

/** A monitor wake-up payload (what the agent sees on a trigger). */
export interface MonitorWake {
  sessionId: string
  trigger: string
  tail: string
}

/** A dispatch completion payload. */
export interface DispatchComplete {
  sessionId: string
  exitCode: number | null
  tail: string
}

/** Resolve the effective mode from tool args, falling back to the default. */
export function resolveMode(mode: ShellMode | undefined, defaultMode: ShellMode): ShellMode {
  return mode ?? defaultMode
}
