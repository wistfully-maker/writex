import {
  qualityDimensions,
  type QualityGateConfig,
} from '@writex/contracts'

export const defaultQualityGate: QualityGateConfig = {
  scale: 100,
  dimensions: {
    eternal_emotion: { weight: 0.25, minimum: 65 },
    fresh_situation: { weight: 0.15, minimum: 60 },
    difficult_choice: { weight: 0.2, minimum: 65 },
    character_truth: { weight: 0.25, minimum: 70 },
    narrative_control: { weight: 0.15, minimum: 65 },
  },
  passing: {
    minimumTotal: 72,
    requireEveryDimension: true,
    maxRevisionRounds: 3,
  },
}

export function validateQualityGateConfig(config: QualityGateConfig): void {
  const weights = qualityDimensions.map((name) => config.dimensions[name].weight)
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)

  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new Error('quality weights must be finite and non-negative')
  }
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new Error('quality weights must sum to 1')
  }

  for (const name of qualityDimensions) {
    const minimum = config.dimensions[name].minimum
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
      throw new Error(`${name} minimum must be between 0 and 100`)
    }
  }

  if (
    !Number.isFinite(config.passing.minimumTotal) ||
    config.passing.minimumTotal < 0 ||
    config.passing.minimumTotal > 100
  ) {
    throw new Error('minimumTotal must be between 0 and 100')
  }
  if (!Number.isInteger(config.passing.maxRevisionRounds) || config.passing.maxRevisionRounds < 0) {
    throw new Error('maxRevisionRounds must be a non-negative integer')
  }
}
