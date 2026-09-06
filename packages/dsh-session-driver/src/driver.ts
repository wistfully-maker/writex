import { isAbsolute } from 'node:path'
import type {
  CompactionCapsule,
  DriverCheckpoint,
  DriverOpenOptions,
  DshHarnessPort,
  DshSessionPort,
  UsageSummary,
  WorkstreamConfig,
  WorkstreamRecord,
} from './contracts.js'
import { summarizeEvents } from './event-summary.js'
import { WorkstreamRegistry } from './registry.js'
import { validateCompactionCapsule, validateWorkstreamConfig } from './validation.js'
import { WorkspaceLock } from './workspace-lock.js'

const zeroUsage = (): UsageSummary => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
})

export class PersistentDshSessionDriver {
  private busy = false
  private closed = false

  private constructor(
    private readonly config: WorkstreamConfig,
    private readonly registry: WorkstreamRegistry,
    private readonly lock: WorkspaceLock,
    private readonly harness: DshHarnessPort,
    private readonly session: DshSessionPort,
  ) {}

  static async open(options: DriverOpenOptions): Promise<PersistentDshSessionDriver> {
    const config = validateWorkstreamConfig(options.config)
    if (!isAbsolute(options.controllerRoot)) throw new Error('controllerRoot must be absolute')
    const registry = new WorkstreamRegistry(options.controllerRoot, options.now)
    const lock = await WorkspaceLock.acquire(config.workspace, config.workstreamId, options.isPidAlive)
    let harness: DshHarnessPort | undefined
    try {
      const createdAt = (options.now ?? (() => new Date().toISOString()))()
      const record: WorkstreamRecord = {
        schemaVersion: 1,
        workstreamId: config.workstreamId,
        sessionId: config.sessionId,
        model: config.model,
        branch: config.branch,
        worktree: config.workspace,
        status: 'opening',
        createdAt,
        updatedAt: createdAt,
        lastCheckpoint: null,
        promptCount: 0,
        compactCount: 0,
        usage: zeroUsage(),
      }
      await registry.create(record)
      harness = options.harnessFactory(config)
      const session = harness.session(config.sessionId)
      await registry.update(config.workstreamId, (current) => ({ ...current, status: 'idle' }))
      return new PersistentDshSessionDriver(config, registry, lock, harness, session)
    } catch (error) {
      const failures: unknown[] = [error]
      if (harness) try { await harness.close() } catch (closeError) { failures.push(closeError) }
      try { await lock.release() } catch (lockError) { failures.push(lockError) }
      if (failures.length > 1) throw new AggregateError(failures, 'driver open and cleanup failed')
      throw error
    }
  }

  async send(message: string): Promise<DriverCheckpoint> {
    if (this.closed) throw new Error('driver is closed')
    if (this.busy) throw new Error('driver is busy')
    if (message.trim() === '') throw new Error('message must not be blank')
    this.busy = true
    try {
      await this.registry.update(this.config.workstreamId, (current) => ({ ...current, status: 'busy' }))
      try {
        const result = await this.session.run(message)
        const summary = summarizeEvents(result.events)
        const updated = await this.registry.update(this.config.workstreamId, (current) => ({
          ...current,
          status: 'idle',
          promptCount: current.promptCount + 1,
          compactCount: current.compactCount + summary.compactCount,
          usage: {
            inputTokens: current.usage.inputTokens + summary.usage.inputTokens,
            outputTokens: current.usage.outputTokens + summary.usage.outputTokens,
            cacheReadTokens: current.usage.cacheReadTokens + summary.usage.cacheReadTokens,
            cacheWriteTokens: current.usage.cacheWriteTokens + summary.usage.cacheWriteTokens,
            reasoningTokens: current.usage.reasoningTokens + summary.usage.reasoningTokens,
          },
        }))
        return {
          workstreamId: this.config.workstreamId,
          sessionId: result.sessionId,
          status: 'idle',
          finalResponse: result.finalResponse,
          eventCount: result.events.length,
          notificationCount: result.notifications.length,
          usage: updated.usage,
          compactionObserved: summary.compactionObserved,
        }
      } catch (error) {
        try {
          await this.registry.update(this.config.workstreamId, (current) => ({ ...current, status: 'blocked' }))
        } catch (recordError) {
          throw new AggregateError(
            [error, recordError],
            'send failed and blocked status could not be recorded',
          )
        }
        throw error
      }
    } finally {
      this.busy = false
    }
  }

  async saveCompactionCapsule(capsule: CompactionCapsule): Promise<string> {
    if (this.closed) throw new Error('driver is closed')
    const validated = validateCompactionCapsule(capsule)
    const path = await this.registry.saveCapsule(this.config.workstreamId, validated)
    await this.registry.update(this.config.workstreamId, (current) => ({ ...current, lastCheckpoint: path }))
    return path
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const failures: unknown[] = []
    try { await this.harness.close() } catch (error) { failures.push(error) }
    try {
      await this.registry.update(this.config.workstreamId, (current) => ({ ...current, status: 'closed' }))
    } catch (error) { failures.push(error) }
    try { await this.lock.release() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'driver close failed')
  }
}
