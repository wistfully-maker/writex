import type {
  GenerationRequest,
  GenerationUsage,
  ModelGateway,
} from '@writex/contracts'
import { DeepSeekError, type DeepSeekModelId } from '@writex/model-gateway'
import {
  costFromUsage,
  estimateReserveUsd,
  estimateReserveUsdFromTokens,
  priceAssumptions,
} from './config.js'
import {
  continuityTaskId,
  continuationStepNumbers,
  evaluationModels,
  sceneTaskIds,
  type AttemptCallRecord,
  type AttemptFailure,
  type AttemptSummary,
  type ContinuationStep,
  type EvaluationConfig,
  type EvaluationPlan,
  type EvaluationPriceTable,
  type EvaluationRunReport,
  type EvaluationTaskId,
  type PersistedAttempt,
  type PlannedAttempt,
} from './contracts.js'
import {
  buildUserPrompt,
  continuityFixedBrief,
  continuityStageTasks,
  evaluationSystemPrompt,
  promptHash,
} from './fixtures.js'
import { EvaluationStore } from './store.js'

export interface PlanRow {
  attemptId: string
  model: DeepSeekModelId
  taskId: EvaluationTaskId
  kind: 'scene' | 'continuation'
  step: ContinuationStep | null
  order: number
}

export function modelSlug(model: DeepSeekModelId): string {
  return model === 'deepseek-v4-flash' ? 'flash' : 'pro'
}

export function attemptIdFor(
  model: DeepSeekModelId,
  taskId: EvaluationTaskId,
  step: ContinuationStep | null,
): string {
  const key =
    taskId === continuityTaskId ? `continuity-${step as ContinuationStep}` : taskId
  return `${modelSlug(model)}-${key}`
}

/**
 * Deterministic 12-call generation order: for each model its three scenes
 * then its three continuity steps. Continuation steps are ordered so that each
 * step can consume the previous step's output of the same model.
 */
export function buildPlanRows(): PlanRow[] {
  const rows: PlanRow[] = []
  let order = 0
  for (const model of evaluationModels) {
    for (const taskId of sceneTaskIds) {
      rows.push({
        attemptId: attemptIdFor(model, taskId, null),
        model,
        taskId,
        kind: 'scene',
        step: null,
        order: order++,
      })
    }
    for (const step of continuationStepNumbers) {
      rows.push({
        attemptId: attemptIdFor(model, continuityTaskId, step),
        model,
        taskId: continuityTaskId,
        kind: 'continuation',
        step,
        order: order++,
      })
    }
  }
  return rows
}

export interface RunEvaluationOptions {
  /** Live network runs require explicit `live: true`; dry is the default. */
  live?: boolean
  /** Required for live runs; never invoked for dry runs. */
  gateway?: ModelGateway
  /** Explicitly retry attempts left `failed` or `uncertain` by earlier runs. */
  retryFailed?: boolean
}

function attemptPurpose(kind: 'scene' | 'continuation'): string {
  return kind === 'scene' ? 'eval-generation-scene' : 'eval-generation-continuation'
}

/** Upper-bound input tokens for dry planning of one row. */
function planInputTokensUpper(
  config: EvaluationConfig,
  row: PlanRow,
): number {
  if (row.kind === 'scene') {
    const user = buildUserPrompt(row.taskId, row.kind, row.step)
    return Buffer.byteLength(`${evaluationSystemPrompt}\u0000${user}`, 'utf8')
  }
  if (row.step === null) {
    throw new Error(`invalid continuation plan row: ${row.attemptId}`)
  }
  if (row.step === 1) {
    const user = buildUserPrompt(row.taskId, row.kind, 1)
    return Buffer.byteLength(`${evaluationSystemPrompt}\u0000${user}`, 'utf8')
  }
  // Later steps keep the fixed brief and append the model's own full history.
  const stage = continuityStageTasks[row.step]
  const wrapper = '【你此前生成的第 N 段正文，只供衔接，不要复述或改写】\n'
  const baseBytes = Buffer.byteLength(
    `${evaluationSystemPrompt}\u0000${continuityFixedBrief}\n\n${stage}${wrapper}`,
    'utf8',
  )
  // Each previous segment is capped at maxOutputTokens output tokens.
  const priorTokens = (row.step - 1) * config.maxOutputTokens
  return baseBytes + priorTokens
}

