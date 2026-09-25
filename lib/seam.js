/**
 * PTY seam resolution for dsh-interactive-shell.
 *
 * The persistent PTY family stopped being a host-plane service: since dsh
 * 0.1.7 `@deepseek-ai/dsh-terminal` + `@deepseek-ai/dsh-terminal-bash` are
 * mounted by an agent preset behind an `isolate` realm, so a host row cannot
 * `inject(['terminals'])` — injection resolves before any session, and
 * therefore any agent, exists. Addressing is per call, keyed by the exact
 * calling agent (`Agent.ctx`):
 *
 * 1. `ctx.agentPresets.serviceFor(agent, 'terminals')` — the agent's own
 *    preset revision, the documented read addressing for a caller that holds
 *    the agent outside that realm.
 * 2. `ctx.get('terminals')` — the bridge's own context, which resolves when
 *    the bridge row is mounted beside the PTY provider (same realm), or on a
 *    host that still publishes a host-plane registry.
 *
 * A miss is never silent: the tool call fails with the installation guidance,
 * because "no PTY backend anywhere" can only be decided at call time now.
 *
 * @module dsh-interactive-shell/seam
 */
import { Context } from '@deepseek-ai/cordis';
/** Actionable failure text for a call whose agent resolves to no PTY registry. */
export const PTY_UNAVAILABLE_MESSAGE = 'interactive_shell found no persistent PTY registry for this agent. Since dsh 0.1.7 the PTY family ' +
    'is mounted by an agent preset, not by the host: select/author a preset whose plugins mount ' +
    "'@deepseek-ai/dsh-terminal' with a '@deepseek-ai/dsh-terminal-bash' backend (the shipped 'minimal' " +
    'preset mounts both inside its persistent-shell group), or mount this bridge row inside that same ' +
    'isolate realm.';
/** Failure text for a call with no calling agent (every seam call is owner-verified). */
export const NO_AGENT_MESSAGE = 'interactive_shell requires a calling agent: every PTY session is owner-scoped and this bridge never ' +
    'substitutes a synthetic owner.';
/**
 * Resolve the PTY registry one agent's tool calls must use.
 *
 * @param ctx - the bridge's plugin context.
 * @param agent - the exact agent executing the tool call.
 * @returns the agent's preset-scoped registry, the bridge context's registry, or `undefined` when the agent mounts none.
 */
export function resolveTerminals(ctx, agent) {
    const presets = ctx.get('agentPresets');
    // A real Agent always carries a cordis context; a test double may not.
    if (presets !== undefined && Context.is(agent.ctx)) {
        const scoped = presets.serviceFor(agent, 'terminals');
        if (scoped !== undefined)
            return scoped;
    }
    return ctx.get('terminals');
}
/**
 * Resolve the PTY registry for one tool call or throw the actionable reason.
 *
 * @param ctx - the bridge's plugin context.
 * @param agent - the exact agent executing the tool call.
 * @returns the resolved, owner-verifying PTY registry.
 * @throws Error naming the missing PTY composition.
 */
export function requireTerminals(ctx, agent) {
    const term = resolveTerminals(ctx, agent);
    if (term === undefined)
        throw new Error(PTY_UNAVAILABLE_MESSAGE);
    return term;
}
//# sourceMappingURL=seam.js.map