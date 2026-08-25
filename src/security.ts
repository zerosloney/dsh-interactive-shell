/**
 * Security Guardrails, Sensitive Data Redaction, and Circuit Breakers for dsh-interactive-shell.
 *
 * @module
 */

export type SecurityPolicyLevel = 'permissive' | 'balanced' | 'strict'

export interface SecurityConfig {
  /** Global security policy level (default: 'balanced'). */
  policyLevel?: SecurityPolicyLevel
  /** Explicit list of command prefixes or regex patterns to block unconditionally. */
  blockedCommands?: string[]
  /** If provided (non-empty), only commands matching these prefixes are allowed (Whitelisting). */
  allowedCommandsOnly?: string[]
  /** Whether to redact sensitive API keys, tokens, and credentials in logs and model outputs (default: true). */
  redactSensitiveData?: boolean
  /** Custom redaction regular expressions. */
  customRedactPatterns?: RegExp[]
  /** Max output bytes allowed per second before circuit-breaker throttling (default: 512 KB/s). */
  maxOutputBytesPerSec?: number
}

/** Pre-compiled high-risk command patterns (POSIX & Windows). */
const CRITICAL_DESTRUCTIVE_PATTERNS = [
  // rm -rf / or rm -rf /* or rm -rf ~
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+([/~*]|\$HOME)/i,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+([/~*]|\$HOME)/i,
  // mkfs formatting
  /\bmkfs(\.[a-zA-Z0-9]+)?\s+/i,
  // dd writing directly to root raw block devices
  /\bdd\s+.*of=\/dev\/(sd[a-z]|nvme\d+n\d+|hd[a-z]|vd[a-z])/i,
  // chmod 777 root
  /\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?(777|0777)\s+([/~]|\$HOME)/i,
  // bash fork bomb
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // Windows destructive format or recursive system delete
  /\bformat\s+[a-zA-Z]:/i,
  /\bdel\s+(?:\/[a-zA-Z]+\s*)+[a-zA-Z]:\\/i,
]

/** Patterns detecting dangerous obfuscated/encoded execution pipelines. */
const OBFUSCATION_PATTERNS = [
  // base64 decoded and piped into a shell interpreter (e.g. echo ... | base64 -d | sh)
  /\bbase64\s+(?:-d|--decode)\b[^|]*\|\s*(?:sh|bash|zsh|pwsh|powershell|cmd)/i,
  // Windows certutil decode / decodehex
  /\bcertutil\s+(?:-decode|-decodehex)\b/i,
  // PowerShell -EncodedCommand / -enc
  /\b(?:powershell|pwsh)(?:\.exe)?\s+(?:-[a-zA-Z]+\s+)*(?:-e|-enc|-encodedcommand)\s+[a-zA-Z0-9+/=]{8,}/i,
  // Hex/Printf decode piped to shell
  /\b(?:xxd\s+-r|printf\s+['"][^'"]*\\x[0-9a-fA-F]{2})[^|]*\|\s*(?:sh|bash|zsh|pwsh|cmd)/i,
  // Inline Python/Node base64 execution
  /\b(?:python[23]?|node)\s+(?:-e|-c)\s+['"][^'"]*(?:b64decode|Buffer\.from|atob|eval\()/i,
]

/** Patterns considered dangerous in 'strict' mode. */
const STRICT_DANGEROUS_PATTERNS = [
  // Pipe remote scripts straight to shell (curl | sh, wget | bash)
  /\b(curl|wget)\s+[^|]+\|\s*(sh|bash|zsh|pwsh|cmd)/i,
  // System shutdown / reboot
  /\b(shutdown|reboot|init\s+0|init\s+6|halt|poweroff)\b/i,
  // Modifying system passwd/shadow directly
  /\b(chpasswd|userdel|groupdel)\b/i,
]

export interface CommandSafetyResult {
  allowed: boolean
  riskLevel: 'safe' | 'low' | 'medium' | 'high' | 'critical'
  reason?: string
}

/**
 * Evaluate safety of a proposed CLI command string.
 */
export function evaluateCommandSafety(
  command: string,
  config: SecurityConfig = {},
): CommandSafetyResult {
  const trimmed = command.trim()
  if (!trimmed) {
    return { allowed: true, riskLevel: 'safe' }
  }

  const policy = config.policyLevel ?? 'balanced'

  // 1. Whitelist check (if configured)
  if (config.allowedCommandsOnly && config.allowedCommandsOnly.length > 0) {
    const isWhitelisted = config.allowedCommandsOnly.some((allowed) => {
      const prefix = allowed.trim()
      return trimmed === prefix || trimmed.startsWith(prefix + ' ')
    })
    if (!isWhitelisted) {
      return {
        allowed: false,
        riskLevel: 'high',
        reason: `Command not in allowed list: '${trimmed.slice(0, 40)}'`,
      }
    }
  }

  // 2. Explicit blacklist patterns
  if (config.blockedCommands && config.blockedCommands.length > 0) {
    for (const blocked of config.blockedCommands) {
      if (trimmed === blocked || trimmed.startsWith(blocked + ' ') || new RegExp(blocked, 'i').test(trimmed)) {
        return {
          allowed: false,
          riskLevel: 'critical',
          reason: `Command matches explicitly blocked rule: '${blocked}'`,
        }
      }
    }
  }

  // 3. Permissive mode skips default heuristics
  if (policy === 'permissive') {
    return { allowed: true, riskLevel: 'low' }
  }

  // 4. Balanced & Strict: Check Critical Destructive Patterns
  for (const pattern of CRITICAL_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        riskLevel: 'critical',
        reason: `Blocked potentially destructive system command matching ${pattern}`,
      }
    }
  }

  // 5. Deep inspection of obfuscated/base64 encoded commands
  for (const pattern of OBFUSCATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      // Try to decode embedded base64 token
      const b64Match = trimmed.match(/[a-zA-Z0-9+/=]{12,}/)
      if (b64Match) {
        try {
          const raw = b64Match[0]
          const utf8Decoded = Buffer.from(raw, 'base64').toString('utf8')
          const utf16Decoded = Buffer.from(raw, 'base64').toString('utf16le')

          for (const crit of CRITICAL_DESTRUCTIVE_PATTERNS) {
            if (crit.test(utf8Decoded) || crit.test(utf16Decoded)) {
              return {
                allowed: false,
                riskLevel: 'critical',
                reason: `Blocked potentially destructive command hidden inside encoded payload (matching ${crit})`,
              }
            }
          }
        } catch {
          // Ignore decoding error
        }
      }

      if (policy === 'strict') {
        return {
          allowed: false,
          riskLevel: 'high',
          reason: `Command violates strict safety policy: matches obfuscated execution pattern ${pattern}`,
        }
      }
    }
  }

  // 6. Strict mode extra heuristics
  if (policy === 'strict') {
    for (const pattern of STRICT_DANGEROUS_PATTERNS) {
      if (pattern.test(trimmed)) {
        return {
          allowed: false,
          riskLevel: 'high',
          reason: `Command violates strict safety policy: matches ${pattern}`,
        }
      }
    }
  }

  return { allowed: true, riskLevel: 'safe' }
}

