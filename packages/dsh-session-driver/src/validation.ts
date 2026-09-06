import { isAbsolute, resolve } from 'node:path'
import type { CompactionCapsule, WorkstreamConfig } from './contracts.js'

const allowedFields = new Set([
  'schemaVersion', 'workstreamId', 'sessionId', 'branch', 'workspace', 'profile',
  'provider', 'model', 'reasoningEffort', 'maxTokens',
])
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

function assertId(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !safeId.test(value) || /[. ]$/.test(value) || reserved.test(value)) {
    throw new Error(`invalid ${name}`)
  }
}

export function validateWorkstreamConfig(input: unknown): WorkstreamConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid workstream config')
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) if (!allowedFields.has(key)) throw new Error(`unknown field: ${key}`)
  if (record.schemaVersion !== 1) throw new Error('invalid schemaVersion')
  assertId('workstreamId', record.workstreamId)
  assertId('sessionId', record.sessionId)
  const normalized: Record<string, unknown> = { ...record }
  const branch = normalized.branch
  if (typeof branch !== 'string' || branch.trim() === '') throw new Error('branch is required')
  normalized.branch = branch.trim()
  const workspace = normalized.workspace
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) throw new Error('workspace must be absolute')
  for (const key of ['profile', 'provider', 'model'] as const) {
    const value = normalized[key]
    if (typeof value !== 'string' || value.trim() === '') throw new Error(`${key} is required`)
    normalized[key] = value.trim()
  }
  if (normalized.reasoningEffort !== undefined) {
    const effort = normalized.reasoningEffort
    if (typeof effort !== 'string' || effort.trim() === '') throw new Error('invalid reasoningEffort')
    normalized.reasoningEffort = effort.trim()
  }
  if (normalized.maxTokens !== undefined && (!Number.isSafeInteger(normalized.maxTokens) || Number(normalized.maxTokens) <= 0)) {
    throw new Error('invalid maxTokens')
  }
  return { ...normalized, workspace: resolve(workspace) } as unknown as WorkstreamConfig
}

export function validateCompactionCapsule(input: unknown): CompactionCapsule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid capsule')
  const record = input as Record<string, unknown>
  const keys = ['schemaVersion', 'objective', 'completed', 'decisions', 'currentState', 'verification', 'openIssues', 'nextAction']
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error('unknown capsule field')
  if (record.schemaVersion !== 1) throw new Error('invalid capsule schemaVersion')
  for (const key of ['objective', 'nextAction'] as const) {
    if (typeof record[key] !== 'string' || record[key].trim() === '') throw new Error(`invalid capsule ${key}`)
  }
  for (const key of ['completed', 'decisions', 'verification', 'openIssues'] as const) {
    if (!Array.isArray(record[key]) || record[key].some((value) => typeof value !== 'string')) {
      throw new Error(`invalid capsule ${key}`)
    }
  }
  if (!record.currentState || typeof record.currentState !== 'object' || Array.isArray(record.currentState)) {
    throw new Error('invalid capsule currentState')
  }
  const state = record.currentState as Record<string, unknown>
  const stateKeys = ['branch', 'worktree', 'lastCommit', 'dirtyFiles']
  if (Object.keys(state).some((key) => !stateKeys.includes(key))) throw new Error('unknown capsule state field')
  if (typeof state.branch !== 'string' || typeof state.worktree !== 'string' || !isAbsolute(state.worktree) || typeof state.lastCommit !== 'string') {
    throw new Error('invalid capsule currentState')
  }
  if (!Array.isArray(state.dirtyFiles) || state.dirtyFiles.some((value) => typeof value !== 'string')) {
    throw new Error('invalid capsule dirtyFiles')
  }
  return structuredClone(input) as CompactionCapsule
}
