/**
 * Example: Terminal Session Recording & Time-Travel Engine with dsh-interactive-shell.
 *
 * Demonstrates:
 * 1. Recording terminal frames and outputs
 * 2. Simulating agent execution and human takeover
 * 3. Computing human-in-the-loop attribution percentages
 * 4. Exporting to standard Asciinema v2 (.cast) file for sharing and web playback
 *
 * Usage: node examples/demo-recorder.mjs
 */

import { SessionRecorder } from '../lib/index.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

console.log('🎥 === dsh-interactive-shell Recorder & Time-Travel Demo ===\n')

const recorder = new SessionRecorder()
const sessionId = 'demo_session_101'
const startTime = Date.now()

// 1. Initial agent command spawn
recorder.record({
  type: 'term:init',
  sessionId,
  command: 'pnpm build --filter @app/web',
  mode: 'interactive',
  motd: 'DeepSeek Harness PTY Initialized',
  time: startTime,
})

// 2. Agent output frames
recorder.record({
  type: 'term:output',
  sessionId,
  chunk: 'Building @app/web...\n',
  lineBegin: 0,
  lineEnd: 1,
  time: startTime + 300,
})

recorder.record({
  type: 'term:output',
  sessionId,
  chunk: 'Error: Module not found: "@components/Button"\n',
  lineBegin: 1,
  lineEnd: 2,
  time: startTime + 800,
})

// 3. User takes over terminal session
recorder.record({
  type: 'term:lock',
  sessionId,
  state: 'user_takeover',
  lockedBy: 'senior_developer',
  time: startTime + 1200,
})

// 4. User runs manual diagnostic
recorder.record({
  type: 'term:output',
  sessionId,
  chunk: '[user] nano src/components/index.ts\n',
  lineBegin: 2,
  lineEnd: 3,
  time: startTime + 1600,
})

recorder.record({
  type: 'term:output',
  sessionId,
  chunk: '[user] fixed export statement\n',
  lineBegin: 3,
  lineEnd: 4,
  time: startTime + 2400,
})

// 5. User releases lock back to agent
recorder.record({
  type: 'term:lock',
  sessionId,
  state: 'agent_driving',
  summary: 'Added export * from ./Button to index.ts',
  time: startTime + 3000,
})

// 6. Agent retries build
recorder.record({
  type: 'term:output',
  sessionId,
  chunk: 'Retrying build: 100% completed in 1.2s\n',
  lineBegin: 4,
  lineEnd: 5,
  time: startTime + 3600,
})

recorder.record({
  type: 'term:exit',
  sessionId,
  exitCode: 0,
  time: startTime + 4000,
})

// === Inspect Timeline Attribution ===
const segments = recorder.getTimelineAttribution(sessionId)
console.log('📊 Timeline Attribution Segments:')
for (const seg of segments) {
  const duration = ((seg.endTime - seg.startTime) / 1000).toFixed(1)
  console.log(`   - Actor: [${seg.actor.toUpperCase()}] Duration: ${duration}s (LockedBy: ${seg.lockedBy ?? 'agent'})`)
}

// === Time-Travel Snapshot Replay ===
console.log('\n⏳ Time-Travel Snapshot (at T+1.0s, during agent error):')
const snapAgent = recorder.getTimeTravelSnapshot(sessionId, startTime + 1000)
console.log(snapAgent.map((l) => `   | ${l}`).join('\n'))

console.log('\n⏳ Time-Travel Snapshot (at T+2.5s, during human takeover):')
const snapHuman = recorder.getTimeTravelSnapshot(sessionId, startTime + 2500)
console.log(snapHuman.map((l) => `   | ${l}`).join('\n'))

// === Export Asciinema v2 (.cast) ===
const castFile = join(tmpdir(), 'dsh-demo-session.cast')
const castContent = recorder.exportAsciinema(sessionId, {
  title: 'DeepSeek Harness Human-in-the-Loop Takeover Demo',
  width: 100,
  height: 25,
})
writeFileSync(castFile, castContent, 'utf8')
console.log(`\n🎬 Exported Asciinema v2 .cast file to: ${castFile}`)
console.log('   (Can be played with: npx asciinema play ' + castFile + ')')

console.log('\n✅ Recorder and Time-Travel demo completed successfully!')
