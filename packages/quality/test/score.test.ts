import { describe, expect, it } from 'vitest'
import type { CandidateEvaluation } from '@writex/contracts'
import {
  defaultQualityGate,
  scoreQuality,
  validateQualityGateConfig,
} from '../src/index.js'

function evaluation(score: number): CandidateEvaluation {
  const result = Object.fromEntries(
    Object.keys(defaultQualityGate.dimensions).map((dimension) => [
      dimension,
      {
        score,
        evidence: ['具体证据'],
        diagnosis: '诊断',
        revisionInstruction: '修改指令',
      },
    ]),
  ) as CandidateEvaluation['dimensions']

  return { dimensions: result, vetoes: [] }
}

describe('scoreQuality', () => {
  it('returns the common score when every dimension is equal', () => {
    expect(scoreQuality(evaluation(80), defaultQualityGate)).toEqual({
      total: 80,
      passed: true,
      failedDimensions: [],
      vetoes: [],
    })
  })

  it('fails when one dimension is below its hard minimum', () => {
    const input = evaluation(80)
    input.dimensions.character_truth.score = 60
    const decision = scoreQuality(input, defaultQualityGate)
    expect(decision.passed).toBe(false)
    expect(decision.failedDimensions).toContain('character_truth')
  })

  it('returns zero when one dimension is zero', () => {
    const input = evaluation(80)
    input.dimensions.eternal_emotion.score = 0
    expect(scoreQuality(input, defaultQualityGate).total).toBe(0)
  })

  it('cannot pass a veto', () => {
    const input = evaluation(90)
    input.vetoes.push('人物知道了不应知道的信息')
    expect(scoreQuality(input, defaultQualityGate).passed).toBe(false)
  })

  it('rejects weights that do not sum to one', () => {
    const invalid = structuredClone(defaultQualityGate)
    invalid.dimensions.eternal_emotion.weight = 0.5
    expect(() => validateQualityGateConfig(invalid)).toThrow(/sum to 1/)
  })

  it('rejects a non-finite minimumTotal', () => {
    const invalid = structuredClone(defaultQualityGate)
    invalid.passing.minimumTotal = Number.NaN
    expect(() => validateQualityGateConfig(invalid)).toThrow(/minimumTotal/)
  })

  it('rejects a score without evidence', () => {
    const input = evaluation(80)
    input.dimensions.narrative_control.evidence = []
    expect(() => scoreQuality(input, defaultQualityGate)).toThrow(/evidence/)
  })
})
