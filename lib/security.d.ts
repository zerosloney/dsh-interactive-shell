/**
 * Security Guardrails, Sensitive Data Redaction, and Circuit Breakers for dsh-interactive-shell.
 *
 * @module
 */
export type SecurityPolicyLevel = 'permissive' | 'balanced' | 'strict';
export interface SecurityConfig {
    /** Global security policy level (default: 'balanced'). */
    policyLevel?: SecurityPolicyLevel;
    /** Explicit list of command prefixes or regex patterns to block unconditionally. */
    blockedCommands?: string[];
    /** If provided (non-empty), only commands matching these prefixes are allowed (Whitelisting). */
    allowedCommandsOnly?: string[];
    /** Whether to redact sensitive API keys, tokens, and credentials in logs and model outputs (default: true). */
    redactSensitiveData?: boolean;
    /** Custom redaction regular expressions. */
    customRedactPatterns?: RegExp[];
    /** Max output bytes allowed per second before circuit-breaker throttling (default: 512 KB/s). */
    maxOutputBytesPerSec?: number;
}
export interface CommandSafetyResult {
    allowed: boolean;
    riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical';
    reason?: string;
}
/**
 * Evaluate safety of a proposed CLI command string.
 */
export declare function evaluateCommandSafety(command: string, config?: SecurityConfig): CommandSafetyResult;
export interface RedactionResult {
    text: string;
    redactedCount: number;
}
/**
 * Redact sensitive secrets (tokens, keys, passwords) from text.
 */
export declare function redactSensitiveData(text: string, customPatterns?: RegExp[]): RedactionResult;
/**
 * Terminal stream output rate limiter / circuit breaker to guard against catastrophic stdout flooding.
 */
export declare class StreamCircuitBreaker {
    private readonly maxBytesPerSec;
    private byteCount;
    private windowStart;
    private isTripped;
    constructor(maxBytesPerSec?: number);
    /**
     * Process incoming chunk bytes. Returns true if safe, false if circuit breaker tripped.
     */
    check(chunkLength: number): {
        allowed: boolean;
        tripped: boolean;
        droppedBytes: number;
    };
    /** Reset circuit breaker. */
    reset(): void;
    get tripped(): boolean;
}
