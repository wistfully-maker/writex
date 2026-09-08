import { appendFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  GenerationRequest,
  GenerationResult,
  GenerationUsage,
  ModelGateway,
} from '@writex/contracts'
import { DeepSeekError } from '@writex/model-gateway'
import type {
  AttemptSummary,
  EvaluationConfig,
  PersistedAttempt,
} from '../src/index.js'
import {
  EvaluationStore,
  buildPlanRows,
  planEvaluation,
  runEvaluation,
} from '../src/index.js'
import { cleanupRoots, makeConfig, makeRoot, outputOnlyPriceTable } from './helpers.js'

type Handler =
  | { kind: 'ok'; text: string; usage?: GenerationUsage }
  | { kind: 'throw'; error: Error }

function handlersFor(
  ids: string[],
  options: { fail?: Map<string, Error> } = {},
): Map<string, Handler[]> {
  const map = new Map<string, Handler[]>()
  for (const id of ids) {
    const failure = options.fail?.get(id)
    if (failure !== undefined) {
      map.set(id, [{ kind: 'throw', error: failure }])
    } else {
      map.set(id, [{ kind: 'ok', text: `正文-${id}` }])
    }
  }
  return map
}

class ScriptedGateway implements ModelGateway {
  readonly requests: GenerationRequest[] = []

  constructor(private readonly handlers: ReadonlyMap<string, Handler[]>) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(structuredClone(request))
    const attemptId = request.metadata.attemptId ?? request.requestId
    const queue = this.handlers.get(attemptId)
    const handler = queue?.shift()
    if (handler === undefined) {
      throw new Error(`scripted gateway: no handler left for ${attemptId}`)
    }
    if (handler.kind === 'throw') {
      throw handler.error
    }
    return {
      requestId: request.requestId,
      provider: 'scripted',
      model: 'scripted-v1',
      text: handler.text,
      usage: handler.usage ?? {
        inputTokens: 0,
        outputTokens: handler.text.length,
      },
      finishReason: 'stop',
    }
  }
}

const hexPrompt = 'c'.repeat(64)

function neverCalledGateway(calls: string[]): ModelGateway {
  return {
    async generate(): Promise<GenerationResult> {
      calls.push('called')
      throw new Error('gateway must not be called on a dry run')
    },
  }
}

async function planIds(root: string): Promise<string[]> {
  const plan = await planEvaluation(root)
  return plan.attempts.map((attempt) => attempt.attemptId)
}

function summaryMap(
  report: { attempts: AttemptSummary[] },
): Map<string, AttemptSummary> {
  return new Map(report.attempts.map((attempt) => [attempt.attemptId, attempt]))
}

afterEach(cleanupRoots)

describe('planEvaluation and dry runs', () => {
  it('plans exactly 12 calls (two models x six) with zero gateway calls', async () => {
    const root = await makeRoot()
    const config = makeConfig()
    await new EvaluationStore(root).init(config)

    const plan = await planEvaluation(root)
    expect(plan.schemaVersion).toBe(1)
    expect(plan.callCount).toBe(12)
    expect(plan.modelCount).toBe(2)
    expect(plan.budgetUsd).toBe(config.budgetUsd)
    expect(plan.reserveTotalUsd).toBeGreaterThan(0)
    expect(plan.assumptions.length).toBeGreaterThan(0)

    const ids = plan.attempts.map((attempt) => attempt.attemptId)
    expect(new Set(ids).size).toBe(12)
    expect(ids).toContain('flash-reunion')
    expect(ids).toContain('flash-continuity-3')
    expect(ids).toContain('pro-continuity-1')
    expect(ids).toContain('pro-costly-choice')
  })

  it('dry run performs zero gateway calls and leaves nothing persisted', async () => {
    const root = await makeRoot()
    const config = makeConfig()
    await new EvaluationStore(root).init(config)

    const calls: string[] = []
    const report = await runEvaluation(root, {
      live: false,
      gateway: neverCalledGateway(calls),
    })

    expect(report.dryRun).toBe(true)
    expect(report.gatewayCalls).toBe(0)
    expect(calls).toHaveLength(0)
    expect(report.attempts).toHaveLength(12)
    expect(report.attempts.every((attempt) => attempt.status === 'pending')).toBe(true)
    expect(await new EvaluationStore(root).listAttempts()).toHaveLength(0)
  })
})