function plannedReserve(config: EvaluationConfig, row: PlanRow): number {
  return estimateReserveUsdFromTokens({
    inputTokensUpper: planInputTokensUpper(config, row),
    maxOutputTokens: config.maxOutputTokens,
    model: row.model,
    priceTable: config.priceTable,
  })
}

export function plannedAttempts(config: EvaluationConfig): PlannedAttempt[] {
  return buildPlanRows().map((row) => ({
    attemptId: row.attemptId,
    model: row.model,
    taskId: row.taskId,
    kind: row.kind,
    step: row.step,
    order: row.order,
    purpose: attemptPurpose(row.kind),
    reservedUsd: plannedReserve(config, row),
  }))
}

/**
 * Dry planning: reports the exact request list, count and conservative
 * reserve estimate. Never performs network calls and never writes attempts.
 */
export async function planEvaluation(root: string): Promise<EvaluationPlan> {
  const store = new EvaluationStore(root)
  await store.assertUsable()
  const config = await store.readConfig()
  const state = await store.readState()
  const attempts = plannedAttempts(config)
  return {
    schemaVersion: 1,
    configHash: state.configHash,
    fixtureHash: state.fixtureHash,
    modelCount: evaluationModels.length,
    callCount: attempts.length,
    attempts,
    budgetUsd: config.budgetUsd,
    reserveTotalUsd: attempts.reduce((sum, row) => sum + row.reservedUsd, 0),
    assumptions: priceAssumptions(config.priceTable),
  }
}

function classifyGatewayError(error: unknown): AttemptFailure {
  if (error instanceof DeepSeekError) {
    return { kind: error.code, message: error.message }
  }
  const message =
    error instanceof Error ? error.message : `unknown error: ${String(error)}`
  return { kind: 'error', message }
}

/**
 * Lift sanitized provider metadata (usage/id/model/finish) carried by typed
 * gateway failures onto the failed attempt, so paid requests whose output was
 * truncated or empty can still be recorded with their known usage and cost.
 */
function carriedFailureFields(
  error: unknown,
  model: DeepSeekModelId,
  priceTable: EvaluationPriceTable,
): Pick<
  PersistedAttempt,
  'usage' | 'costUsd' | 'costUnknown' | 'responseId' | 'responseModel' | 'finishReason'
> | null {
  if (!(error instanceof DeepSeekError) || error.details === undefined) {
    return null
  }
  const usage: GenerationUsage | null = error.details.usage ?? null
  const cost = costFromUsage(usage, model, priceTable)
  return {
    usage,
    costUsd: cost.costUsd,
    costUnknown: cost.unknown,
    responseId: error.details.responseId ?? null,
    responseModel: error.details.model ?? null,
    finishReason: error.details.finishReason ?? null,
  }
}

function blankAttemptFields(): Pick<
  PersistedAttempt,
  | 'status'
  | 'blockReason'
  | 'failure'
  | 'responseId'
  | 'responseModel'
  | 'finishReason'
  | 'usage'
  | 'costUsd'
  | 'costUnknown'
  | 'startedAt'
  | 'finishedAt'
> {
  return {
    status: 'pending',
    blockReason: null,
    failure: null,
    responseId: null,
    responseModel: null,
    finishReason: null,
    usage: null,
    costUsd: null,
    costUnknown: false,
    startedAt: null,
    finishedAt: null,
  }
}

/** Append one completed call to the attempt's durable per-call history. */
function appendAttemptCall(
  attempt: PersistedAttempt,
  call: Omit<AttemptCallRecord, 'seq'>,
): PersistedAttempt {
  const history = attempt.attemptCalls ?? []
  return {
    ...attempt,
    attemptCalls: [...history, { ...call, seq: history.length + 1 }],
  }
}

/** Reserve added by the current (not-yet-recorded) call on top of history. */
function unrecordedReserve(attempt: PersistedAttempt): number {
  const history = attempt.attemptCalls ?? []
  const pastReserved = history.reduce((sum, call) => sum + call.reservedUsd, 0)
  return Math.max(0, attempt.reservedUsd - pastReserved)
}

