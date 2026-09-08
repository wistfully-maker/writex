import {
  qualityDimensions,
  type CandidateEvaluation,
  type QualityDecision,
  type QualityGateConfig,
} from '@writex/contracts'
import { validateQualityGateConfig } from './config.js'

export function scoreQuality(
  evaluation: CandidateEvaluation,
  config: QualityGateConfig,
): QualityDecision {
  validateQualityGateConfig(config)

  let containsZero = false
  let weightedLog = 0
  const failedDimensions: QualityDecision['failedDimensions'] = []

  for (const name of qualityDimensions) {
    const result = evaluation.dimensions[name]
    if (!result) throw new Error(`missing evaluation for ${name}`)
    if (!Number.isFinite(result.score) || result.score < 0 || result.score > 100) {
      throw new Error(`${name} score must be between 0 and 100`)
    }
    if (result.evidence.length === 0 || result.evidence.some((item) => item.trim() === '')) {
      throw new Error(`${name} evaluation requires evidence`)
    }

    if (result.score === 0) {
      containsZero = true
    } else {
      weightedLog += config.dimensions[name].weight * Math.log(result.score / 100)
    }

    if (config.passing.requireEveryDimension && result.score < config.dimensions[name].minimum) {
      failedDimensions.push(name)
    }
  }

  const total = containsZero ? 0 : Math.round(10000 * Math.exp(weightedLog)) / 100
  const passed =
    failedDimensions.length === 0 &&
    evaluation.vetoes.length === 0 &&
    total >= config.passing.minimumTotal

  return {
    total,
    passed,
    failedDimensions,
    vetoes: [...evaluation.vetoes],
  }
}
