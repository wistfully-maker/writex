import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DeepSeekModelId } from '@writex/model-gateway'
import { atomicWriteFile } from '@writex/workspace'
import {
  blindGroupIds,
  continuityTaskId,
  continuationStepNumbers,
  evaluationBlindSchemaVersion,
  type BlindGroupAssignment,
  type BlindGroupId,
  type BlindLabel,
  type BlindMapping,
} from './contracts.js'
import {
  continuityFixedBrief,
  continuityStageTasks,
  sceneInstructions,
  sha256Hex,
} from './fixtures.js'
import { attemptIdFor, buildPlanRows } from './runner.js'
import { EvaluationStore, storePaths } from './store.js'

export type RandomSource = () => number

const hex64 = /^[0-9a-f]{64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function invalidMapping(message: string): never {
  throw new Error(`invalid blind mapping: ${message}`)
}

/** Fisher-Yates shuffle with an injectable random source (tests stay deterministic). */
export function shuffleWith<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const pick = Math.min(
      result.length - 1,
      Math.max(0, Math.floor(random() * (index + 1))),
    )
    const swap = result[index]
    result[index] = result[pick] as T
    result[pick] = swap as T
  }
  return result
}

export function serializedMapping(mapping: BlindMapping): string {
  return `${JSON.stringify(mapping, null, 2)}\n`
}

export function mappingHash(mapping: BlindMapping): string {
  return sha256Hex(serializedMapping(mapping))
}

function parseMapping(raw: string): BlindMapping {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    invalidMapping('not JSON')
  }
  if (!isRecord(value)) {
    invalidMapping('not an object')
  }
  const allowed = new Set([
    'schemaVersion',
    'configHash',
    'fixtureHash',
    'createdAt',
    'groups',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalidMapping(`unknown field ${key}`)
    }
  }
  if (value.schemaVersion !== evaluationBlindSchemaVersion) {
    invalidMapping('schema version')
  }
  for (const field of ['configHash', 'fixtureHash'] as const) {
    if (!nonBlankString(value[field]) || !hex64.test(value[field] as string)) {
      invalidMapping(`${field} must be 64 hex chars`)
    }
  }
  if (!nonBlankString(value.createdAt)) {
    invalidMapping('createdAt must be a string')
  }
  if (!isRecord(value.groups)) {
    invalidMapping('groups must be an object')
  }
  const groups = {} as Record<BlindGroupId, BlindGroupAssignment>
  const presentGroups = Object.keys(value.groups)
  const missing = blindGroupIds.filter((id) => !presentGroups.includes(id))
  const extra = presentGroups.filter((id) => !blindGroupIds.includes(id as BlindGroupId))
  if (missing.length > 0) {
    invalidMapping(`missing groups: ${missing.join(', ')}`)
  }
  if (extra.length > 0) {
    invalidMapping(`unknown groups: ${extra.join(', ')}`)
  }
  for (const groupId of blindGroupIds) {
    const assignment = value.groups[groupId]
    if (!isRecord(assignment)) {
      invalidMapping(`${groupId} must be an object`)
    }
    for (const key of Object.keys(assignment)) {
      if (key !== 'A' && key !== 'B') {
        invalidMapping(`${groupId} has unknown field ${key}`)
      }
    }
    if (
      assignment.A !== 'deepseek-v4-flash' &&
      assignment.A !== 'deepseek-v4-pro'
    ) {
      invalidMapping(`${groupId}.A model`)
    }
    if (
      assignment.B !== 'deepseek-v4-flash' &&
      assignment.B !== 'deepseek-v4-pro'
    ) {
      invalidMapping(`${groupId}.B model`)
    }
    if (assignment.A === assignment.B) {
      invalidMapping(`${groupId} must assign two different models`)
    }
    groups[groupId] = {
      A: assignment.A as DeepSeekModelId,
      B: assignment.B as DeepSeekModelId,
    }
  }
  return {
    schemaVersion: evaluationBlindSchemaVersion,
    configHash: value.configHash as string,
    fixtureHash: value.fixtureHash as string,
    createdAt: value.createdAt as string,
    groups,
  }
}

export async function readBlindMapping(root: string): Promise<BlindMapping> {
  const mappingPath = storePaths(root).blindMappingPath
  const store = new EvaluationStore(root)
  const state = await store.readState()
  const raw = await readFile(mappingPath, 'utf8')
  const mapping = parseMapping(raw)
  if (
    mapping.configHash !== state.configHash ||
    mapping.fixtureHash !== state.fixtureHash
  ) {
    throw new Error('blind mapping was created for a different run root')
  }
  return mapping
}

/**
 * Create the persisted label->model mapping exactly once and then reuse it.
 * FAIL CLOSED: an existing mapping that is corrupt, foreign or unreadable is
 * never overwritten — the caller gets the error and must repair the root.
 */
