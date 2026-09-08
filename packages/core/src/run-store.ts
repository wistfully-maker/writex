import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunState, RunStatus } from '@writex/contracts'
import { atomicWriteFile } from '@writex/workspace'

export interface CreateRunInput {
  runId: string
  command: string
  inputHash: string
}

export type RunClock = () => string

const legalTransitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['needs-human-review', 'succeeded', 'failed', 'cancelled'],
  'needs-human-review': ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

const validRunId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Reject a runId that is not a single nonblank path segment. */
function assertValidRunId(runId: string): void {
  if (!validRunId.test(runId)) {
    throw new Error(`invalid runId: ${runId}`)
  }
}

function defaultClock(): string {
  return new Date().toISOString()
}

/**
 * Durable store for run state under root/.writex/runs/<runId>/state.json.
 * `now` is the clock producing ISO-8601 timestamps and defaults to real time.
 */
export class RunStore {
  constructor(
    private readonly root: string,
    private readonly now: RunClock = defaultClock,
  ) {}

  private runsDirPath(): string {
    return join(this.root, '.writex', 'runs')
  }

  private runDirPath(runId: string): string {
    return join(this.runsDirPath(), runId)
  }

  private statePath(runId: string): string {
    return join(this.runDirPath(runId), 'state.json')
  }

  /**
   * Create a queued run by atomically claiming root/.writex/runs/<runId>.
   * Rejects when the run directory already exists.
   */
  async create(input: CreateRunInput): Promise<RunState> {
    assertValidRunId(input.runId)
    await mkdir(this.runsDirPath(), { recursive: true })
    try {
      await mkdir(this.runDirPath(input.runId))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`run already exists: ${input.runId}`)
      }
      throw error
    }

    const now = this.now()
    const state: RunState = {
      schemaVersion: 1,
      runId: input.runId,
      command: input.command,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      inputHash: input.inputHash,
    }
    try {
      await this.persist(this.statePath(input.runId), state)
    } catch (error) {
      await rm(this.runDirPath(input.runId), { recursive: true, force: true })
      throw error
    }
    return state
  }

  /** Read the persisted state for a runId. */
  async read(runId: string): Promise<RunState> {
    assertValidRunId(runId)
    const raw = await readFile(this.statePath(runId), 'utf8')
    return JSON.parse(raw) as RunState
  }

  /** Transition a run to `to` when the move is legal, persisting the updated state. */
  async transition(runId: string, to: RunStatus): Promise<RunState> {
    assertValidRunId(runId)
    const current = await this.read(runId)
    const allowed = legalTransitions[current.status]
    if (!allowed.includes(to)) {
      throw new Error(`illegal run transition: ${current.status} -> ${to}`)
    }
    const next: RunState = { ...current, status: to, updatedAt: this.now() }
    await this.persist(this.statePath(runId), next)
    return next
  }

  private async persist(path: string, state: RunState): Promise<void> {
    await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`)
  }
}
