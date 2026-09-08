import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from '@writex/workspace'
import type { GenerationUsage } from '@writex/contracts'
import type { DeepSeekModelId } from '@writex/model-gateway'
import {
  blindGroupIds,
  continuityTaskId,
  continuationStepNumbers,
  evaluationAttemptSchemaVersion,
  evaluationDiagnosisSchemaVersion,
  sceneTaskIds,
  type AttemptCallRecord,
  type AttemptFailure,
  type BlindGroupId,
  type BlindLabel,
  type DiagnosisResult,
  type DiagnosisStatus,
  type EvaluationConfig,
  type FailureKind,
  type PersistedAttempt,
  type PersistedDiagnosis,
} from './contracts.js'
import {
  currentFixtureHash,
  serializeFixtures,
  sha256Hex,
} from './fixtures.js'
import { parseEvaluationConfig, serializeEvaluationConfig } from './config.js'

export type EvaluationClock = () => string

function defaultClock(): string {
  return new Date().toISOString()
}

export interface InitSummary {
  root: string
  configHash: string
  fixtureHash: string
}

interface StateFile {
  schemaVersion: 1
  configHash: string
  fixtureHash: string
  createdAt: string
  updatedAt: string
}

interface LockFile {
  schemaVersion: 1
  pid: number
  token: string
  createdAt: string
}

export interface StorePaths {
  root: string
  configPath: string
  fixturesPath: string
  statePath: string
  lockPath: string
  attemptsDir: string
  outputsDir: string
  blindMappingPath: string
  blindExportDir: string
  ballotPath: string
  diagnosesDir: string
}

export function storePaths(root: string): StorePaths {
  return {
    root,
    configPath: join(root, 'config.json'),
    fixturesPath: join(root, 'fixtures.json'),
    statePath: join(root, 'state.json'),
    lockPath: join(root, 'lock.json'),
    attemptsDir: join(root, 'attempts'),
    outputsDir: join(root, 'outputs'),
    blindMappingPath: join(root, 'blind', 'mapping.json'),
    blindExportDir: join(root, 'blind', 'exports'),
    ballotPath: join(root, 'ballot.json'),
    diagnosesDir: join(root, 'diagnoses'),
  }
}

export const attemptIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

const windowsReservedBaseNames = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

/**
 * Reject an attemptId that is not one safe path segment: too long, wrong
 * characters, or a name that is unusable on Windows (reserved device base
 * name such as CON/NUL, or a trailing dot/space before the extension).
 */
export function assertValidAttemptId(attemptId: string): void {
  if (!attemptIdPattern.test(attemptId) || /[. ]$/.test(attemptId)) {
    throw new Error(`invalid attemptId: ${attemptId}`)
  }
  const baseName = (attemptId.split('.')[0] ?? '').toUpperCase()
  if (windowsReservedBaseNames.has(baseName)) {
    throw new Error(`invalid attemptId: ${attemptId}`)
  }
}

const attemptStatuses = new Set([
  'pending',
  'in-flight',
  'succeeded',
  'failed',
  'uncertain',
  'blocked',
])

/** Must stay in sync with the FailureKind union in contracts.ts. */
const failureKinds = new Set([
  'auth',
  'rate-limit',
  'server',
  'network',
  'timeout',
  'invalid-response',
  'empty-content',
  'truncated',
  'config',
  'error',
])

const evaluationModelIds: readonly DeepSeekModelId[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
]

