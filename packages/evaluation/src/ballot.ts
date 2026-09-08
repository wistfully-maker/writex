import { readFile } from 'node:fs/promises'
import { atomicWriteFile } from '@writex/workspace'
import {
  blindGroupIds,
  evaluationBallotSchemaVersion,
  type BallotChoice,
  type BallotChoiceEntry,
  type BlindGroupId,
  type BlindMapping,
  type EvaluationBallot,
} from './contracts.js'
import {
  computeManuscriptsHash,
  mappingHash,
  readBlindMapping,
} from './blind.js'
import { EvaluationStore, storePaths } from './store.js'

const ballotChoices: ReadonlySet<string> = new Set([
  'A',
  'B',
  'tie',
  'neither',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidBallot(message: string): never {
  throw new Error(`invalid ballot: ${message}`)
}

function invalidBallotInput(message: string): never {
  throw new Error(`invalid ballot input: ${message}`)
}

/** Run bindings every ballot/template is validated against. */
export interface BallotBindings {
  configHash: string
  fixtureHash: string
  mapping: BlindMapping
  artifactsHash: string
}

function mappingHashOf(bindings: BallotBindings): string {
  return mappingHash(bindings.mapping)
}

/**
 * Validate a human-authored ballot (normally the exported template filled in
 * by hand). Choice values must be explicit — `null`/empty from the template
 * is rejected. Every binding hash the input carries (config/fixture/mapping/
 * artifacts) must equal this run's values, so an export for a different run
 * or modified manuscripts cannot be voted on.
 */
export function parseBallotInput(
  value: unknown,
  bindings: BallotBindings,
): Record<BlindGroupId, BallotChoiceEntry> {
  if (!isRecord(value)) {
    invalidBallotInput('must be a JSON object')
  }
  const allowed = new Set([
    'schemaVersion',
    'choices',
    'configHash',
    'fixtureHash',
    'mappingHash',
    'artifactsHash',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalidBallotInput(`unknown field ${key}`)
    }
  }
  if (value.schemaVersion !== evaluationBallotSchemaVersion) {
    invalidBallotInput(
      `unsupported schemaVersion: expected ${evaluationBallotSchemaVersion}`,
    )
  }
  // EXTERNAL ballots must carry every binding hash from the exported
  // template — a ballot missing any of them is not bound to this run.
  const requiredBindings: Array<[string, string, string]> = [
    ['configHash', bindings.configHash, 'configHash does not match this run root'],
    ['fixtureHash', bindings.fixtureHash, 'fixtureHash does not match this run root'],
    ['mappingHash', mappingHashOf(bindings), 'mappingHash does not match this run blind mapping'],
    ['artifactsHash', bindings.artifactsHash, 'artifactsHash does not match the exported manuscripts (drafts changed after export?)'],
  ]
  for (const [field, expected, mismatchMessage] of requiredBindings) {
    const provided = value[field]
    if (typeof provided !== 'string' || provided === '') {
      invalidBallotInput(
        `${field} is required — record a ballot from the exported template without deleting its hash bindings`,
      )
    }
    if (provided !== expected) {
      invalidBallotInput(mismatchMessage)
    }
  }
  if (!isRecord(value.choices)) {
    invalidBallotInput('choices must be an object')
  }
  const present = Object.keys(value.choices)
  const missing = blindGroupIds.filter((id) => !present.includes(id))
  const extra = present.filter((id) => !blindGroupIds.includes(id as BlindGroupId))
  if (missing.length > 0) {
    invalidBallotInput(`missing group choices: ${missing.join(', ')}`)
  }
  if (extra.length > 0) {
    invalidBallotInput(`unknown group in choices: ${extra.join(', ')}`)
  }
  const choices = {} as Record<BlindGroupId, BallotChoiceEntry>
  for (const groupId of blindGroupIds) {
    const entry = value.choices[groupId]
    if (!isRecord(entry)) {
      invalidBallotInput(`${groupId} must be an object`)
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'choice' && key !== 'reason') {
        invalidBallotInput(`${groupId} has unknown field ${key}`)
      }
    }
    if (
      typeof entry.choice !== 'string' ||
      !ballotChoices.has(entry.choice)
    ) {
      invalidBallotInput(
        `${groupId}.choice must be one of A, B, tie, neither — the exported template requires an explicit human selection (it starts empty)`,
      )
    }
    if (entry.reason !== undefined && typeof entry.reason !== 'string') {
      invalidBallotInput(`${groupId}.reason must be a string when supplied`)
    }
    const parsed: BallotChoiceEntry = { choice: entry.choice as BallotChoice }
    if (typeof entry.reason === 'string' && entry.reason.trim() !== '') {
      parsed.reason = entry.reason.trim()
    }
    choices[groupId] = parsed
  }
  return choices
}

function parseBallotFile(raw: string, bindings: BallotBindings): EvaluationBallot {
  const value: unknown = JSON.parse(raw)
  if (!isRecord(value)) {
    invalidBallot('not an object')
  }
  const allowed = new Set([
    'schemaVersion',
    'configHash',
    'fixtureHash',
    'mappingHash',
    'artifactsHash',
    'createdAt',
    'updatedAt',
    'choices',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalidBallot(`unknown field ${key}`)
    }
  }
  if (value.schemaVersion !== evaluationBallotSchemaVersion) {
    invalidBallot('schema version')
  }
  const storedBindingFields: Array<[string, string, string]> = [
    ['configHash', bindings.configHash, 'config no longer matches this run root'],
    ['fixtureHash', bindings.fixtureHash, 'fixtures no longer match this run root'],
    ['mappingHash', mappingHashOf(bindings), 'mapping no longer matches this run'],
    ['artifactsHash', bindings.artifactsHash, 'manuscript outputs changed since the ballot was recorded; re-export and re-vote'],
  ]
  for (const [field, expected, mismatchMessage] of storedBindingFields) {
    if (typeof value[field] !== 'string' || value[field] === '') {
      invalidBallot(`${field} must be a non-blank string`)
    }
    if (value[field] !== expected) {
      invalidBallot(mismatchMessage)
    }
  }
  if (typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    invalidBallot('createdAt/updatedAt must be strings')
  }
  // The stored ballot already carries the (verified) binding hashes; pass
  // them through so the shared validator keeps enforcing presence/equality.
  const choices = parseBallotInput(
    {
      schemaVersion: evaluationBallotSchemaVersion,
      configHash: value.configHash,
      fixtureHash: value.fixtureHash,
      mappingHash: value.mappingHash,
      artifactsHash: value.artifactsHash,
      choices: value.choices,
    },
    bindings,
  )
  return {
    schemaVersion: evaluationBallotSchemaVersion,
    configHash: value.configHash as string,
    fixtureHash: value.fixtureHash as string,
    mappingHash: value.mappingHash as string,
    artifactsHash: value.artifactsHash as string,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    choices,
  }
}

/**
 * Record a complete human ballot for this run, under the run's exclusive
 * writer lock. The ballot binds config/fixture/mapping hashes AND the hash of
 * the twelve manuscript texts the human compared. It is the gate that must be
 * recorded BEFORE any diagnosis or reveal report.
 */
export async function recordBallot(
  root: string,
  input: unknown,
  options: { now?: () => string } = {},
): Promise<EvaluationBallot> {
  const store = new EvaluationStore(root)
  await store.assertUsable()
  const now = options.now ?? (() => new Date().toISOString())
  const token = await store.acquireLock()
  try {
    const mapping = await readBlindMapping(root)
    const state = await store.readState()
    const artifactsHash = await computeManuscriptsHash(root)
    const bindings: BallotBindings = {
      configHash: state.configHash,
      fixtureHash: state.fixtureHash,
      mapping,
      artifactsHash,
    }
    const choices = parseBallotInput(input, bindings)
    const stamp = now()
    const ballot: EvaluationBallot = {
      schemaVersion: evaluationBallotSchemaVersion,
      configHash: state.configHash,
      fixtureHash: state.fixtureHash,
      mappingHash: mappingHashOf(bindings),
      artifactsHash,
      createdAt: stamp,
      updatedAt: stamp,
      choices,
    }
    await atomicWriteFile(
      storePaths(root).ballotPath,
      `${JSON.stringify(ballot, null, 2)}\n`,
    )
    return ballot
  } finally {
    await store.releaseLock(token)
  }
}

/** Read the recorded ballot; throws when absent, tampered or incomplete. */
export async function readBallot(root: string): Promise<EvaluationBallot> {
  const store = new EvaluationStore(root)
  const state = await store.readState()
  const mapping = await readBlindMapping(root)
  const artifactsHash = await computeManuscriptsHash(root)
  const bindings: BallotBindings = {
    configHash: state.configHash,
    fixtureHash: state.fixtureHash,
    mapping,
    artifactsHash,
  }
  let raw: string
  try {
    raw = await readFile(storePaths(root).ballotPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('no ballot recorded yet; run the export/vote flow first')
    }
    throw error
  }
  return parseBallotFile(raw, bindings)
}
