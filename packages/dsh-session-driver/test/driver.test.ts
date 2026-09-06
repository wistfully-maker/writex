import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CompactionCapsule,
  DshHarnessPort,
  DshSessionPort,
  PortRunResult,
  UsageSummary,
} from '../src/contracts.js'
import { PersistentDshSessionDriver } from '../src/driver.js'
import { WorkstreamRegistry } from '../src/registry.js'

const dirs: string[] = []

async function makeDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `dsh-driver-${label}-`))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

afterEach(() => {
  vi.restoreAllMocks()
})

const SESSION_ID = 'session-driver-v1'
const WORKSTREAM_ID = 'driver-v1'

const usage = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  ...over,
})

const messageEvent = (over: Partial<UsageSummary> = {}): unknown => ({
  type: 'assistant/message',
  data: { usage: usage(over) },
})

interface FakeSession extends DshSessionPort {
  sessionId: string
  messages: string[]
}

interface FakeHarness extends DshHarnessPort {
  sessions: FakeSession[]
  closeCount: number
}

function makeFakeHarness(run: (message: string) => Promise<PortRunResult>): FakeHarness {
  const sessions: FakeSession[] = []
  return {
    sessions,
    closeCount: 0,
    session(id: string): FakeSession {
      const existing = sessions.find((session) => session.sessionId === id)
      if (existing) return existing
      const session: FakeSession = {
        sessionId: id,
        messages: [],
        async run(message: string): Promise<PortRunResult> {
          session.messages.push(message)
          return run(message)
        },
      }
      sessions.push(session)
      return session
    },
    async close(): Promise<void> {
      this.closeCount += 1
    },
  }
}

const defaultRun = async (message: string): Promise<PortRunResult> => ({
  sessionId: SESSION_ID,
  finalResponse: `handled: ${message}`,
  events: [
    messageEvent({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 10,
      reasoningTokens: 12,
    }),
  ],
  notifications: [{ type: 'notice' }],
})

const config = (workspace: string): Record<string, unknown> => ({
  schemaVersion: 1,
  workstreamId: WORKSTREAM_ID,
  sessionId: SESSION_ID,
  branch: 'feature/driver-v1',
  workspace,
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 8192,
})

async function setup(run: (message: string) => Promise<PortRunResult> = defaultRun) {
  const controllerRoot = await makeDir('root')
  const workspace = await makeDir('ws')
  const harness = makeFakeHarness(run)
  const driver = await PersistentDshSessionDriver.open({
    config: config(workspace),
    controllerRoot,
    harnessFactory: () => harness,
    now: () => '2026-09-06T12:00:00.000Z',
    isPidAlive: () => true,
  })
  return {
    driver,
    harness,
    controllerRoot,
    workspace,
    registry: new WorkstreamRegistry(controllerRoot),
  }
}

const capsule = (): CompactionCapsule => ({
  schemaVersion: 1,
  objective: 'finish driver lifecycle',
  completed: ['contracts validated'],
  decisions: ['one writer per workspace'],
  currentState: {
    branch: 'feature/driver-v1',
    worktree: process.cwd(),
    lastCommit: '0000000',
    dirtyFiles: [],
  },
  verification: ['pnpm typecheck', 'pnpm test'],
  openIssues: [],
  nextAction: 'verify acceptance',
})

