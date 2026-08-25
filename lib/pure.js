/**
 * Pure, dependency-free logic for dsh-interactive-shell: mode selection,
 * event detection, output-tail truncation, and session-budget guards. Free
 * of @deepseek-ai imports so the node:test suite exercises it standalone.
 *
 * @module
 */
/** Budget check: whether one more session may spawn for an owner. */
export function underSessionBudget(live, maxSessions) {
    return live < maxSessions;
}
/** Budget check: a monitor attach is allowed only while a session is live. */
export function monitorBudgetError(live, maxSessions) {
    if (live >= maxSessions)
        return `session budget exceeded (${live}/${maxSessions})`;
    return undefined;
}
/** Cooldown check: whether a monitor trigger may wake the agent again. */
export function monitorCooldownElapsed(lastEventAt, now, cooldownMs) {
    if (lastEventAt === undefined)
        return true;
    return now - lastEventAt >= cooldownMs;
}
/** Monitor event budget: auto-detach once exhausted. */
export function monitorBudgetExhausted(eventsFired, maxEvents) {
    return eventsFired >= maxEvents;
}
export function dispatchCompleted(facts) {
    if (facts.exited)
        return true;
    if (facts.now - facts.lastOutputAt >= facts.quietMs)
        return true;
    return facts.now - facts.startedAt >= facts.timeoutMs;
}
/**
 * Truncate an output tail to a byte-ish character budget, preserving the
 * most recent content and marking the cut.
 */
export function truncateTail(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    const head = text.slice(0, Math.floor(maxChars / 4));
    const tail = text.slice(text.length - Math.ceil(maxChars * 0.75));
    return `${head}\n…[${text.length - head.length - tail.length} chars omitted]…\n${tail}`;
}
/** A monitor trigger match against new output. */
export function triggerMatches(trigger, newText) {
    try {
        return new RegExp(trigger).test(newText);
    }
    catch {
        return false; // a malformed trigger never fires; fail closed, not loud
    }
}
/** Resolve the effective mode from tool args, falling back to the default. */
export function resolveMode(mode, defaultMode) {
    return mode ?? defaultMode;
}
//# sourceMappingURL=pure.js.map