const hex64 = /^[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function invalidAttempt(attemptId: string, reason: string): never {
  throw new Error(`invalid persisted attempt (${reason}): ${attemptId}`)
}

function parseNullableUsage(value: unknown, attemptId: string): GenerationUsage | null {
  if (value === null) {
    return null
  }
  if (!isRecord(value)) {
    invalidAttempt(attemptId, 'usage must be null or an object')
  }
  const allowed = new Set([
    'inputTokens',
    'outputTokens',
    'cacheHitInputTokens',
    'cacheMissInputTokens',
    'reasoningTokens',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalidAttempt(attemptId, `usage has unknown field ${key}`)
    }
  }
  const usage: GenerationUsage = {}
  for (const field of allowed) {
    const entry = value[field]
    if (entry === undefined) {
      continue
    }
    if (
      typeof entry !== 'number' ||
      !Number.isFinite(entry) ||
      !Number.isInteger(entry) ||
      entry < 0
    ) {
      invalidAttempt(attemptId, `usage.${field} must be a non-negative integer`)
    }
    usage[field as keyof GenerationUsage] = entry as number
  }
  return usage
}

const attemptCallStatuses = new Set(['failed', 'uncertain', 'succeeded'])

function parseCallFailure(value: unknown, attemptId: string): AttemptFailure | null {
  if (value === null) {
    return null
  }
  if (!isRecord(value)) {
    invalidAttempt(attemptId, 'call failure must be null or an object')
  }
  for (const key of Object.keys(value)) {
    if (key !== 'kind' && key !== 'message') {
      invalidAttempt(attemptId, `call failure has unknown field ${key}`)
    }
  }
  if (
    typeof value.kind !== 'string' ||
    !failureKinds.has(value.kind)
  ) {
    invalidAttempt(attemptId, 'call failure kind')
  }
  if (!nonBlankString(value.message)) {
    invalidAttempt(attemptId, 'call failure message')
  }
  return {
    kind: value.kind as FailureKind,
    message: value.message as string,
  }
}

/** Validate the per-call history array; missing history parses as `[]`. */
function parseAttemptCalls(
  value: unknown,
  attemptId: string,
): AttemptCallRecord[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    invalidAttempt(attemptId, 'attemptCalls must be an array')
  }
  const calls: AttemptCallRecord[] = []
  let previousSeq = 0
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) {
      invalidAttempt(attemptId, `attemptCalls[${index}] must be an object`)
    }
    const allowed = new Set([
      'seq',
      'status',
      'startedAt',
      'finishedAt',
      'reservedUsd',
      'failure',
      'usage',
      'costUsd',
      'costUnknown',
      'responseId',
      'responseModel',
      'finishReason',
    ])
    for (const key of Object.keys(item)) {
      if (!allowed.has(key)) {
        invalidAttempt(attemptId, `attemptCalls[${index}] has unknown field ${key}`)
      }
    }
    if (
      !Number.isInteger(item.seq) ||
      (item.seq as number) < 1 ||
      (item.seq as number) <= previousSeq
    ) {
      invalidAttempt(attemptId, `attemptCalls[${index}].seq must strictly increase`)
    }
    previousSeq = item.seq as number
    if (
      typeof item.status !== 'string' ||
      !attemptCallStatuses.has(item.status)
    ) {
      invalidAttempt(attemptId, `attemptCalls[${index}].status`)
    }
    if (!nonBlankString(item.startedAt)) {
      invalidAttempt(attemptId, `attemptCalls[${index}].startedAt must be a string`)
    }
    if (item.finishedAt !== null && !nonBlankString(item.finishedAt)) {
      invalidAttempt(attemptId, `attemptCalls[${index}].finishedAt must be null or a string`)
    }
    if (!finiteNonNegative(item.reservedUsd)) {
      invalidAttempt(attemptId, `attemptCalls[${index}].reservedUsd must be finite and non-negative`)
    }
    if (item.costUsd !== null && !finiteNonNegative(item.costUsd)) {
      invalidAttempt(attemptId, `attemptCalls[${index}].costUsd must be null or finite non-negative`)
    }
    if (typeof item.costUnknown !== 'boolean') {
      invalidAttempt(attemptId, `attemptCalls[${index}].costUnknown must be a boolean`)
    }
    for (const field of ['responseId', 'responseModel', 'finishReason'] as const) {
      const entry = item[field]
      if (entry !== null && !nonBlankString(entry)) {
        invalidAttempt(attemptId, `attemptCalls[${index}].${field} must be null or a string`)
      }
    }
    calls.push({
      seq: item.seq as number,
      status: item.status as AttemptCallRecord['status'],
      startedAt: item.startedAt as string,
      finishedAt: item.finishedAt as string | null,
      reservedUsd: item.reservedUsd as number,
      failure: parseCallFailure(item.failure, attemptId),
      usage: parseNullableUsage(item.usage, attemptId),
      costUsd: item.costUsd as number | null,
      costUnknown: item.costUnknown as boolean,
      responseId: item.responseId as string | null,
      responseModel: item.responseModel as string | null,
      finishReason: item.finishReason as string | null,
    })
  }
  return calls
}

/**
 * Parse and FULLY validate a persisted attempt. Every field that budgeting,
 * task identity or recovery depends on is checked (never a cast after
 * superficial checks): statuses, model/task/kind/step consistency, hex
 * hashes, non-negative finite money fields, timestamps, usage and failure.
 */