describe('PersistentDshSessionDriver', () => {
  it('open() creates one harness, one named session, one lock, and an idle registry record', async () => {
    const { driver, harness, workspace, controllerRoot } = await setup()

    expect(harness.sessions).toHaveLength(1)
    expect(harness.sessions[0]!.sessionId).toBe(SESSION_ID)
    const lockText = await readFile(join(workspace, '.writex', 'dev', 'driver.lock'), 'utf8')
    expect(JSON.parse(lockText)).toMatchObject({ schemaVersion: 1, workstreamId: WORKSTREAM_ID })
    const record = await new WorkstreamRegistry(controllerRoot).read(WORKSTREAM_ID)
    expect(record).toMatchObject({
      schemaVersion: 1,
      workstreamId: WORKSTREAM_ID,
      sessionId: SESSION_ID,
      model: 'deepseek-v4-flash',
      branch: 'feature/driver-v1',
      status: 'idle',
      promptCount: 0,
      compactCount: 0,
    })

    await driver.close()
  })

  it('reuses exactly one session object across sequential sends and accumulates usage', async () => {
    const { driver, harness, controllerRoot } = await setup()

    const checkpoints = []
    for (const message of ['first operation', 'second operation', 'third operation']) {
      checkpoints.push(await driver.send(message))
    }

    expect(harness.sessions).toHaveLength(1)
    const session = harness.sessions[0]!
    expect(session.messages).toEqual(['first operation', 'second operation', 'third operation'])
    expect(checkpoints.map((cp) => cp.finalResponse)).toEqual([
      'handled: first operation',
      'handled: second operation',
      'handled: third operation',
    ])
    for (const cp of checkpoints) {
      expect(cp).toMatchObject({
        workstreamId: WORKSTREAM_ID,
        sessionId: SESSION_ID,
        status: 'idle',
        eventCount: 1,
        notificationCount: 1,
      })
    }
    expect(checkpoints[2]!.usage).toEqual(
      usage({
        inputTokens: 360,
        outputTokens: 90,
        cacheReadTokens: 240,
        cacheWriteTokens: 30,
        reasoningTokens: 36,
      }),
    )

    const record = await new WorkstreamRegistry(controllerRoot).read(WORKSTREAM_ID)
    expect(record.promptCount).toBe(3)
    expect(record.compactCount).toBe(0)
    expect(record.usage).toEqual(
      usage({
        inputTokens: 360,
        outputTokens: 90,
        cacheReadTokens: 240,
        cacheWriteTokens: 30,
        reasoningTokens: 36,
      }),
    )

    await driver.close()
  })

  it('records an automatic compaction/end event as compactCount', async () => {
    const { driver, controllerRoot } = await setup(async (message) => ({
      sessionId: SESSION_ID,
      finalResponse: `ok: ${message}`,
      events:
        message === 'compress now'
          ? [messageEvent(), { type: 'compaction/end', data: {} }]
          : [messageEvent()],
      notifications: [],
    }))

    const plain = await driver.send('plain run')
    expect(plain.compactionObserved).toBe(false)
    const compacted = await driver.send('compress now')
    expect(compacted.compactionObserved).toBe(true)

    const record = await new WorkstreamRegistry(controllerRoot).read(WORKSTREAM_ID)
    expect(record.compactCount).toBe(1)
    expect(record.promptCount).toBe(2)

    await driver.close()
  })

  it('sets the registry status to blocked and preserves the original error on failure', async () => {
    const { driver, controllerRoot } = await setup(async () => {
      throw new Error('model call failed')
    })

    await expect(driver.send('boom')).rejects.toThrow('model call failed')

    const record = await new WorkstreamRegistry(controllerRoot).read(WORKSTREAM_ID)
    expect(record.status).toBe('blocked')
    expect(record.promptCount).toBe(0)

    await driver.close()
  })

  it('resets the busy flag when the busy-status registry write fails, so a later send succeeds', async () => {
    const { driver, controllerRoot } = await setup()

    vi.spyOn(WorkstreamRegistry.prototype, 'update').mockImplementationOnce(async () => {
      throw new Error('registry busy write failed')
    })

    await expect(driver.send('first operation')).rejects.toThrow('registry busy write failed')

    await expect(driver.send('second operation')).resolves.toMatchObject({ status: 'idle' })

    const record = await new WorkstreamRegistry(controllerRoot).read(WORKSTREAM_ID)
    expect(record.status).toBe('idle')
    expect(record.promptCount).toBe(1)

    await driver.close()
  })

  it('preserves the original run error with an AggregateError when the blocked-status write also fails', async () => {
    let runCalls = 0
    const { driver, controllerRoot } = await setup(async (message) => {
      runCalls += 1
      if (runCalls === 1) throw new Error('model call failed')
      return defaultRun(message)
    })

    const registry = new WorkstreamRegistry(controllerRoot)
    const originalUpdate = WorkstreamRegistry.prototype.update
    let updateCalls = 0
    vi.spyOn(WorkstreamRegistry.prototype, 'update').mockImplementation(async (id, mutate) => {
      updateCalls += 1
      if (updateCalls === 2) throw new Error('blocked write failed')
      return originalUpdate.call(registry, id, mutate)
    })

    let caught: unknown
    try {
      await driver.send('boom')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    const messages = (caught as AggregateError).errors.map((error) => (error as Error).message)
    expect(messages).toEqual(['model call failed', 'blocked write failed'])

    await expect(driver.send('second operation')).resolves.toMatchObject({ status: 'idle' })

    await driver.close()
  })

  it('rejects a concurrent send while one run is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { driver, harness } = await setup(async (message) => {
      await gate
      return defaultRun(message)
    })

    const first = driver.send('slow run')
    await expect(driver.send('second run')).rejects.toThrow('driver is busy')
    release()
    await expect(first).resolves.toMatchObject({ status: 'idle' })
    expect(harness.sessions[0]!.messages).toEqual(['slow run'])

    await driver.close()
  })

  it('close() closes the harness once, marks the registry closed, and releases the lock', async () => {
    const { driver, harness, controllerRoot, workspace } = await setup()

    await expect(driver.send('   ')).rejects.toThrow('message must not be blank')

    await driver.close()
    await driver.close()

    expect(harness.closeCount).toBe(1)
    const record = await new WorkstreamRegistry(controllerRoot).read(WORKSTREAM_ID)
    expect(record.status).toBe('closed')
    await expect(readFile(join(workspace, '.writex', 'dev', 'driver.lock'), 'utf8')).rejects.toThrow(
      /ENOENT/,
    )
    await expect(driver.send('late message')).rejects.toThrow('driver is closed')
  })

  it('releases the lock and closes the harness when open fails partway', async () => {
    const controllerRoot = await makeDir('root')
    const workspace = await makeDir('ws')
    const harness = makeFakeHarness(defaultRun)
    const failing: DshHarnessPort = {
      session: () => {
        throw new Error('session creation failed')
      },
      close: async () => {
        harness.closeCount += 1
      },
    }

    await expect(
      PersistentDshSessionDriver.open({
        config: config(workspace),
        controllerRoot,
        harnessFactory: () => failing,
        isPidAlive: () => true,
      }),
    ).rejects.toThrow('session creation failed')

    expect(harness.closeCount).toBe(1)
    await expect(readFile(join(workspace, '.writex', 'dev', 'driver.lock'), 'utf8')).rejects.toThrow(
      /ENOENT/,
    )
  })

  it('writes a compaction capsule and records its path as the last checkpoint', async () => {
    const { driver, controllerRoot } = await setup()

    await expect(driver.saveCompactionCapsule({} as CompactionCapsule)).rejects.toThrow(
      /invalid capsule/,
    )

    const path = await driver.saveCompactionCapsule(capsule())
    expect(path).toBe(join(controllerRoot, '.writex', 'dev', 'capsules', `${WORKSTREAM_ID}.json`))

    const record = await new WorkstreamRegistry(controllerRoot).read(WORKSTREAM_ID)
    expect(record.lastCheckpoint).toBe(path)

    await driver.close()
  })
})