export async function createBlindMapping(
  root: string,
  options: { random?: RandomSource; now?: () => string } = {},
): Promise<BlindMapping> {
  const random = options.random ?? Math.random
  const now = options.now ?? (() => new Date().toISOString())
  const mappingPath = storePaths(root).blindMappingPath
  const store = new EvaluationStore(root)
  const state = await store.readState()
  try {
    return await readBlindMapping(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `cannot reuse existing blind mapping (${(error as Error).message}); fix or remove ${mappingPath} manually — never re-randomizes an existing mapping`,
      )
    }
  }
  const models: readonly DeepSeekModelId[] = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
  ]
  const groups = {} as Record<BlindGroupId, BlindGroupAssignment>
  for (const groupId of blindGroupIds) {
    const [first, second] = shuffleWith(models, random)
    groups[groupId] = { A: first as DeepSeekModelId, B: second as DeepSeekModelId }
  }
  const mapping: BlindMapping = {
    schemaVersion: evaluationBlindSchemaVersion,
    configHash: state.configHash,
    fixtureHash: state.fixtureHash,
    createdAt: now(),
    groups,
  }
  await atomicWriteFile(mappingPath, serializedMapping(mapping))
  return mapping
}

/** Task materials shown to the human voter for one blind group. */
export function groupMaterials(groupId: BlindGroupId): string {
  if (groupId === 'continuity') {
    const stages = continuationStepNumbers
      .map((step) => continuityStageTasks[step])
      .join('\n\n')
    return `${continuityFixedBrief}\n\n${stages}`
  }
  return sceneInstructions[groupId]
}

export interface CandidateManuscript {
  groupId: BlindGroupId
  label: BlindLabel
  model: DeepSeekModelId
  /** One draft segment per generation (scenes have one, continuity three). */
  segments: string[]
  /** SHA-256 over the canonical joined manuscript text. */
  sourceHash: string
}

export function candidateManuscriptText(manuscript: {
  segments: readonly string[]
}): string {
  return manuscript.segments.join('\n\n')
}

export function manuscriptSourceHash(segments: readonly string[]): string {
  return sha256Hex(segments.join('\n\n'))
}

/**
 * Resolve one blind candidate's drafts from the persisted outputs. Every
 * involved generation attempt must have succeeded or this refuses to load.
 */
export async function loadCandidateManuscript(
  root: string,
  groupId: BlindGroupId,
  label: BlindLabel,
): Promise<CandidateManuscript> {
  const mapping = await readBlindMapping(root)
  const model = mapping.groups[groupId][label]
  const store = new EvaluationStore(root)
  const attemptIds: string[] = []
  if (groupId === 'continuity') {
    for (const step of continuationStepNumbers) {
      attemptIds.push(attemptIdFor(model, continuityTaskId, step))
    }
  } else {
    attemptIds.push(attemptIdFor(model, groupId, null))
  }
  const segments: string[] = []
  for (const attemptId of attemptIds) {
    const attempt = await store.readAttempt(attemptId)
    if (attempt.status !== 'succeeded') {
      throw new Error(
        `blind artifacts require succeeded drafts; ${attemptId} is ${attempt.status}`,
      )
    }
    segments.push(await store.readOutput(attemptId))
  }
  return {
    groupId,
    label,
    model,
    segments,
    sourceHash: manuscriptSourceHash(segments),
  }
}

export async function modelForCandidate(
  root: string,
  groupId: BlindGroupId,
  label: BlindLabel,
): Promise<DeepSeekModelId> {
  const mapping = await readBlindMapping(root)
  return mapping.groups[groupId][label]
}

/**
 * Refuse to touch the run unless it is exactly the twelve planned drafts:
 * every planned id present, no extra rows, each attempt succeeded with
 * run-consistent hashes, and every output file readable. Also verifies the
 * persisted config/fixtures are unchanged (immutable run-root contract).
 */
export async function assertCompleteRun(root: string): Promise<void> {
  const store = new EvaluationStore(root)
  await store.assertUsable()
  const state = await store.readState()
  const planned = buildPlanRows()
    .map((row) => row.attemptId)
    .sort()
  const actual = (await store.listAttemptIds()).sort()
  if (
    actual.length !== planned.length ||
    actual.some((id, index) => id !== planned[index])
  ) {
    throw new Error(
      `run is not the exact twelve planned attempts; expected ${planned.join(', ')}, found ${actual.length === 0 ? 'none' : actual.join(', ')}`,
    )
  }
  for (const attemptId of actual) {
    const attempt = await store.readAttempt(attemptId)
    if (attempt.status !== 'succeeded') {
      throw new Error(`run is incomplete; ${attemptId} is ${attempt.status}`)
    }
    if (
      attempt.configHash !== state.configHash ||
      attempt.fixtureHash !== state.fixtureHash
    ) {
      throw new Error(
        `run is inconsistent; ${attemptId} hashes do not match this run root`,
      )
    }
    await store.readOutput(attemptId)
  }
}

