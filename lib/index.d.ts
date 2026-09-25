import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
import type { ShellMode } from './pure.js';
import { StreamHub } from './stream.js';
import type { TermFrame } from './stream.js';
export * from './stream.js';
export * from './client.js';
export * from './ui.js';
export * from './security.js';
export * from './component.js';
export * from './transport.js';
export * from './recorder.js';
export * from './prompts.js';
import type { SecurityPolicyLevel } from './security.js';
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
    /** JSONL 事件台账路径；空 = `$DSH_HOME`/`~/.dsh` 下的 interactive-shell/traces.jsonl。 */
    tracePath: string;
    /**
     * Registered PTY backend type for new sessions (`terminal-bash.backendType`,
     * default `shell`). Omitted rows fall back in code because a directly
     * applied config carries no schema defaults.
     */
    backendType?: string;
    /** Output bytes/second mirrored to stream clients before frames are throttled (default 512 KB/s). */
    maxOutputBytesPerSec?: number;
    /** Global security policy level ('permissive' | 'balanced' | 'strict'). */
    securityPolicy?: SecurityPolicyLevel;
    /** List of command prefixes or regexes to block. */
    blockedCommands?: string[];
    /** Whitelist of permitted command prefixes (empty = all allowed). */
    allowedCommandsOnly?: string[];
    /** Whether to redact sensitive API keys and secrets (default: true). */
    redactSensitiveData?: boolean;
}
export declare const Config: z<Config>;
declare module '@deepseek-ai/cordis' {
    interface Context {
        interactiveShellStream: StreamHub;
    }
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
        /** A streaming frame was broadcasted to Web UI / stream subscribers (Phase 1). */
        'interactive-shell/stream-frame'(frame: TermFrame): void;
        /** Takeover lock status changed between Agent and User (Phase 1). */
        'interactive-shell/lock-changed'(payload: {
            sessionId: string;
            state: 'agent_driving' | 'user_takeover';
            lockedBy?: string;
        }): void;
    }
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /**
         * Wake-up notices this bridge injects into its owning agent's conversation.
         *
         * dsh 0.1.7 retired the catch-all `plugin` kind (session format v4 refuses
         * it outright), so every producer declares its own kind here.
         */
        'interactive-shell': {
            kind: 'interactive-shell';
        } & ContextFormed;
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
