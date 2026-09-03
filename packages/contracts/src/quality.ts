export const qualityDimensions = [
  'eternal_emotion',
  'fresh_situation',
  'difficult_choice',
  'character_truth',
  'narrative_control',
] as const

export type QualityDimension = (typeof qualityDimensions)[number]

export interface DimensionRule {
  weight: number
  minimum: number
}

export interface QualityGateConfig {
  scale: 100
  dimensions: Record<QualityDimension, DimensionRule>
  passing: {
    minimumTotal: number
    requireEveryDimension: boolean
    maxRevisionRounds: number
  }
}

export interface DimensionEvaluation {
  score: number
  evidence: string[]
  diagnosis: string
  revisionInstruction: string
}

export interface CandidateEvaluation {
  dimensions: Record<QualityDimension, DimensionEvaluation>
  vetoes: string[]
}

export interface QualityDecision {
  total: number
  passed: boolean
  failedDimensions: QualityDimension[]
  vetoes: string[]
}
