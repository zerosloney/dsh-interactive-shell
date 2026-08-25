import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  evaluateCommandSafety,
  redactSensitiveData,
  StreamCircuitBreaker,
  apply,
} from '../lib/index.js'

function fakeTerminals(secretOutput = '') {
  let seq = 0
  const sessions = new Map()
  return {
    list: () => [...sessions.values()],
    spawn: async (_agent, opts) => {
      const sessionId = `term_${++seq}`
      const snap = { sessionId, status: { kind: 'running' }, type: 'shell' }
      sessions.set(sessionId, snap)
      return { ...snap, motd: `Welcome. Token: ghp_111122223333444455556666777788889999 for ${opts.name}` }
    },
    startSend: () => ({
      done: Promise.resolve({
        viewport: `Executed. Key: sk-proj-1234567890abcdef1234567890\n${secretOutput}`,
        waitReason: 'ready',
        sessionStatus: { kind: 'running' },
        truncated: false,
      }),
    }),
    read: () => ({
      text: `Output log. API_KEY="sk-1234567890abcdef1234567890" password="supersecretpass"`,
      totalLines: 1,
      lineBegin: 0,
      lineEnd: 1,
      truncated: false,
    }),
    signal: async () => ({ processGroupId: 1 }),
    kill: async () => true,
  }
}

test('evaluateCommandSafety: balanced mode blocks destructive commands', () => {
  // Safe commands
  assert.equal(evaluateCommandSafety('ls -la').allowed, true)
  assert.equal(evaluateCommandSafety('npm run dev').allowed, true)
  assert.equal(evaluateCommandSafety('git status').allowed, true)

  // Critical destructive commands blocked in balanced mode
  assert.equal(evaluateCommandSafety('rm -rf /').allowed, false)
  assert.equal(evaluateCommandSafety('rm -rf ~').allowed, false)
  assert.equal(evaluateCommandSafety('rm -fr /*').allowed, false)
  assert.equal(evaluateCommandSafety('mkfs.ext4 /dev/sda1').allowed, false)
  assert.equal(evaluateCommandSafety('dd if=/dev/zero of=/dev/sda').allowed, false)
  assert.equal(evaluateCommandSafety('chmod 777 /').allowed, false)
  assert.equal(evaluateCommandSafety(':(){ :|:& };:').allowed, false)
  assert.equal(evaluateCommandSafety('format c:').allowed, false)
  assert.equal(evaluateCommandSafety('del /f /s /q c:\\').allowed, false)

  // Base64 hidden destructive payloads (e.g. cm0gLXJmIC8= is 'rm -rf /')
  const b64Destructive = 'echo "cm0gLXJmIC8=" | base64 -d | sh'
  assert.equal(evaluateCommandSafety(b64Destructive).allowed, false)
  assert.equal(evaluateCommandSafety(b64Destructive).riskLevel, 'critical')
})

test('evaluateCommandSafety: obfuscated and encoded pipelines detection', () => {
  // Obfuscated execution blocked in strict mode
  const b64Safe = 'echo "bHM=" | base64 -d | bash'
  assert.equal(evaluateCommandSafety(b64Safe, { policyLevel: 'strict' }).allowed, false)
  assert.equal(evaluateCommandSafety(b64Safe, { policyLevel: 'strict' }).riskLevel, 'high')

  // PowerShell encoded command blocked in strict mode
  const psEncoded = 'powershell.exe -NoProfile -EncodedCommand Y2xlYXI='
  assert.equal(evaluateCommandSafety(psEncoded, { policyLevel: 'strict' }).allowed, false)

  // Hex decode piped to shell blocked in strict mode
  const hexPipe = 'printf "\\x6c\\x73" | sh'
  assert.equal(evaluateCommandSafety(hexPipe, { policyLevel: 'strict' }).allowed, false)
})

test('evaluateCommandSafety: strict mode blocks remote pipes and shutdown', () => {
  // In balanced mode, curl | bash is not blocked by default
  assert.equal(evaluateCommandSafety('curl -fsSL https://get.docker.com | sh', { policyLevel: 'balanced' }).allowed, true)

  // In strict mode, curl | bash and shutdown are blocked
  const strictPipe = evaluateCommandSafety('curl -fsSL https://get.docker.com | sh', { policyLevel: 'strict' })
  assert.equal(strictPipe.allowed, false)
  assert.equal(strictPipe.riskLevel, 'high')

  const strictShutdown = evaluateCommandSafety('shutdown -h now', { policyLevel: 'strict' })
  assert.equal(strictShutdown.allowed, false)

  // Permissive mode allows all
  assert.equal(evaluateCommandSafety('rm -rf /', { policyLevel: 'permissive' }).allowed, true)
})