function parseAttempt(raw: string, attemptId: string): PersistedAttempt {
  assertValidAttemptId(attemptId)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    invalidAttempt(attemptId, 'not JSON')
  }
  if (!isRecord(value)) {
    invalidAttempt(attemptId, 'not an object')
  }

  const expectedKeys = new Set([
    'schemaVersion',
    'attemptId',
    'model',
    'taskId',
    'kind',
    'step',
    'status',
    'createdAt',
    'updatedAt',
    'configHash',
    'fixtureHash',
    'promptHash',
    'reservedUsd',
    'blockReason',
    'failure',
    'responseId',
    'responseModel',
    'finishReason',
    'usage',
    'costUsd',
    'costUnknown',
    'startedAt',
    'finishedAt',
    'attemptCalls',
  ])
  for (const key of Object.keys(value)) {
    if (!expectedKeys.has(key)) {
      invalidAttempt(attemptId, `unknown field ${key}`)
    }
  }

  if (value.schemaVersion !== evaluationAttemptSchemaVersion) {
    invalidAttempt(attemptId, 'schema version')
  }
  if (value.attemptId !== attemptId) {
    invalidAttempt(attemptId, 'id mismatch')
  }
  if (typeof value.status !== 'string' || !attemptStatuses.has(value.status)) {
    invalidAttempt(attemptId, 'status')
  }
  if (
    typeof value.model !== 'string' ||
    !evaluationModelIds.includes(value.model as DeepSeekModelId)
  ) {
    invalidAttempt(attemptId, 'model')
  }
  if (typeof value.taskId !== 'string') {
    invalidAttempt(attemptId, 'taskId')
  }
  if (value.kind !== 'scene' && value.kind !== 'continuation') {
    invalidAttempt(attemptId, 'kind')
  }
  const isScene = value.kind === 'scene'
  const taskId = value.taskId
  if (isScene) {
    if (!sceneTaskIds.includes(taskId as (typeof sceneTaskIds)[number])) {
      invalidAttempt(attemptId, 'taskId not a scene')
    }
  } else if (taskId !== continuityTaskId) {
    invalidAttempt(attemptId, 'taskId not the continuity task')
  }
  if (value.step === null) {
    if (!isScene) {
      invalidAttempt(attemptId, 'continuation requires a step')
    }
  } else if (
    !Number.isInteger(value.step) ||
    (value.step as number) < 1 ||
    (value.step as number) > continuationStepNumbers.length
  ) {
    invalidAttempt(attemptId, 'step')
  } else if (isScene) {
    invalidAttempt(attemptId, 'scene must have a null step')
  }

  for (const field of ['createdAt', 'updatedAt', 'startedAt', 'finishedAt'] as const) {
    const entry = value[field]
    if (entry !== null && !nonBlankString(entry)) {
      invalidAttempt(attemptId, `${field} must be null or a string`)
    }
  }
  if (
    !nonBlankString(value.configHash) ||
    !hex64.test(value.configHash) ||
    !nonBlankString(value.fixtureHash) ||
    !hex64.test(value.fixtureHash)
  ) {
    invalidAttempt(attemptId, 'config/fixture hash must be 64 hex chars')
  }
  if (
    value.promptHash !== null &&
    (!nonBlankString(value.promptHash) || !hex64.test(value.promptHash))
  ) {
    invalidAttempt(attemptId, 'promptHash must be null or 64 hex chars')
  }
  if (!finiteNonNegative(value.reservedUsd)) {
    invalidAttempt(attemptId, 'reservedUsd must be finite and non-negative')
  }
  if (value.costUsd !== null && !finiteNonNegative(value.costUsd)) {
    invalidAttempt(attemptId, 'costUsd must be null or finite non-negative')
  }
  if (typeof value.costUnknown !== 'boolean') {
    invalidAttempt(attemptId, 'costUnknown must be a boolean')
  }
  if (
    value.blockReason !== null &&
    value.blockReason !== 'dependent-failure'
  ) {
    invalidAttempt(attemptId, 'blockReason')
  }

  let failure: PersistedAttempt['failure'] = null
  if (value.failure !== null) {
    if (!isRecord(value.failure)) {
      invalidAttempt(attemptId, 'failure must be null or an object')
    }
    for (const key of Object.keys(value.failure)) {
      if (key !== 'kind' && key !== 'message') {
        invalidAttempt(attemptId, `failure has unknown field ${key}`)
      }
    }
    if (
      typeof value.failure.kind !== 'string' ||
      !failureKinds.has(value.failure.kind)
    ) {
      invalidAttempt(attemptId, 'failure kind')
    }
    if (!nonBlankString(value.failure.message)) {
      invalidAttempt(attemptId, 'failure message')
    }
    failure = {
      kind: value.failure.kind as FailureKind,
      message: value.failure.message as string,
    }
  }

  for (const field of ['responseId', 'responseModel', 'finishReason'] as const) {
    const entry = value[field]
    if (entry !== null && !nonBlankString(entry)) {
      invalidAttempt(attemptId, `${field} must be null or a string`)
    }
  }
  const usage = parseNullableUsage(value.usage, attemptId)
  const attemptCalls = parseAttemptCalls(value.attemptCalls, attemptId)

  const attempt: PersistedAttempt = {
    schemaVersion: evaluationAttemptSchemaVersion,
    attemptId,
    model: value.model as DeepSeekModelId,
    taskId: taskId as PersistedAttempt['taskId'],
    kind: value.kind,
    step: value.step as PersistedAttempt['step'],
    status: value.status as PersistedAttempt['status'],
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    configHash: value.configHash as string,
    fixtureHash: value.fixtureHash as string,
    promptHash: value.promptHash as string | null,
    reservedUsd: value.reservedUsd as number,
    blockReason: value.blockReason as PersistedAttempt['blockReason'],
    failure,
    responseId: value.responseId as string | null,
    responseModel: value.responseModel as string | null,
    finishReason: value.finishReason as string | null,
    usage,
    costUsd: value.costUsd as number | null,
    costUnknown: value.costUnknown as boolean,
    startedAt: value.startedAt as string | null,
    finishedAt: value.finishedAt as string | null,
  }
  // Keep the property absent on legacy files so round-trips stay byte-equal;
  // callers read history via `attempt.attemptCalls ?? []`.
  if (attemptCalls.length > 0 || value.attemptCalls !== undefined) {
    attempt.attemptCalls = attemptCalls
  }
  return attempt
}

