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
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TerminalSessionService } from '@deepseek-ai/dsh-terminal';
/** Actionable failure text for a call whose agent resolves to no PTY registry. */
export declare const PTY_UNAVAILABLE_MESSAGE: string;
/** Failure text for a call with no calling agent (every seam call is owner-verified). */
export declare const NO_AGENT_MESSAGE: string;
/**
 * Resolve the PTY registry one agent's tool calls must use.
 *
 * @param ctx - the bridge's plugin context.
 * @param agent - the exact agent executing the tool call.
 * @returns the agent's preset-scoped registry, the bridge context's registry, or `undefined` when the agent mounts none.
 */
export declare function resolveTerminals(ctx: Context, agent: Agent): TerminalSessionService | undefined;
/**
 * Resolve the PTY registry for one tool call or throw the actionable reason.
 *
 * @param ctx - the bridge's plugin context.
 * @param agent - the exact agent executing the tool call.
 * @returns the resolved, owner-verifying PTY registry.
 * @throws Error naming the missing PTY composition.
 */
export declare function requireTerminals(ctx: Context, agent: Agent): TerminalSessionService;
