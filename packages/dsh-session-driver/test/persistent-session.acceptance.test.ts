import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CompactionCapsule,
  DshHarnessPort,
  PortRunResult,
} from '../src/contracts.js'
import { PersistentDshSessionDriver } from '../src/driver.js'
import { WorkstreamRegistry } from '../src/registry.js'

const dirs: string[] = []

async function makeDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-accept-${label}-`))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const MARKER = 'ORCHID-17'
const SESSION_ID = 'session-persistent-v1'
const WORKSTREAM_ID = 'persistent-v1'
const PROMPT_1 = `Remember marker ${MARKER} and create the probe state.`
const PROMPT_2 = 'Use the marker from the previous operation and append :continued.'
const PROMPT_3 = 'Review correction: replace :continued with :reviewed.'

const usageEvent = (): unknown => ({
  type: 'assistant/message',
  data: {
    usage: {
      inputTokens: 40,
      outputTokens: 12,
      cacheReadTokens: 20,
      cacheWriteTokens: 4,
      reasoningTokens: 6,
    },
  },
})

/**
 * A stateful fake session: it only carries the marker context when the
 * previous prompt arrived on this exact object, so it rejects message two if
 * the driver ever started a fresh session or repeated the full context.
 */
class ProbeSession {
  readonly messages: string[] = []
  marker = ''

  async run(message: string): Promise<PortRunResult> {
    this.messages.push(message)
    const turn = this.messages.length

    if (turn === 1) {
      const markerMatch = /marker ([A-Z0-9-]+)/.exec(message)
      if (!markerMatch) throw new Error('probe session: first prompt must state a marker')
      if (message.includes(':continued') || message.includes(':reviewed')) {
        throw new Error('probe session: first prompt must not pre-append a suffix')
      }
      this.marker = markerMatch[1]!
      return {
        sessionId: SESSION_ID,
        finalResponse: `${this.marker} state created`,
        events: [usageEvent()],
        notifications: [],
      }
    }

    if (turn === 2) {
      if (!this.marker) throw new Error('probe session: second prompt lost the marker context')
      if (message.includes(this.marker)) {
        throw new Error('probe session: second prompt repeated the full context')
      }
      this.marker = `${this.marker}:continued`
      return {
        sessionId: SESSION_ID,
        finalResponse: this.marker,
        events: [usageEvent(), { type: 'compaction/end', data: {} }],
        notifications: [],
      }
    }

    if (turn === 3) {
      if (!this.marker.endsWith(':continued')) {
        throw new Error('probe session: review correction needs the :continued state')
      }
      this.marker = this.marker.replace(/:continued$/, ':reviewed')
      return {
        sessionId: SESSION_ID,
        finalResponse: this.marker,
        events: [usageEvent()],
        notifications: [],
      }
    }

    throw new Error('probe session: unexpected fourth prompt')
  }
}

const capsule = (): CompactionCapsule => ({
  schemaVersion: 1,
  objective: 'verify one DSH session across related prompts',
  completed: ['marker state created'],
  decisions: ['suffix continued by the same session'],
  currentState: {
    branch: 'feature/persistent-v1',
    worktree: process.cwd(),
    lastCommit: '0000000',
    dirtyFiles: [],
  },
  verification: ['pnpm test'],
  openIssues: [],
  nextAction: 'apply review correction',
})

describe('persistent session acceptance', () => {
  it('reuses one session object through two related operations and one review correction', async () => {
    const controllerRoot = await makeDir('root')
    const workspace = await makeDir('ws')
    const registry = new WorkstreamRegistry(controllerRoot)
    const probe = new ProbeSession()
    let harnessCreated = 0
    let sessionOpened = 0
    const harness: DshHarnessPort = {
      session() {
        sessionOpened += 1
        return probe
      },
      async close(): Promise<void> {},
    }
    const config = {
      schemaVersion: 1 as const,
      workstreamId: WORKSTREAM_ID,
      sessionId: SESSION_ID,
      branch: 'feature/persistent-v1',
      workspace,
      profile: 'sdk',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    }

    const driver = await PersistentDshSessionDriver.open({
      config,
      controllerRoot,
      harnessFactory: () => {
        harnessCreated += 1
        return harness
      },
      isPidAlive: () => true,
    })

    const first = await driver.send(PROMPT_1)
    const second = await driver.send(PROMPT_2)
    const capsulePath = await driver.saveCompactionCapsule(capsule())
    const third = await driver.send(PROMPT_3)

    // One runtime, one named session handle, three sequential prompts.
    expect(harnessCreated).toBe(1)
    expect(sessionOpened).toBe(1)
    expect(probe.messages).toEqual([PROMPT_1, PROMPT_2, PROMPT_3])

    // Context carried by the same session object: never repeated, final state reviewed.
    expect(first.finalResponse).toBe(`${MARKER} state created`)
    expect(second.finalResponse).toBe(`${MARKER}:continued`)
    expect(third.finalResponse).toBe(`${MARKER}:reviewed`)
    expect(probe.marker).toBe(`${MARKER}:reviewed`)
    expect(second.compactionObserved).toBe(true)
    expect(first.compactionObserved).toBe(false)
    expect(third.compactionObserved).toBe(false)
    for (const checkpoint of [first, second, third]) {
      expect(checkpoint.sessionId).toBe(SESSION_ID)
      expect(checkpoint.status).toBe('idle')
    }

    // Registry totals and capsule checkpoint survive on disk.
    const record = await registry.read(WORKSTREAM_ID)
    expect(record.status).toBe('idle')
    expect(record.promptCount).toBe(3)
    expect(record.compactCount).toBe(1)
    expect(record.usage).toEqual({
      inputTokens: 120,
      outputTokens: 36,
      cacheReadTokens: 60,
      cacheWriteTokens: 12,
      reasoningTokens: 18,
    })
    expect(record.lastCheckpoint).toBe(capsulePath)

    // The registry and capsule hold no prompt or marker material.
    const recordText = await readFile(
      join(controllerRoot, '.writex', 'dev', 'workstreams', `${WORKSTREAM_ID}.json`),
      'utf8',
    )
    expect(recordText).not.toContain(MARKER)
    expect(recordText).not.toContain(PROMPT_1)
    const capsuleText = await readFile(capsulePath, 'utf8')
    expect(capsuleText).not.toContain(MARKER)
    expect(capsuleText).not.toMatch(/api[_-]?key|secret|bearer/i)

    // Closing releases the workspace lock.
    await driver.close()
    await expect(readFile(join(workspace, '.writex', 'dev', 'driver.lock'), 'utf8')).rejects.toThrow(
      /ENOENT/,
    )
    expect((await registry.read(WORKSTREAM_ID)).status).toBe('closed')
  })
})