describe('live generation runs', () => {
  async function initRoot(
    config: EvaluationConfig,
    prefix = 'writex-eval-run-',
  ): Promise<string> {
    const root = await makeRoot(prefix)
    await new EvaluationStore(root).init(config)
    return root
  }

  it('executes exactly 12 calls with isolated continuation contexts and persisted outputs', async () => {
    const root = await initRoot(makeConfig())
    const ids = await planIds(root)
    const gateway = new ScriptedGateway(handlersFor(ids))

    const report = await runEvaluation(root, { live: true, gateway })

    expect(report.dryRun).toBe(false)
    expect(report.gatewayCalls).toBe(12)
    expect(report.stoppedReason).toBe('completed')
    const byId = summaryMap(report)
    expect(byId.size).toBe(12)
    for (const attemptId of ids) {
      expect(byId.get(attemptId)?.status).toBe('succeeded')
      expect(byId.get(attemptId)?.costUnknown).toBe(false)
    }

    const store = new EvaluationStore(root)
    for (const attemptId of ids) {
      const persisted = await store.readAttempt(attemptId)
      expect(persisted.promptHash).toMatch(/^[0-9a-f]{64}$/)
      expect(persisted.reservedUsd).toBeGreaterThan(0)
      await expect(store.readOutput(attemptId)).resolves.toBe(`正文-${attemptId}`)
    }
  })

  it('gives every continuation request only its own model fixed brief and full history', async () => {
    const root = await initRoot(makeConfig())
    const ids = await planIds(root)
    const gateway = new ScriptedGateway(handlersFor(ids))
    await runEvaluation(root, { live: true, gateway })

    const byTask = new Map<string, GenerationRequest[]>()
    for (const request of gateway.requests) {
      const key = `${request.metadata.model}-${request.metadata.taskId}-${request.metadata.step ?? ''}`
      const list = byTask.get(key) ?? []
      list.push(request)
      byTask.set(key, list)
    }

    const flashStep2 = byTask.get('deepseek-v4-flash-three-step-continuity-2')
    const proStep2 = byTask.get('deepseek-v4-pro-three-step-continuity-2')
    const flashStep3 = byTask.get('deepseek-v4-flash-three-step-continuity-3')
    expect(flashStep2).toHaveLength(1)
    expect(proStep2).toHaveLength(1)
    expect(flashStep3).toHaveLength(1)

    const flash2 = flashStep2?.[0]?.prompt ?? ''
    const pro2 = proStep2?.[0]?.prompt ?? ''
    const flash3 = flashStep3?.[0]?.prompt ?? ''

    // Every later step retains the fixed brief plus the model's own history.
    expect(flash2).toContain('【人物档案】')
    expect(flash2).toContain('正文-flash-continuity-1')
    expect(flash2).not.toContain('正文-pro-continuity-1')
    expect(flash2).not.toContain('正文-flash-reunion')
    expect(flash2).not.toContain('正文-flash-continuity-2')
    expect(pro2).toContain('【事实表】')
    expect(pro2).toContain('正文-pro-continuity-1')
    expect(pro2).not.toContain('正文-flash-continuity-1')

    // Step 3 carries the complete same-model history (segments 1 and 2).
    expect(flash3).toContain('正文-flash-continuity-1')
    expect(flash3).toContain('正文-flash-continuity-2')
    expect(flash3.indexOf('正文-flash-continuity-1')).toBeLessThan(
      flash3.indexOf('正文-flash-continuity-2'),
    )
    expect(flash3).not.toContain('正文-pro-continuity-2')

    // Step-1 prompts start from identical fixed materials for both models.
    const flash1 = byTask.get('deepseek-v4-flash-three-step-continuity-1')?.[0]?.prompt
    const pro1 = byTask.get('deepseek-v4-pro-three-step-continuity-1')?.[0]?.prompt
    expect(flash1).toBe(pro1)
  })

  it('stops at the budget gate and never exceeds the configured budget', async () => {
    const config = makeConfig({
      budgetUsd: 2e-6,
      maxOutputTokens: 1,
      priceTable: outputOnlyPriceTable(1),
    })
    const root = await initRoot(config)
    const ids = await planIds(root)
    const gateway = new ScriptedGateway(handlersFor(ids))

    const report = await runEvaluation(root, { live: true, gateway })

    expect(report.stoppedReason).toBe('budget')
    expect(report.gatewayCalls).toBe(1)
    expect(report.reservedUsd).toBeCloseTo(1.15e-6, 12)
    expect(report.reservedUsd).toBeLessThanOrEqual(config.budgetUsd)
    const store = new EvaluationStore(root)
    const attempts = await store.listAttempts()
    const succeeded = attempts.filter((attempt) => attempt.status === 'succeeded')
    expect(succeeded).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'pending')).toHaveLength(11)
  })

  it('stops the whole batch on an auth error without calling further models', async () => {
    const root = await initRoot(makeConfig())
    const ids = await planIds(root)
    const failures = new Map<string, Error>([
      ['flash-reunion', new DeepSeekError('auth', 'authentication failed', 401)],
    ])
    const gateway = new ScriptedGateway(handlersFor(ids, { fail: failures }))

    const report = await runEvaluation(root, { live: true, gateway })

    expect(report.stoppedReason).toBe('auth')
    expect(report.gatewayCalls).toBe(1)
    const store = new EvaluationStore(root)
    const attempts = await store.listAttempts()
    const failed = attempts.find((attempt) => attempt.attemptId === 'flash-reunion')
    expect(failed?.status).toBe('failed')
    expect(failed?.failure?.kind).toBe('auth')
    // The batch stopped; nothing else was attempted, nothing is blocked.
    expect(attempts.filter((attempt) => attempt.status === 'failed')).toHaveLength(1)
    expect(attempts.filter((attempt) => attempt.status === 'pending')).toHaveLength(11)
  })

  it('records carried usage/id/model/finish for a truncated paid response', async () => {
    const root = await initRoot(makeConfig())
    const ids = await planIds(root)
    const failures = new Map<string, Error>([
      [
        'flash-reunion',
        new DeepSeekError('truncated', 'output ended before stop', undefined, {
          usage: { inputTokens: 10, outputTokens: 5 },
          responseId: 'chatcmpl-truncated',
          model: 'deepseek-v4-flash',
          finishReason: 'length',
        }),
      ],
    ])
    const gateway = new ScriptedGateway(handlersFor(ids, { fail: failures }))

    const report = await runEvaluation(root, { live: true, gateway })
    expect(report.gatewayCalls).toBe(12)
    // A failed draft keeps the run from ever reporting 'completed'.
    expect(report.stoppedReason).toBe('incomplete')
    const store = new EvaluationStore(root)
    const failed = await store.readAttempt('flash-reunion')

    expect(failed.failure?.kind).toBe('truncated')
    expect(failed.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(failed.responseId).toBe('chatcmpl-truncated')
    expect(failed.responseModel).toBe('deepseek-v4-flash')
    expect(failed.finishReason).toBe('length')
    expect(failed.costUsd).not.toBeNull()
    expect(failed.costUnknown).toBe(false)
    // Dependent scenes/continuations of the other kind still completed.
    const other = await store.readAttempt('flash-continuity-1')
    expect(other.status).toBe('succeeded')
  })

  it('blocks dependent continuation steps on failure and explicit retry preserves prior successes', async () => {
    const root = await initRoot(makeConfig())
    const ids = await planIds(root)

    const firstFailures = new Map<string, Error>([
      ['flash-continuity-1', new Error('boom on first step')],
    ])
    const firstGateway = new ScriptedGateway(
      handlersFor(ids, { fail: firstFailures }),
    )
    const firstReport = await runEvaluation(root, { live: true, gateway: firstGateway })

    // 10 attempted calls: 12 planned minus the two dependents blocked by the
    // failed first continuity step (the failed call itself is counted).
    expect(firstReport.gatewayCalls).toBe(10)
    // Failed + blocked dependents => never 'completed' without a retry.
    expect(firstReport.stoppedReason).toBe('incomplete')
    const firstStore = new EvaluationStore(root)
    const firstAttempts = await firstStore.listAttempts()
    const byId = new Map(firstAttempts.map((attempt) => [attempt.attemptId, attempt]))
    expect(byId.get('flash-continuity-1')?.status).toBe('failed')
    expect(byId.get('flash-continuity-2')?.status).toBe('blocked')
    expect(byId.get('flash-continuity-2')?.blockReason).toBe('dependent-failure')
    expect(byId.get('flash-continuity-3')?.status).toBe('blocked')
    expect(byId.get('flash-reunion')?.status).toBe('succeeded')
    const firstReserved = byId.get('flash-continuity-1')?.reservedUsd ?? 0
    expect(firstReserved).toBeGreaterThan(0)
    const reunionDraft = await firstStore.readOutput('flash-reunion')

    const secondGateway = new ScriptedGateway(handlersFor(ids))
    const secondReport = await runEvaluation(root, {
      live: true,
      gateway: secondGateway,
      retryFailed: true,
    })

    expect(secondReport.gatewayCalls).toBe(3)
    expect(secondGateway.requests.map((request) => request.requestId).sort()).toEqual(
      ['flash-continuity-1', 'flash-continuity-2', 'flash-continuity-3'].sort(),
    )
    const secondStore = new EvaluationStore(root)
    const finalAttempts = await secondStore.listAttempts()
    const finalById = new Map(finalAttempts.map((attempt) => [attempt.attemptId, attempt]))
    for (const attemptId of ids) {
      expect(finalById.get(attemptId)?.status).toBe('succeeded')
    }
    // Retrying keeps the earlier reservation: the retried step accumulates
    // its new reserve on top of the failed one instead of overwriting it.
    expect((finalById.get('flash-continuity-1')?.reservedUsd ?? 0)).toBeGreaterThan(
      firstReserved,
    )
    // Successes from the first run were never regenerated.
    await expect(secondStore.readOutput('flash-reunion')).resolves.toBe(reunionDraft)
  })

  it('keeps interrupted reservations uncertain and requires explicit manual lock recovery', async () => {
    const root = await initRoot(makeConfig())
    const ids = await planIds(root)
    const store = new EvaluationStore(root)
    // A realistic crash state: the full seed was persisted and most attempts
    // succeeded, then one paid retry crashed while in-flight.
    await runEvaluation(root, {
      live: true,
      gateway: new ScriptedGateway(handlersFor(ids)),
    })
    const stamp = '2026-09-07T01:00:00.000Z'
    const succeeded = await store.readAttempt('flash-continuity-1')
    await store.writeAttempt({
      ...succeeded,
      status: 'in-flight',
      reservedUsd: 0.004,
      promptHash: hexPrompt,
      startedAt: stamp,
      updatedAt: stamp,
    })

    const staleLock = {
      schemaVersion: 1,
      pid: 2_147_483_647,
      token: 'stale-run-token',
      createdAt: '2026-09-07T00:00:00.000Z',
    }
    await writeFile(join(root, 'lock.json'), `${JSON.stringify(staleLock)}\n`, 'utf8')

    // A stale lock refuses live runs with explicit guidance and is never
    // auto-deleted by the library.
    const calls: string[] = []
    await expect(
      runEvaluation(root, {
        live: true,
        gateway: neverCalledGateway(calls),
        retryFailed: true,
      }),
    ).rejects.toThrowError(/locked by process .*remove .*lock\.json manually/)
    expect(calls).toHaveLength(0)
    await expect(readFile(join(root, 'lock.json'), 'utf8')).resolves.toContain(
      'stale-run-token',
    )

    // Explicit operator recovery: verify the owner is gone, remove the lock.
    await rm(join(root, 'lock.json'))

    // Recovery turns the interrupted attempt uncertain; without an explicit
    // retry it is left alone (zero new calls) and the run is NOT completed.
    const skipCalls: string[] = []
    const skipReport = await runEvaluation(root, {
      live: true,
      gateway: neverCalledGateway(skipCalls),
    })
    expect(skipCalls).toHaveLength(0)
    expect(skipReport.stoppedReason).toBe('incomplete')
    const afterSkip = await store.readAttempt('flash-continuity-1')
    expect(afterSkip.status).toBe('uncertain')
    expect(afterSkip.reservedUsd).toBe(0.004)

    // Explicit retry re-runs exactly that attempt, accumulates the new
    // reservation on top of the retained one, clears the failure, and
    // persists the success.
    const retryGateway = new ScriptedGateway(handlersFor(['flash-continuity-1']))
    const retryReport = await runEvaluation(root, {
      live: true,
      gateway: retryGateway,
      retryFailed: true,
    })
    expect(retryReport.gatewayCalls).toBe(1)
    const final = await store.readAttempt('flash-continuity-1')
    expect(final.status).toBe('succeeded')
    expect(final.failure).toBeNull()
    expect(final.reservedUsd).toBeGreaterThan(0.004)
    await expect(store.readOutput('flash-continuity-1')).resolves.toBe(
      '正文-flash-continuity-1',
    )
    // The run lock was released afterwards.
    await expect(store.acquireLock()).resolves.toBeTruthy()
  })

  it('reseeds planned attempts that vanished after a partial crash', async () => {
    const root = await initRoot(makeConfig())
    const ids = await planIds(root)
    const store = new EvaluationStore(root)
    await runEvaluation(root, {
      live: true,
      gateway: new ScriptedGateway(handlersFor(ids)),
    })

    // Simulate a partial crash that lost one persisted attempt and its draft.
    await rm(join(root, 'attempts', 'flash-reunion.json'))
    await rm(join(root, 'outputs', 'flash-reunion.txt'))

    const recoveryGateway = new ScriptedGateway(handlersFor(['flash-reunion']))
    const report = await runEvaluation(root, {
      live: true,
      gateway: recoveryGateway,
    })
    expect(report.gatewayCalls).toBe(1)
    const attempts = await store.listAttempts()
    expect(attempts).toHaveLength(12)
    expect(
      attempts.every((attempt) => attempt.status === 'succeeded'),
    ).toBe(true)
    await expect(store.readOutput('flash-reunion')).resolves.toBe(
      '正文-flash-reunion',
    )
  })

  it('marks an output-write failure uncertain and preserves the in-flight reservation', async () => {
    const root = await initRoot(makeConfig())
    const ids = await planIds(root)
    const store = new EvaluationStore(root)

    const gateway = new ScriptedGateway(handlersFor(ids))
    vi.spyOn(EvaluationStore.prototype, 'writeOutput').mockImplementationOnce(
      async () => {
        throw new Error('disk full while writing output')
      },
    )
    try {
      const report = await runEvaluation(root, { live: true, gateway })
      // flash-reunion reserved a charge and the gateway returned, but the
      // output write failed: the record must NOT revert to pre-flight state.
      expect(report.stoppedReason).toBe('incomplete')
      const uncertain = await store.readAttempt('flash-reunion')
      expect(uncertain.status).toBe('uncertain')
      expect(uncertain.failure?.message).toContain('disk full')
      expect(uncertain.reservedUsd).toBeGreaterThan(0)
      expect(uncertain.promptHash).toMatch(/^[0-9a-f]{64}$/)
      expect(uncertain.startedAt).not.toBeNull()
    } finally {
      vi.restoreAllMocks()
    }

    // The uncertain attempt stays retryable and succeeds on an explicit retry.
    const after = await store.readAttempt('flash-reunion')
    expect(after.status).toBe('uncertain')
    expect(after.reservedUsd).toBeGreaterThan(0)
    const finalGateway = new ScriptedGateway(handlersFor(['flash-reunion']))
    const finalReport = await runEvaluation(root, {
      live: true,
      gateway: finalGateway,
      retryFailed: true,
    })
    expect(finalReport.gatewayCalls).toBe(1)
    const succeeded = await store.readAttempt('flash-reunion')
    expect(succeeded.status).toBe('succeeded')
    expect(succeeded.failure).toBeNull()
    expect(succeeded.reservedUsd).toBeGreaterThan(after.reservedUsd)
  })

  it('refuses to run when the persisted config no longer matches the init hash', async () => {
    const root = await initRoot(makeConfig())
    await appendFile(join(root, 'config.json'), '\n// tampered\n', 'utf8')

    const calls: string[] = []
    await expect(planEvaluation(root)).rejects.toThrowError(/hash mismatch/)
    await expect(
      runEvaluation(root, { live: true, gateway: neverCalledGateway(calls) }),
    ).rejects.toThrowError(/hash mismatch/)
    expect(calls).toHaveLength(0)
  })

  it('releases the writer lock after a live run', async () => {
    const root = await initRoot(makeConfig())
    const ids = await planIds(root)
    const gateway = new ScriptedGateway(handlersFor(ids))
    await runEvaluation(root, { live: true, gateway })

    const store = new EvaluationStore(root)
    await expect(store.acquireLock()).resolves.toBeTruthy()
  })
})