/**
 * Persist a `pending` attempt for every planned row that is NOT already on
 * disk. A fresh root gets all twelve; a run that crashed mid-seed only fills
 * the missing rows so no planned draft is silently skipped afterwards.
 */
async function seedPendingAttempts(
  store: EvaluationStore,
  config: EvaluationConfig,
  now: () => string,
): Promise<void> {
  const state = await store.readState()
  const existing = new Set(await store.listAttemptIds())
  for (const planned of plannedAttempts(config)) {
    if (existing.has(planned.attemptId)) {
      continue
    }
    const attempt: PersistedAttempt = {
      schemaVersion: 1,
      attemptId: planned.attemptId,
      model: planned.model,
      taskId: planned.taskId,
      kind: planned.kind,
      step: planned.step,
      createdAt: now(),
      updatedAt: now(),
      configHash: state.configHash,
      fixtureHash: state.fixtureHash,
      promptHash: null,
      reservedUsd: 0,
      ...blankAttemptFields(),
    }
    await store.writeAttempt(attempt)
  }
}

function summarizeAttempt(attempt: PersistedAttempt): AttemptSummary {
  return {
    attemptId: attempt.attemptId,
    model: attempt.model,
    taskId: attempt.taskId,
    step: attempt.step,
    status: attempt.status,
    blockReason: attempt.blockReason,
    failure: attempt.failure,
    costUsd: attempt.costUsd,
    costUnknown: attempt.costUnknown,
    reservedUsd: attempt.reservedUsd,
  }
}

/** Refuse to use an attempt whose identity/budget hashes disagree with the run. */
function assertAttemptHashesMatch(
  state: { configHash: string; fixtureHash: string },
  attempts: readonly PersistedAttempt[],
): void {
  for (const attempt of attempts) {
    if (
      attempt.configHash !== state.configHash ||
      attempt.fixtureHash !== state.fixtureHash
    ) {
      throw new Error(
        `attempt ${attempt.attemptId} hashes do not match this run root; refusing to continue`,
      )
    }
  }
}

/** Conservative spent estimate: known costs, otherwise retained reserves. */
function spentEstimate(attempts: PersistedAttempt[]): number {
  let total = 0
  for (const attempt of attempts) {
    if (attempt.status === 'succeeded') {
      total += attempt.costUsd ?? attempt.reservedUsd
    } else if (
      attempt.status === 'failed' ||
      attempt.status === 'uncertain' ||
      attempt.status === 'in-flight'
    ) {
      total += attempt.reservedUsd
    }
  }
  return total
}

function buildReport(
  root: string,
  dryRun: boolean,
  config: EvaluationConfig,
  state: { configHash: string; fixtureHash: string },
  attempts: PersistedAttempt[],
  gatewayCalls: number,
  reservedUsd: number,
  stoppedReason: EvaluationRunReport['stoppedReason'],
): EvaluationRunReport {
  return {
    schemaVersion: 1,
    dryRun,
    root,
    configHash: state.configHash,
    fixtureHash: state.fixtureHash,
    attempts: attempts.map(summarizeAttempt),
    gatewayCalls,
    budgetUsd: config.budgetUsd,
    reservedUsd,
    spentEstimateUsd: spentEstimate(attempts),
    stoppedReason,
    assumptions: priceAssumptions(config.priceTable),
  }
}

/**
 * Run the evaluation. Dry (the default) only plans and makes zero network
 * calls. A live run requires an explicit gateway and performs the exact 12
 * generation calls, persisting reserved charges before each network request,
 * honoring the budget gate, stopping the batch on auth errors and blocking
 * dependent continuation steps after a failure. Retrying failed or uncertain
 * attempts is explicit via `retryFailed` and never regenerates successes.
 */