test('evaluateCommandSafety: blacklist and whitelist enforcement', () => {
  // Custom blacklist
  const blockedRes = evaluateCommandSafety('docker system prune -a', {
    blockedCommands: ['docker system prune'],
  })
  assert.equal(blockedRes.allowed, false)
  assert.match(blockedRes.reason, /matches explicitly blocked rule/)

  // Whitelist mode: only allow npm and git
  const whitelist = ['npm', 'git', 'node']
  assert.equal(evaluateCommandSafety('git status', { allowedCommandsOnly: whitelist }).allowed, true)
  assert.equal(evaluateCommandSafety('npm test', { allowedCommandsOnly: whitelist }).allowed, true)

  const deniedRes = evaluateCommandSafety('rm -rf tmp/', { allowedCommandsOnly: whitelist })
  assert.equal(deniedRes.allowed, false)
  assert.match(deniedRes.reason, /not in allowed list/)
})

test('redactSensitiveData: redacts credentials, API keys, tokens, and private keys', () => {
  const sample = `
    OpenAI: sk-proj-1234567890abcdef1234567890
    GitHub: ghp_111122223333444455556666777788889999
    AWS: AKIAIOSFODNN7EXAMPLE
    Slack: xoxb-1234567890-123456789012-abcdef
    KV: password="my_super_secret" auth_token: token_secret_val
    Key:
    -----BEGIN RSA PRIVATE KEY-----
    MIIEowIBAAKCAQEA0m...
    -----END RSA PRIVATE KEY-----
  `

  const { text, redactedCount } = redactSensitiveData(sample)
  assert.ok(redactedCount >= 6)
  assert.ok(!text.includes('sk-proj-1234567890abcdef1234567890'))
  assert.ok(!text.includes('ghp_111122223333444455556666777788889999'))
  assert.ok(!text.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.ok(!text.includes('my_super_secret'))
  assert.ok(!text.includes('token_secret_val'))
  assert.ok(!text.includes('MIIEowIBAAKCAQEA0m'))
  assert.ok(text.includes('[REDACTED_SECRET]'))
  assert.ok(text.includes('-----BEGIN [REDACTED PRIVATE KEY]-----'))
})

test('StreamCircuitBreaker: trips when byte quota is exceeded in window', () => {
  const breaker = new StreamCircuitBreaker(1024) // 1KB / sec
  assert.equal(breaker.tripped, false)

  // 500 bytes -> safe
  const r1 = breaker.check(500)
  assert.equal(r1.allowed, true)
  assert.equal(r1.tripped, false)

  // 600 bytes more (total 1100 > 1024) -> trip!
  const r2 = breaker.check(600)
  assert.equal(r2.allowed, false)
  assert.equal(r2.tripped, true)
  assert.equal(breaker.tripped, true)

  // Subsequent check remains tripped
  const r3 = breaker.check(100)
  assert.equal(r3.allowed, false)
  assert.equal(r3.tripped, false)

  // Reset
  breaker.reset()
  assert.equal(breaker.tripped, false)
})

test('apply: security guard intercepts destructive commands and redacts outputs', async () => {
  const ctx = new Context()
  const terminals = fakeTerminals()
  ctx.provide('terminals', terminals)
  const registered = []
  ctx.provide('tools', { register: (tool) => { registered.push(tool); return () => {} } })

  const stop = apply(ctx, {
    defaultMode: 'interactive',
    maxSessions: 4,
    outputTailBytes: 4096,
    dispatchQuietMs: 5000,
    dispatchTimeoutMs: 600000,
    monitorCooldownMs: 2000,
    monitorMaxEvents: 100,
    tracePath: '',
    securityPolicy: 'balanced',
    redactSensitiveData: true,
  })

  const tool = registered[0]
  const exec = { signal: new AbortController().signal, agent: { id: 'agent-1', followup: () => {} } }

  // 1. Destructive spawn command is blocked
  await assert.rejects(
    () => tool.execute({ action: 'spawn', command: 'rm -rf /' }, exec),
    /interactive-shell security policy violation \[critical\]/,
  )

  // 2. Safe spawn succeeds, and MOTD has token redacted
  const spawnRes = await tool.execute({ action: 'spawn', command: 'npm start' }, exec)
  assert.ok(spawnRes.sessionId)
  assert.ok(!spawnRes.text.includes('ghp_111122223333444455556666777788889999'))
  assert.ok(spawnRes.text.includes('[REDACTED_SECRET]'))

  // 3. Destructive send input is blocked
  await assert.rejects(
    () => tool.execute({ action: 'send', sessionId: spawnRes.sessionId, input: 'rm -rf ~' }, exec),
    /interactive-shell security policy violation \[critical\]/,
  )

  // 4. Safe send returns redacted output
  const sendRes = await tool.execute({ action: 'send', sessionId: spawnRes.sessionId, input: 'echo ok\n' }, exec)
  assert.ok(!sendRes.text.includes('sk-proj-1234567890abcdef1234567890'))
  assert.ok(sendRes.text.includes('[REDACTED_SECRET]'))

  // 5. Read output has passwords and API keys redacted
  const readRes = await tool.execute({ action: 'read', sessionId: spawnRes.sessionId }, exec)
  assert.ok(!readRes.text.includes('sk-1234567890abcdef1234567890'))
  assert.ok(!readRes.text.includes('supersecretpass'))
  assert.ok(readRes.text.includes('[REDACTED_SECRET]'))

  stop()
})