/**
 * Deterministic SHA-256 over the twelve manuscripts (four groups x A/B, each
 * continuation group over its three segments). Binds a ballot to the exact
 * texts the human compared; any later draft change breaks the binding.
 */
export async function computeManuscriptsHash(root: string): Promise<string> {
  const mapping = await readBlindMapping(root)
  const store = new EvaluationStore(root)
  const rows: string[] = []
  for (const groupId of blindGroupIds) {
    for (const label of ['A', 'B'] as const) {
      const model = mapping.groups[groupId][label]
      const attemptIds: string[] =
        groupId === 'continuity'
          ? continuationStepNumbers.map((step) =>
              attemptIdFor(model, continuityTaskId, step),
            )
          : [attemptIdFor(model, groupId, null)]
      const segments: string[] = []
      for (const attemptId of attemptIds) {
        const attempt = await store.readAttempt(attemptId)
        if (attempt.status !== 'succeeded') {
          throw new Error(
            `blind artifacts require succeeded drafts; ${attemptId} is ${attempt.status}`,
          )
        }
        segments.push(await store.readOutput(attemptId))
      }
      rows.push(`${groupId}\u0000${label}\u0000${segments.join('\n\n')}`)
    }
  }
  return sha256Hex(rows.join('\u0001'))
}

function groupTitle(groupId: BlindGroupId): string {
  const titles: Record<BlindGroupId, string> = {
    reunion: '重逢',
    'costly-choice': '选择',
    'limited-reveal': '有限视角揭示',
    continuity: '连续续写',
  }
  return titles[groupId]
}

function exportGroupMarkdown(
  groupId: BlindGroupId,
  drafts: Record<BlindLabel, CandidateManuscript>,
): string {
  const lines: string[] = []
  lines.push(`# 盲选：${groupTitle(groupId)}`)
  lines.push('')
  lines.push('（以下是两套候选共用的创作任务原文；候选文本不含任何模型信息。）')
  lines.push('')
  lines.push(groupMaterials(groupId))
  lines.push('')
  for (const label of ['A', 'B'] as const) {
    lines.push(`## 候选 ${label}`)
    lines.push('')
    const segments = drafts[label].segments
    if (segments.length === 1) {
      lines.push(segments[0] ?? '')
    } else {
      segments.forEach((segment, index) => {
        lines.push(`### 第 ${index + 1} 段`)
        lines.push('')
        lines.push(segment)
        lines.push('')
      })
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/**
 * Export summary carries NO model mapping — only artifact paths and the
 * mapping hash, so printing it can never reveal the blind assignment.
 */
export interface BlindExportSummary {
  exports: string[]
  ballotTemplatePath: string
  mappingHash: string
}

/**
 * Ballot template bound to config/fixture/mapping/artifact hashes. Choices
 * start as `null` (no default A): the human must explicitly pick A/B/并列/
 * 全部不合格 for every group before the vote can be recorded.
 */
export function ballotTemplateText(
  mapping: BlindMapping,
  artifactsHash: string,
): string {
  const choices = {} as Record<
    BlindGroupId,
    { choice: null; reason: string }
  >
  for (const groupId of blindGroupIds) {
    choices[groupId] = { choice: null, reason: '' }
  }
  const template = {
    schemaVersion: 1,
    configHash: mapping.configHash,
    fixtureHash: mapping.fixtureHash,
    mappingHash: mappingHash(mapping),
    artifactsHash,
    choices,
  }
  return `${JSON.stringify(template, null, 2)}\n`
}

/**
 * Export the blind Markdown (one file per group) plus the ballot template
 * under the run's exclusive writer lock. Fails closed unless the run is the
 * exact twelve succeeded drafts, and never writes the model mapping into the
 * exported filenames, bodies or the summary.
 */
export async function exportBlind(root: string): Promise<BlindExportSummary> {
  const store = new EvaluationStore(root)
  await store.assertUsable()
  const token = await store.acquireLock()
  try {
    await assertCompleteRun(root)
    const mapping = await createBlindMapping(root)
    const artifactsHash = await computeManuscriptsHash(root)
    const paths = storePaths(root)
    const exports: string[] = []
    for (const groupId of blindGroupIds) {
      const drafts = {} as Record<BlindLabel, CandidateManuscript>
      for (const label of ['A', 'B'] as const) {
        drafts[label] = await loadCandidateManuscript(root, groupId, label)
      }
      const path = join(paths.blindExportDir, `${groupId}.md`)
      await atomicWriteFile(path, exportGroupMarkdown(groupId, drafts))
      exports.push(path)
    }
    const ballotTemplatePath = join(paths.root, 'ballot.template.json')
    await atomicWriteFile(
      ballotTemplatePath,
      ballotTemplateText(mapping, artifactsHash),
    )
    return {
      exports,
      ballotTemplatePath,
      mappingHash: mappingHash(mapping),
    }
  } finally {
    await store.releaseLock(token)
  }
}