export async function runEvaluation(
  root: string,
  options: RunEvaluationOptions = {},
): Promise<EvaluationRunReport> {
  const store = new EvaluationStore(root)
  await store.assertUsable()
  const config = await store.readConfig()
  const state = await store.readState()

  if (options.live !== true) {
    const attempts: PersistedAttempt[] = await store.listAttempts()
    assertAttemptHashesMatch(state, attempts)
    if (attempts.length === 0) {
      return {
        schemaVersion: 1,
        dryRun: true,
        root,
        configHash: state.configHash,
        fixtureHash: state.fixtureHash,
        attempts: plannedAttempts(config).map((planned) => ({
          attemptId: planned.attemptId,
          model: planned.model,
          taskId: planned.taskId,
          step: planned.step,
          status: 'pending',
          blockReason: null,
          failure: null,
          costUsd: null,
          costUnknown: false,
          reservedUsd: planned.reservedUsd,
        })),
        gatewayCalls: 0,
        budgetUsd: config.budgetUsd,
        reservedUsd: 0,
        spentEstimateUsd: 0,
        stoppedReason: null,
        assumptions: priceAssumptions(config.priceTable),
      }
    }
    return buildReport(
      root,
      true,
      config,
      state,
      attempts,
      0,
      attempts.reduce((sum, attempt) => sum + attempt.reservedUsd, 0),
      null,
    )
  }

  const gateway = options.gateway
  if (gateway === undefined) {
    throw new Error('live evaluation run requires a gateway')
  }

  const now = () => new Date().toISOString()
  const token = await store.acquireLock()
  let gatewayCalls = 0
  let stoppedReason: EvaluationRunReport['stoppedReason'] = null
  try {
    await store.recoverInterruptedInFlight()
    const existingAttempts = await store.listAttempts()
    assertAttemptHashesMatch(state, existingAttempts)
    // A partial crash may have persisted only some planned rows; fill the
    // gaps so the exact twelve are never silently skipped afterwards.
    await seedPendingAttempts(store, config, now)
    const storedIds = new Set(await store.listAttemptIds())

    const rows = buildPlanRows()
    // Budget is shared with persisted diagnosis records: reserves already
    // retained by earlier generation attempts OR diagnostics count against
    // the same configured budget before any new reservation is added.
    const persistedReserved = await store
      .listAttempts()
      .then((attempts) =>
        attempts.reduce((sum, attempt) => sum + attempt.reservedUsd, 0),
      )
    const diagnosisReserved = await store
      .listDiagnoses()
      .then((diagnoses) =>
        diagnoses.reduce((sum, diagnosis) => sum + diagnosis.reservedUsd, 0),
      )
    let reservedAccum = persistedReserved + diagnosisReserved

    const blockDependents = async (
      model: DeepSeekModelId,
      fromStep: ContinuationStep,
    ): Promise<void> => {
      for (
        let step = fromStep + 1;
        step <= continuationStepNumbers.length;
        step += 1
      ) {
        const dependentId = attemptIdFor(
          model,
          continuityTaskId,
          step as ContinuationStep,
        )
        if (!storedIds.has(dependentId)) {
          continue
        }
        const dependent = await store.readAttempt(dependentId)
        if (dependent.status === 'succeeded') {
          continue
        }
        await store.writeAttempt({
          ...dependent,
          status: 'blocked',
          blockReason: 'dependent-failure',
          updatedAt: now(),
        })
      }
    }

    const reopenDependents = async (
      model: DeepSeekModelId,
      fromStep: ContinuationStep,
    ): Promise<void> => {
      for (
        let step = fromStep + 1;
        step <= continuationStepNumbers.length;
        step += 1
      ) {
        const dependentId = attemptIdFor(
          model,
          continuityTaskId,
          step as ContinuationStep,
        )
        if (!storedIds.has(dependentId)) {
          continue
        }
        const dependent = await store.readAttempt(dependentId)
        if (
          dependent.status === 'blocked' &&
          dependent.blockReason === 'dependent-failure'
        ) {
          await store.writeAttempt({
            ...dependent,
            status: 'pending',
            blockReason: null,
            updatedAt: now(),
          })
        }
      }
    }

    for (const row of rows) {
      if (!storedIds.has(row.attemptId)) {
        continue
      }
      const attempt = await store.readAttempt(row.attemptId)
      if (attempt.status === 'succeeded' || attempt.status === 'blocked') {
        continue
      }
      const eligible =
        attempt.status === 'pending' ||
        ((attempt.status === 'failed' || attempt.status === 'uncertain') &&
          options.retryFailed === true)
      if (!eligible) {
        continue
      }

      // A continuation step may only run when every earlier step of the same
      // model has already succeeded. After a crash the predecessor may be
      // uncertain and not retried in this run, so the dependent stays pending
      // until an explicit retry resolves the chain (never fails on a missing
      // previous segment).
      if (row.kind === 'continuation' && row.step !== null && row.step > 1) {
        let dependencyReady = true
        for (let prior = 1; prior < row.step; prior += 1) {
          const previousId = attemptIdFor(
            row.model,
            continuityTaskId,
            prior as ContinuationStep,
          )
          if (!storedIds.has(previousId)) {
            dependencyReady = false
            break
          }
          const previousAttempt = await store.readAttempt(previousId)
          if (previousAttempt.status !== 'succeeded') {
            dependencyReady = false
            break
          }
        }
        if (!dependencyReady) {
          continue
        }
      }

      // `inFlightRecord` remembers that the reserved in-flight record was
      // persisted. The outer catch must never revert to the stale pre-flight
      // attempt once a reservation (and possibly a paid call) happened.
      let inFlightRecord: PersistedAttempt | null = null
      try {
        const previousSegments: string[] = []
        if (
          row.kind === 'continuation' &&
          row.step !== null &&
          row.step > 1
        ) {
          for (let prior = 1; prior < row.step; prior += 1) {
            const previousId = attemptIdFor(
              row.model,
              continuityTaskId,
              prior as ContinuationStep,
            )
            previousSegments.push(await store.readOutput(previousId))
          }
        }
        const userPrompt = buildUserPrompt(
          row.taskId,
          row.kind,
          row.step,
          previousSegments,
        )
        const systemPrompt = evaluationSystemPrompt
        const hash = promptHash(systemPrompt, userPrompt)
        const inputUtf8Bytes = Buffer.byteLength(
          `${systemPrompt}\u0000${userPrompt}`,
          'utf8',
        )
        const reserve = estimateReserveUsd({
          inputUtf8Bytes,
          maxOutputTokens: config.maxOutputTokens,
          model: attempt.model,
          priceTable: config.priceTable,
        })
        if (reservedAccum + reserve > config.budgetUsd) {
          stoppedReason = 'budget'
          break
        }
        reservedAccum += reserve

        const inFlight: PersistedAttempt = {
          ...attempt,
          status: 'in-flight',
          // Retries accumulate their reservation on top of any earlier one
          // instead of overwriting it, and the previous failure metadata
          // stays visible until this new outcome is known.
          reservedUsd: attempt.reservedUsd + reserve,
          promptHash: hash,
          startedAt: now(),
          updatedAt: now(),
          blockReason: null,
        }
        await store.writeAttempt(inFlight)
        inFlightRecord = inFlight

        const metadata: Record<string, string> = {
          attemptId: attempt.attemptId,
          model: attempt.model,
          taskId: attempt.taskId,
          purpose: attemptPurpose(row.kind),
        }
        if (row.step !== null) {
          metadata.step = String(row.step)
        }
        const request: GenerationRequest = {
          requestId: attempt.attemptId,
          purpose: attemptPurpose(row.kind),
          system: systemPrompt,
          prompt: userPrompt,
          maxOutputTokens: config.maxOutputTokens,
          metadata,
        }

        let result
        gatewayCalls += 1
        try {
          result = await gateway.generate(request)
        } catch (error) {
          const failure = classifyGatewayError(error)
          const carried = carriedFailureFields(
            error,
            attempt.model,
            config.priceTable,
          )
          const finished = now()
          const failedState: PersistedAttempt = {
            ...inFlight,
            status: 'failed',
            failure,
            finishedAt: finished,
            updatedAt: finished,
            ...(carried ?? {}),
          }
          await store.writeAttempt(
            appendAttemptCall(failedState, {
              status: 'failed',
              startedAt: inFlight.startedAt ?? finished,
              finishedAt: finished,
              reservedUsd: reserve,
              failure,
              usage: failedState.usage,
              costUsd: failedState.costUsd,
              costUnknown: failedState.costUnknown,
              responseId: failedState.responseId,
              responseModel: failedState.responseModel,
              finishReason: failedState.finishReason,
            }),
          )
          inFlightRecord = null
          if (failure.kind === 'auth') {
            stoppedReason = 'auth'
            break
          }
          if (row.kind === 'continuation' && row.step !== null) {
            await blockDependents(row.model, row.step)
          }
          continue
        }

        const usage: GenerationUsage | null = result.usage ?? null
        const cost = costFromUsage(usage, attempt.model, config.priceTable)
        const finished = now()
        const succeeded: PersistedAttempt = {
          ...inFlight,
          status: 'succeeded',
          // A successful retry clears the previously active error while the
          // accumulated reservations and per-call history preserve the
          // attempt's full charge history.
          failure: null,
          usage,
          costUsd: cost.costUsd,
          costUnknown: cost.unknown,
          responseId: result.responseId ?? null,
          responseModel: result.model,
          finishReason: result.finishReason ?? null,
          finishedAt: finished,
          updatedAt: finished,
        }
        await store.writeOutput(attempt.attemptId, result.text)
        await store.writeAttempt(
          appendAttemptCall(succeeded, {
            status: 'succeeded',
            startedAt: inFlight.startedAt ?? finished,
            finishedAt: finished,
            reservedUsd: reserve,
            failure: null,
            usage,
            costUsd: cost.costUsd,
            costUnknown: cost.unknown,
            responseId: result.responseId ?? null,
            responseModel: result.model,
            finishReason: result.finishReason ?? null,
          }),
        )
        inFlightRecord = null
        if (row.kind === 'continuation' && row.step !== null) {
          await reopenDependents(row.model, row.step)
        }
      } catch (error) {
        const failure = classifyGatewayError(error)
        const carried = carriedFailureFields(
          error,
          attempt.model,
          config.priceTable,
        )
        if (inFlightRecord !== null) {
          // A reservation (and possibly the network call) already happened.
          // Preserve the LATEST persisted record — accumulated reserve, prompt
          // hash, timestamps and per-call history — and mark it uncertain so
          // an explicit retry decides the outcome. Never revert to the
          // pre-flight attempt.
          const latest = await store.readAttempt(attempt.attemptId)
          const finished = now()
          const uncertainState: PersistedAttempt = {
            ...latest,
            status: 'uncertain',
            failure,
            finishedAt: finished,
            updatedAt: finished,
            ...(carried ?? {}),
          }
          await store.writeAttempt(
            appendAttemptCall(uncertainState, {
              status: 'uncertain',
              startedAt: latest.startedAt ?? finished,
              finishedAt: finished,
              reservedUsd: unrecordedReserve(latest),
              failure,
              usage: uncertainState.usage,
              costUsd: uncertainState.costUsd,
              costUnknown: true,
              responseId: uncertainState.responseId,
              responseModel: uncertainState.responseModel,
              finishReason: uncertainState.finishReason,
            }),
          )
        } else {
          const finished = now()
          const failedState: PersistedAttempt = {
            ...attempt,
            status: 'failed',
            failure,
            finishedAt: finished,
            updatedAt: finished,
            ...(carried ?? {}),
          }
          await store.writeAttempt(
            appendAttemptCall(failedState, {
              status: 'failed',
              startedAt: finished,
              finishedAt: finished,
              reservedUsd: 0,
              failure,
              usage: failedState.usage,
              costUsd: failedState.costUsd,
              costUnknown: failedState.costUnknown,
              responseId: failedState.responseId,
              responseModel: failedState.responseModel,
              finishReason: failedState.finishReason,
            }),
          )
        }
        if (row.kind === 'continuation' && row.step !== null) {
          await blockDependents(row.model, row.step)
        }
      }
    }

    const finalAttempts = await store.listAttempts()
    if (stoppedReason === null) {
      // 'completed' means EVERY planned attempt reached succeeded. Any attempt
      // still failed/blocked/pending/in-flight/uncertain keeps the run
      // incomplete (explicit --retry-failed is required to finish it).
      const allSucceeded = finalAttempts.every(
        (attempt) => attempt.status === 'succeeded',
      )
      stoppedReason = allSucceeded ? 'completed' : 'incomplete'
    }
    return buildReport(
      root,
      false,
      config,
      state,
      finalAttempts,
      gatewayCalls,
      finalAttempts.reduce(
        (sum, attempt) => sum + attempt.reservedUsd,
        0,
      ),
      stoppedReason,
    )
  } finally {
    await store.releaseLock(token)
  }
}
