/**
 * Credential-gated live probe for the persistent DSH session driver.
 *
 * Without `--live` this script only prints a skip notice and exits — it never
 * starts a harness runtime or makes a model call. With `--live` it opens one
 * real driver (`deepseek-official` / `deepseek-v4-flash`, high effort) and
 * proves session reuse through two related prompts plus one review
 * correction, exactly like the deterministic acceptance test but against the
 * real DeepSeek Harness SDK.
 *
 * Run: pnpm test:dsh-live -- --live
 * Cost: model calls on the configured DeepSeek account are paid.
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { PersistentDshSessionDriver } from '../../packages/dsh-session-driver/src/driver.js'
import { createOfficialDshHarness } from '../../packages/dsh-session-driver/src/sdk-adapter.js'
import { removeVerifiedProbeTempDir } from './safe-temp-cleanup.js'

const live = process.argv.includes('--live')

if (!live) {
  console.log('dsh-session-probe: skipped (pass --live for a paid live run)')
  process.exit(0)
}

const marker = randomBytes(8).toString('hex')
const sessionId = 'session-dsh-live-probe'
const workstreamId = 'dsh-live-probe'
const probeFile = 'session-probe.txt'

let exitCode = 0
let driver: PersistentDshSessionDriver | undefined
let controllerRoot: string | undefined
let workspace: string | undefined
try {
  controllerRoot = await mkdtemp(join(tmpdir(), 'dsh-live-root-'))
  workspace = await mkdtemp(join(tmpdir(), 'dsh-live-ws-'))

  driver = await PersistentDshSessionDriver.open({
    controllerRoot,
    harnessFactory: createOfficialDshHarness,
    config: {
      schemaVersion: 1,
      workstreamId,
      sessionId,
      branch: 'feature/dsh-session-live-probe',
      workspace,
      profile: 'sdk',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      maxTokens: 2048,
    },
  })

  const first = await driver.send(
    `Write the marker ${marker} alone into ${probeFile} inside the workspace and report the marker you wrote.`,
  )
  const second = await driver.send(
    'Without repeating any marker, read the probe file and append the suffix :continued to its content.',
  )
  const third = await driver.send(
    'Review correction: read the probe file again and replace the :continued suffix with :reviewed.',
  )

  for (const [index, checkpoint] of [first, second, third].entries()) {
    if (checkpoint.sessionId !== sessionId) {
      throw new Error(`checkpoint ${index + 1} changed session to ${checkpoint.sessionId}`)
    }
  }

  const finalContent = await readFile(join(workspace, probeFile), 'utf8')
  const expected = `${marker}:reviewed`
  if (finalContent.trim() !== expected) {
    throw new Error(`probe file is ${JSON.stringify(finalContent.trim())}, expected ${expected}`)
  }

  await driver.saveCompactionCapsule({
    schemaVersion: 1,
    objective: 'persistent DSH session live probe',
    completed: ['one named session survived three prompts'],
    decisions: ['session reuse keeps context without repeating prompts'],
    currentState: {
      branch: 'feature/dsh-session-live-probe',
      worktree: workspace,
      lastCommit: 'unknown',
      dirtyFiles: [],
    },
    verification: ['probe file equals marker:reviewed'],
    openIssues: [],
    nextAction: 'review by Codex',
  })

  console.log('dsh-session-probe: ok', {
    marker,
    sessionId,
    finalResponse: third.finalResponse,
    prompts: 3,
  })
} catch (error) {
  exitCode = 1
  console.error('dsh-session-probe: failed', error instanceof Error ? error.message : error)
} finally {
  if (driver) {
    try {
      await driver.close()
    } catch (closeError) {
      exitCode = 1
      console.error('dsh-session-probe: close failed', closeError)
    }
  }
  const cleanups = await Promise.allSettled([
    removeVerifiedProbeTempDir(controllerRoot, 'dsh-live-root-'),
    removeVerifiedProbeTempDir(workspace, 'dsh-live-ws-'),
  ])
  for (const cleanup of cleanups) {
    if (cleanup.status === 'rejected') {
      exitCode = 1
      console.error('dsh-session-probe: cleanup failed', cleanup.reason)
    }
  }
}

process.exit(exitCode)