/** A lock record is only ever considered valid when every field checks out. */
function isValidLockRecord(value: unknown): value is LockFile {
  if (!isRecord(value)) {
    return false
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    nonBlankString(value.token) &&
    nonBlankString(value.createdAt)
  )
}

const diagnosisStatuses = new Set([
  'pending',
  'in-flight',
  'succeeded',
  'failed',
  'uncertain',
])

const blindGroupIdSet: ReadonlySet<string> = new Set(blindGroupIds)

function invalidDiagnosis(diagnosisId: string, reason: string): never {
  throw new Error(`invalid persisted diagnosis (${reason}): ${diagnosisId}`)
}

/** Fully validate one persisted diagnosis record before trusting its fields. */
function parseDiagnosis(raw: string, diagnosisId: string): PersistedDiagnosis {
  assertValidAttemptId(diagnosisId)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    invalidDiagnosis(diagnosisId, 'not JSON')
  }
  if (!isRecord(value)) {
    invalidDiagnosis(diagnosisId, 'not an object')
  }
  const allowed = new Set([
    'schemaVersion',
    'diagnosisId',
    'groupId',
    'label',
    'model',
    'status',
    'createdAt',
    'updatedAt',
    'configHash',
    'fixtureHash',
    'promptHash',
    'reservedUsd',
    'failure',
    'responseId',
    'responseModel',
    'finishReason',
    'usage',
    'costUsd',
    'costUnknown',
    'startedAt',
    'finishedAt',
    'sourceHash',
    'resultHash',
    'attemptCalls',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalidDiagnosis(diagnosisId, `unknown field ${key}`)
    }
  }
  if (value.schemaVersion !== evaluationDiagnosisSchemaVersion) {
    invalidDiagnosis(diagnosisId, 'schema version')
  }
  if (value.diagnosisId !== diagnosisId) {
    invalidDiagnosis(diagnosisId, 'id mismatch')
  }
  if (typeof value.groupId !== 'string' || !blindGroupIdSet.has(value.groupId)) {
    invalidDiagnosis(diagnosisId, 'groupId')
  }
  if (value.label !== 'A' && value.label !== 'B') {
    invalidDiagnosis(diagnosisId, 'label')
  }
  if (
    typeof value.model !== 'string' ||
    !evaluationModelIds.includes(value.model as DeepSeekModelId)
  ) {
    invalidDiagnosis(diagnosisId, 'model')
  }
  if (
    typeof value.status !== 'string' ||
    !diagnosisStatuses.has(value.status)
  ) {
    invalidDiagnosis(diagnosisId, 'status')
  }
  for (const field of ['createdAt', 'updatedAt', 'startedAt', 'finishedAt'] as const) {
    const entry = value[field]
    if (entry !== null && !nonBlankString(entry)) {
      invalidDiagnosis(diagnosisId, `${field} must be null or a string`)
    }
  }
  for (const field of ['configHash', 'fixtureHash'] as const) {
    if (!nonBlankString(value[field]) || !hex64.test(value[field] as string)) {
      invalidDiagnosis(diagnosisId, `${field} must be 64 hex chars`)
    }
  }
  for (const field of ['promptHash', 'sourceHash', 'resultHash'] as const) {
    const entry = value[field]
    if (entry !== null && (!nonBlankString(entry) || !hex64.test(entry))) {
      invalidDiagnosis(diagnosisId, `${field} must be null or 64 hex chars`)
    }
  }
  if (!finiteNonNegative(value.reservedUsd)) {
    invalidDiagnosis(diagnosisId, 'reservedUsd must be finite and non-negative')
  }
  if (value.costUsd !== null && !finiteNonNegative(value.costUsd)) {
    invalidDiagnosis(diagnosisId, 'costUsd must be null or finite non-negative')
  }
  if (typeof value.costUnknown !== 'boolean') {
    invalidDiagnosis(diagnosisId, 'costUnknown must be a boolean')
  }
  for (const field of ['responseId', 'responseModel', 'finishReason'] as const) {
    const entry = value[field]
    if (entry !== null && !nonBlankString(entry)) {
      invalidDiagnosis(diagnosisId, `${field} must be null or a string`)
    }
  }
  const usage = parseNullableUsage(value.usage, diagnosisId)
  const attemptCalls = parseAttemptCalls(value.attemptCalls, diagnosisId)
  let failure: PersistedDiagnosis['failure'] = null
  if (value.failure !== null) {
    if (!isRecord(value.failure)) {
      invalidDiagnosis(diagnosisId, 'failure must be null or an object')
    }
    for (const key of Object.keys(value.failure)) {
      if (key !== 'kind' && key !== 'message') {
        invalidDiagnosis(diagnosisId, `failure has unknown field ${key}`)
      }
    }
    if (
      typeof value.failure.kind !== 'string' ||
      !failureKinds.has(value.failure.kind)
    ) {
      invalidDiagnosis(diagnosisId, 'failure kind')
    }
    if (!nonBlankString(value.failure.message)) {
      invalidDiagnosis(diagnosisId, 'failure message')
    }
    failure = {
      kind: value.failure.kind as FailureKind,
      message: value.failure.message as string,
    }
  }
  const diagnosis: PersistedDiagnosis = {
    schemaVersion: evaluationDiagnosisSchemaVersion,
    diagnosisId,
    groupId: value.groupId as BlindGroupId,
    label: value.label as BlindLabel,
    model: value.model as DeepSeekModelId,
    status: value.status as DiagnosisStatus,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
    configHash: value.configHash as string,
    fixtureHash: value.fixtureHash as string,
    promptHash: value.promptHash as string | null,
    reservedUsd: value.reservedUsd as number,
    failure,
    responseId: value.responseId as string | null,
    responseModel: value.responseModel as string | null,
    finishReason: value.finishReason as string | null,
    usage,
    costUsd: value.costUsd as number | null,
    costUnknown: value.costUnknown as boolean,
    startedAt: value.startedAt as string | null,
    finishedAt: value.finishedAt as string | null,
    sourceHash: value.sourceHash as string | null,
    resultHash: value.resultHash as string | null,
  }
  // Keep the property absent on legacy files (round-trip parity); callers use
  // `diagnosis.attemptCalls ?? []`.
  if (attemptCalls.length > 0 || value.attemptCalls !== undefined) {
    diagnosis.attemptCalls = attemptCalls
  }
  return diagnosis
}

