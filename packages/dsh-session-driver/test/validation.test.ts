import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateWorkstreamConfig } from '../src/index.js'

const valid = {
  schemaVersion: 1 as const,
  workstreamId: 'model-evaluation-v1',
  sessionId: 'session-model-evaluation-v1',
  branch: 'feature/model-evaluation-v1',
  workspace: 'D:/program/writex/.worktrees/model-evaluation-v1',
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 8192,
}

describe('validateWorkstreamConfig', () => {
  it('accepts the complete configuration', () => {
    expect(validateWorkstreamConfig(valid)).toEqual({ ...valid, workspace: resolve(valid.workspace) })
  })

  it.each(['../escape', 'CON', 'run.', ''])('rejects unsafe workstream ids: %s', (workstreamId) => {
    expect(() => validateWorkstreamConfig({ ...valid, workstreamId })).toThrow(/workstreamId/)
  })

  it('requires an absolute workspace path', () => {
    expect(() => validateWorkstreamConfig({ ...valid, workspace: './relative' })).toThrow(/workspace/)
  })

  it('rejects secret-bearing extra fields', () => {
    expect(() => validateWorkstreamConfig({ ...valid, apiKey: 'secret' } as never)).toThrow(/unknown field/)
  })

  it('returns trimmed branch, profile, provider, model, and reasoningEffort', () => {
    const result = validateWorkstreamConfig({
      ...valid,
      branch: '  feature/trimmed-branch  ',
      profile: ' sdk ',
      provider: ' deepseek-official ',
      model: ' deepseek-v4-flash ',
      reasoningEffort: ' high ',
    })
    expect(result).toEqual({
      ...valid,
      branch: 'feature/trimmed-branch',
      profile: 'sdk',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'high',
      workspace: resolve(valid.workspace),
    })
  })

  it('rejects whitespace-only reasoningEffort', () => {
    expect(() => validateWorkstreamConfig({ ...valid, reasoningEffort: '   ' })).toThrow(
      /reasoningEffort/,
    )
  })
})