/** Pre-compiled sensitive credential regex patterns. */
const DEFAULT_REDACTION_PATTERNS: RegExp[] = [
  // OpenAI & DeepSeek API keys (sk-...)
  /\bsk-[a-zA-Z0-9_-]{20,}\b/g,
  // GitHub Tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
  /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36}\b/g,
  /\bgithub_pat_[a-zA-Z0-9_]{50,}\b/g,
  // AWS Access Key ID
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Slack Tokens
  /\bxox[baprs]-[0-9a-zA-Z]{10,48}\b/g,
  // JWT tokens (eyJ...)
  /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
  // Private Key Blocks
  /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]+ PRIVATE KEY-----/g,
  // Generic password/secret assignments: password="xyz" / auth_token: xyz
  /(?<=\b(?:password|passwd|secret|api_key|apikey|auth_token|access_token)\s*[:=]\s*['"]?)[^\s'"&;,]{4,}(?=['"]?)/gi,
]

export interface RedactionResult {
  text: string
  redactedCount: number
}

/**
 * Redact sensitive secrets (tokens, keys, passwords) from text.
 */
export function redactSensitiveData(
  text: string,
  customPatterns: RegExp[] = [],
): RedactionResult {
  if (!text) return { text: '', redactedCount: 0 }

  let output = text
  let count = 0
  const patterns = [...DEFAULT_REDACTION_PATTERNS, ...customPatterns]

  for (const pattern of patterns) {
    // Ensure global flag
    const regex = pattern.global ? pattern : new RegExp(pattern.source, pattern.flags + 'g')
    output = output.replace(regex, (match) => {
      count++
      if (match.startsWith('-----BEGIN')) {
        return '-----BEGIN [REDACTED PRIVATE KEY]-----'
      }
      return '[REDACTED_SECRET]'
    })
  }

  return { text: output, redactedCount: count }
}

/**
 * Terminal stream output rate limiter / circuit breaker to guard against catastrophic stdout flooding.
 */
export class StreamCircuitBreaker {
  private readonly maxBytesPerSec: number
  private byteCount = 0
  private windowStart = Date.now()
  private isTripped = false

  constructor(maxBytesPerSec = 512 * 1024) {
    this.maxBytesPerSec = maxBytesPerSec
  }

  /**
   * Process incoming chunk bytes. Returns true if safe, false if circuit breaker tripped.
   */
  check(chunkLength: number): { allowed: boolean; tripped: boolean; droppedBytes: number } {
    const now = Date.now()
    if (now - this.windowStart >= 1000) {
      this.byteCount = 0
      this.windowStart = now
      this.isTripped = false
    }

    this.byteCount += chunkLength

    if (this.byteCount > this.maxBytesPerSec) {
      const wasTripped = this.isTripped
      this.isTripped = true
      return {
        allowed: false,
        tripped: !wasTripped, // true only on first trip transition
        droppedBytes: chunkLength,
      }
    }

    return { allowed: true, tripped: false, droppedBytes: 0 }
  }

  /** Reset circuit breaker. */
  reset(): void {
    this.byteCount = 0
    this.windowStart = Date.now()
    this.isTripped = false
  }

  get tripped(): boolean {
    return this.isTripped
  }
}
