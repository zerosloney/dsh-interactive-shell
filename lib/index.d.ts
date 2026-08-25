/**
 * dsh-interactive-shell: the agent drives real interactive CLIs over the
 * harness `ctx.terminals` PTY seam — a port of pi-interactive-shell's
 * Monitor/Dispatch product layer onto DeepSeek Harness.
 *
 * One `interactive_shell` tool with an `action` field (spawn / send / status
 * / read / kill / attach-monitor), not one tool per verb — the per-request
 * schema-budget lesson from the Pi-vs-DSH benchmark. Modes:
 *
 * - interactive: stable sessionId; agent sends input, checks status.
 * - hands-free: agent polls and receives quiet-window output tails.
 * - dispatch:   fire-and-forget; the agent is woken once on completion
 *               (exit / quiet / timeout / kill) with the output tail.
 * - monitor:    event-driven wake-up on stream triggers or file watching —
 *               zero polling between events.
 *
 * @module dsh-interactive-shell
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ShellMode } from './pure.js';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "interactive-shell";
/**
 * `terminals` is an optional dependency: the bridge activates without a PTY
 * backend (e.g. headless profiles that do not mount dsh-terminal) and simply
 * registers no tool, rather than failing the whole composition. `tools` is
 * required — the registry is the bridge's only reason to exist.
 */
export declare const inject: string[];
/** Plugin configuration; every field maps to a row in cordis.patch.yml. */
export interface Config {
    defaultMode: ShellMode;
    maxSessions: number;
    outputTailBytes: number;
    dispatchQuietMs: number;
    dispatchTimeoutMs: number;
    monitorCooldownMs: number;
    monitorMaxEvents: number;
}
export declare const Config: z<Config>;
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** A session spawned by this bridge became live. */
        'interactive-shell/session-started'(payload: {
            sessionId: string;
            mode: ShellMode;
            command: string;
        }): void;
        /** A dispatch session completed; the agent should be woken once. */
        'interactive-shell/dispatch-completed'(payload: {
            sessionId: string;
            exitCode: number | null;
            tail: string;
        }): void;
        /** A monitor trigger fired; the agent should be woken. */
        'interactive-shell/monitor-triggered'(payload: {
            sessionId: string;
            trigger: string;
            tail: string;
        }): void;
    }
}
/**
 * Mount the interactive-shell bridge: register the single dispatch tool and
 * wire session lifecycle events.
 *
 * @param ctx - plugin context carrying terminals and tools services.
 * @param config - resolved plugin configuration.
 */
export declare function apply(ctx: Context, config: Config): () => void;