/** Reconstruct and fully validate a persisted DiagnosisResult JSON file. */
function parseDiagnosisResult(raw: string, diagnosisId: string): DiagnosisResult {
  assertValidAttemptId(diagnosisId)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    invalidDiagnosis(diagnosisId, 'result is not JSON')
  }
  if (!isRecord(value)) {
    invalidDiagnosis(diagnosisId, 'result is not an object')
  }
  const allowed = new Set([
    'schemaVersion',
    'diagnosisId',
    'groupId',
    'label',
    'model',
    'createdAt',
    'sourceHash',
    'evaluation',
    'continuityIssues',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalidDiagnosis(diagnosisId, `result has unknown field ${key}`)
    }
  }
  if (value.schemaVersion !== evaluationDiagnosisSchemaVersion) {
    invalidDiagnosis(diagnosisId, 'result schema version')
  }
  if (value.diagnosisId !== diagnosisId) {
    invalidDiagnosis(diagnosisId, 'result id mismatch')
  }
  if (typeof value.groupId !== 'string' || !blindGroupIdSet.has(value.groupId)) {
    invalidDiagnosis(diagnosisId, 'result groupId')
  }
  if (value.label !== 'A' && value.label !== 'B') {
    invalidDiagnosis(diagnosisId, 'result label')
  }
  if (
    typeof value.model !== 'string' ||
    !evaluationModelIds.includes(value.model as DeepSeekModelId)
  ) {
    invalidDiagnosis(diagnosisId, 'result model')
  }
  if (!nonBlankString(value.createdAt) || !nonBlankString(value.sourceHash) || !hex64.test(value.sourceHash)) {
    invalidDiagnosis(diagnosisId, 'result createdAt/sourceHash')
  }
  if (!isRecord(value.evaluation)) {
    invalidDiagnosis(diagnosisId, 'result evaluation must be an object')
  }
  if (!Array.isArray(value.continuityIssues)) {
    invalidDiagnosis(diagnosisId, 'result continuityIssues must be an array')
  }
  return {
    schemaVersion: evaluationDiagnosisSchemaVersion,
    diagnosisId,
    groupId: value.groupId as BlindGroupId,
    label: value.label as BlindLabel,
    model: value.model as DeepSeekModelId,
    createdAt: value.createdAt as string,
    sourceHash: value.sourceHash as string,
    evaluation: value.evaluation as unknown as DiagnosisResult['evaluation'],
    continuityIssues: value.continuityIssues as unknown as DiagnosisResult['continuityIssues'],
  }
}

/**
 * Durable store for one evaluation run root. The root is created once by
 * `init` and is otherwise treated as immutable config/fixture state: any
 * external change to config.json or fixtures.json after init is detected by
 * hash comparison and refuses further work.
 */
export class EvaluationStore {
  private readonly root: string
  private readonly paths: StorePaths
  private readonly now: EvaluationClock

  constructor(root: string, now: EvaluationClock = defaultClock) {
    this.root = root
    this.paths = storePaths(root)
    this.now = now
  }

  /**
   * Create a fresh run root atomically (create-only). The parent is created
   * recursively first, then the root itself is claimed with a single
   * non-recursive mkdir so two racing initializers cannot both succeed and
   * cannot silently reuse an existing directory.
   */
  async init(config: EvaluationConfig): Promise<InitSummary> {
    await mkdir(dirname(this.root), { recursive: true })
    try {
      await mkdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(
          `evaluation run root already exists (create-only): ${this.root}`,
        )
      }
      throw error
    }
    await mkdir(this.paths.attemptsDir, { recursive: true })
    await mkdir(this.paths.outputsDir, { recursive: true })

    const configText = serializeEvaluationConfig(config)
    const configHash = sha256Hex(configText)
    const fixturesText = serializeFixtures()
    const fixtureHash = currentFixtureHash()
    const now = this.now()
    const state: StateFile = {
      schemaVersion: 1,
      configHash,
      fixtureHash,
      createdAt: now,
      updatedAt: now,
    }
    await atomicWriteFile(this.paths.configPath, configText)
    await atomicWriteFile(this.paths.fixturesPath, fixturesText)
    await atomicWriteFile(
      this.paths.statePath,
      `${JSON.stringify(state, null, 2)}\n`,
    )
    return { root: this.root, configHash, fixtureHash }
  }

  private async readStateFile(): Promise<StateFile> {
    const raw = await readFile(this.paths.statePath, 'utf8')
    const value: unknown = JSON.parse(raw)
    if (!isRecord(value)) {
      throw new Error('invalid evaluation run state (not an object)')
    }
    if (
      value.schemaVersion !== 1 ||
      typeof value.configHash !== 'string' ||
      typeof value.fixtureHash !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.updatedAt !== 'string'
    ) {
      throw new Error('invalid evaluation run state (shape)')
    }
    return value as unknown as StateFile
  }

  /**
   * Refuse to work when the persisted config/fixtures no longer match what
   * was recorded at init (immutable run-root contract).
   */
  async assertUsable(): Promise<void> {
    const state = await this.readStateFile()
    const configText = await readFile(this.paths.configPath, 'utf8')
    if (sha256Hex(configText) !== state.configHash) {
      throw new Error(
        `config.json changed since run initialization (hash mismatch); run root is immutable: ${this.root}`,
      )
    }
    const fixturesText = await readFile(this.paths.fixturesPath, 'utf8')
    if (sha256Hex(fixturesText) !== state.fixtureHash) {
      throw new Error(
        `fixtures.json changed since run initialization (hash mismatch); run root is immutable: ${this.root}`,
      )
    }
    if (currentFixtureHash() !== state.fixtureHash) {
      throw new Error(
        'evaluation fixtures in code changed since run initialization; create a new run root',
      )
    }
  }

  /** Parse and validate the stored config (still verifying immutability). */
  async readConfig(): Promise<EvaluationConfig> {
    await this.assertUsable()
    const text = await readFile(this.paths.configPath, 'utf8')
    return parseEvaluationConfig(JSON.parse(text), this.paths.configPath)
  }

  async readState(): Promise<StateFile> {
    return this.readStateFile()
  }

  async listAttemptIds(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.paths.attemptsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  }

  async listAttempts(): Promise<PersistedAttempt[]> {
    const attempts: PersistedAttempt[] = []
    for (const attemptId of await this.listAttemptIds()) {
      attempts.push(await this.readAttempt(attemptId))
    }
    return attempts
  }

  async readAttempt(attemptId: string): Promise<PersistedAttempt> {
    assertValidAttemptId(attemptId)
    const raw = await readFile(
      join(this.paths.attemptsDir, `${attemptId}.json`),
      'utf8',
    )
    return parseAttempt(raw, attemptId)
  }

  async writeAttempt(attempt: PersistedAttempt): Promise<void> {
    assertValidAttemptId(attempt.attemptId)
    await atomicWriteFile(
      join(this.paths.attemptsDir, `${attempt.attemptId}.json`),
      `${JSON.stringify(attempt, null, 2)}\n`,
    )
  }

  async writeOutput(attemptId: string, text: string): Promise<void> {
    assertValidAttemptId(attemptId)
    await atomicWriteFile(join(this.paths.outputsDir, `${attemptId}.txt`), text)
  }

  async readOutput(attemptId: string): Promise<string> {
    assertValidAttemptId(attemptId)
    return readFile(join(this.paths.outputsDir, `${attemptId}.txt`), 'utf8')
  }

  private diagnosisRecordPath(diagnosisId: string): string {
    return join(this.paths.diagnosesDir, `${diagnosisId}.json`)
  }

  private diagnosisResultPath(diagnosisId: string): string {
    return join(this.paths.diagnosesDir, `${diagnosisId}.result.json`)
  }

  async listDiagnosisIds(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(this.paths.diagnosesDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
    return names
      .filter(
        (name) => name.endsWith('.json') && !name.endsWith('.result.json'),
      )
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  }

  async listDiagnoses(): Promise<PersistedDiagnosis[]> {
    const diagnoses: PersistedDiagnosis[] = []
    for (const diagnosisId of await this.listDiagnosisIds()) {
      diagnoses.push(await this.readDiagnosis(diagnosisId))
    }
    return diagnoses
  }

  async readDiagnosis(diagnosisId: string): Promise<PersistedDiagnosis> {
    assertValidAttemptId(diagnosisId)
    const raw = await readFile(this.diagnosisRecordPath(diagnosisId), 'utf8')
    return parseDiagnosis(raw, diagnosisId)
  }

  async writeDiagnosis(diagnosis: PersistedDiagnosis): Promise<void> {
    assertValidAttemptId(diagnosis.diagnosisId)
    await atomicWriteFile(
      this.diagnosisRecordPath(diagnosis.diagnosisId),
      `${JSON.stringify(diagnosis, null, 2)}\n`,
    )
  }

  async writeDiagnosisResult(result: DiagnosisResult): Promise<void> {
    assertValidAttemptId(result.diagnosisId)
    await atomicWriteFile(
      this.diagnosisResultPath(result.diagnosisId),
      `${JSON.stringify(result, null, 2)}\n`,
    )
  }

  async readDiagnosisResult(diagnosisId: string): Promise<DiagnosisResult> {
    assertValidAttemptId(diagnosisId)
    const raw = await readFile(
      this.diagnosisResultPath(diagnosisId),
      'utf8',
    )
    return parseDiagnosisResult(raw, diagnosisId)
  }

  /** Raw persisted result text, used to re-verify `resultHash` on read. */
  async readDiagnosisResultText(diagnosisId: string): Promise<string> {
    assertValidAttemptId(diagnosisId)
    return readFile(this.diagnosisResultPath(diagnosisId), 'utf8')
  }

  /**
   * Acquire an exclusive writer lock by atomically creating lock.json with
   * `wx`. If a lock already exists this FAILS CLOSED: malformed, partial or
   * stale locks are never deleted here (deleting could race another writer
   * that just won the directory), so the caller gets explicit recovery
   * guidance instead. Returns the token used by `releaseLock`.
   */
  async acquireLock(): Promise<string> {
    const token = randomUUID()
    const record: LockFile = {
      schemaVersion: 1,
      pid: process.pid,
      token,
      createdAt: this.now(),
    }
    const payload = `${JSON.stringify(record)}\n`

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(this.paths.lockPath, payload, { flag: 'wx' })
        return token
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error
        }
      }
      let raw: string
      try {
        raw = await readFile(this.paths.lockPath, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue // The lock vanished between create and read; retry once.
        }
        throw new Error(`cannot read evaluation run lock: ${this.paths.lockPath}`)
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        throw new Error(
          `evaluation run root lock is present but malformed; if no run is active, remove ${this.paths.lockPath} manually and retry`,
        )
      }
      if (!isValidLockRecord(parsed)) {
        throw new Error(
          `evaluation run root lock is present but invalid; if no run is active, remove ${this.paths.lockPath} manually and retry`,
        )
      }
      throw new Error(
        `evaluation run root is locked by process ${parsed.pid} (created ${parsed.createdAt}); if that process is no longer running, remove ${this.paths.lockPath} manually and retry`,
      )
    }
    throw new Error(`could not acquire evaluation run lock: ${this.paths.lockPath}`)
  }

  /**
   * Release the writer lock only when it still belongs to `token`. Ownership
   * problems and unreadable/malformed locks are reported; a missing lock
   * (ENOENT) is the only silent case.
   */
  async releaseLock(token: string): Promise<void> {
    let raw: string
    try {
      raw = await readFile(this.paths.lockPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return
      }
      throw new Error(`cannot release evaluation run lock (unreadable): ${this.paths.lockPath}`)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(
        `cannot release evaluation run lock (malformed): ${this.paths.lockPath}`,
      )
    }
    if (!isValidLockRecord(parsed)) {
      throw new Error(
        `cannot release evaluation run lock (invalid record): ${this.paths.lockPath}`,
      )
    }
    if (parsed.token !== token) {
      throw new Error(
        'cannot release evaluation run lock: it is owned by another process',
      )
    }
    await rm(this.paths.lockPath, { force: true })
  }

  /**
   * A run that crashed mid-flight leaves attempts in `in-flight`. Those
   * requests may or may not have completed server-side, so they become
   * `uncertain` and require an explicit retry. Their reserve is retained.
   */
  async recoverInterruptedInFlight(): Promise<number> {
    const changed = []
    for (const attempt of await this.listAttempts()) {
      if (attempt.status === 'in-flight') {
        const history = attempt.attemptCalls ?? []
        const pastReserved = history.reduce(
          (sum, call) => sum + call.reservedUsd,
          0,
        )
        const callReserve = Math.max(0, attempt.reservedUsd - pastReserved)
        const finishedAt = this.now()
        const recovered: PersistedAttempt = {
          ...attempt,
          status: 'uncertain',
          failure: null,
          finishedAt,
          updatedAt: finishedAt,
          attemptCalls: [
            ...history,
            {
              seq: history.length + 1,
              status: 'uncertain',
              startedAt: attempt.startedAt ?? finishedAt,
              finishedAt,
              reservedUsd: callReserve,
              failure: null,
              usage: null,
              costUsd: null,
              costUnknown: true,
              responseId: null,
              responseModel: null,
              finishReason: null,
            },
          ],
        }
        await this.writeAttempt(recovered)
        changed.push(attempt.attemptId)
      }
    }
    return changed.length
  }
}
