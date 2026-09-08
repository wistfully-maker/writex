import type {
  DeepSeekModelId,
  DeepSeekReasoningEffort,
} from '@writex/model-gateway'
import type { CandidateEvaluation, GenerationUsage } from '@writex/contracts'

export type { DeepSeekModelId, DeepSeekReasoningEffort }

/** The only models this evaluation run supports: DeepSeek Flash and Pro. */
export const evaluationModels: readonly DeepSeekModelId[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
]

export const evaluationConfigVersion = 1 as const
export const evaluationFixtureVersion = 1 as const
export const evaluationAttemptSchemaVersion = 1 as const
export const evaluationPlanSchemaVersion = 1 as const

export const sceneTaskIds = [
  'reunion',
  'costly-choice',
  'limited-reveal',
] as const
export type SceneTaskId = (typeof sceneTaskIds)[number]

export const continuityTaskId = 'three-step-continuity' as const

export type EvaluationTaskId = SceneTaskId | typeof continuityTaskId
export type EvaluationTaskKind = 'scene' | 'continuation'

export const continuationStepNumbers = [1, 2, 3] as const
export type ContinuationStep = (typeof continuationStepNumbers)[number]

/** Price entry in USD per one million tokens. */
export interface PriceEntry {
  inputCacheHitUsdPerMTokens: number
  inputCacheMissUsdPerMTokens: number
  outputUsdPerMTokens: number
}

export interface EvaluationPriceTable {
  currency: 'USD'
  /** URL or citation for the price source. */
  source: string
  /** Date (YYYY-MM-DD) the prices became effective at the source. */
  effectiveDate: string
  perMTokens: Record<DeepSeekModelId, PriceEntry>
}

/** `thinking` carries only its mode; DeepSeek has no effort/budget wire fields. */
export interface EvaluationThinking {
  type: 'disabled' | 'enabled'
}

export interface EvaluationConfig {
  schemaVersion: 1
  /** Environment variable that holds the DeepSeek API key (never the key). */
  apiKeyEnv: string
  baseUrl: string
  timeoutMs: number
  maxOutputTokens: number
  thinking: EvaluationThinking
  /** Top-level DeepSeek reasoning effort; only meaningful with enabled thinking. */
  reasoningEffort?: DeepSeekReasoningEffort
  budgetUsd: number
  priceTable: EvaluationPriceTable
}

export type AttemptStatus =
  | 'pending'
  | 'in-flight'
  | 'succeeded'
  | 'failed'
  | 'uncertain'
  | 'blocked'

export type FailureKind =
  | 'auth'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid-response'
  | 'empty-content'
  | 'truncated'
  | 'config'
  | 'error'

export type BlockReason = 'dependent-failure'

export interface AttemptFailure {
  kind: FailureKind
  message: string
}

/**
 * One persisted generation attempt. Sensitive values never appear here: no
 * prompt text, no API key, no raw response, no reasoning content. Prompt text
 * is derivable again from the fixtures plus previously persisted outputs, so
 * only the prompt hash is stored. Output text is persisted separately under
 * outputs/<attemptId>.txt.
 */
export interface PersistedAttempt {
  schemaVersion: 1
  attemptId: string
  model: DeepSeekModelId
  taskId: EvaluationTaskId
  kind: EvaluationTaskKind
  step: ContinuationStep | null
  status: AttemptStatus
  createdAt: string
  updatedAt: string
  configHash: string
  fixtureHash: string
  /** SHA-256 of the exact system+user request text; null before the request is built. */
  promptHash: string | null
  /** USD reserved before the network call (estimate, never a billing cap). */
  reservedUsd: number
  blockReason: BlockReason | null
  failure: AttemptFailure | null
  responseId: string | null
  responseModel: string | null
  finishReason: string | null
  usage: GenerationUsage | null
  /** Actual USD cost derived from usage; null when usage/cost is unknown. */
  costUsd: number | null
  costUnknown: boolean
  startedAt: string | null
  finishedAt: string | null
  /**
   * Per-call history (see `AttemptCallRecord`). Absent on records written
   * before this field existed; the store normalizes missing to `[]`.
   */
  attemptCalls?: AttemptCallRecord[]
}

export interface PlannedAttempt {
  attemptId: string
  model: DeepSeekModelId
  taskId: EvaluationTaskId
  kind: EvaluationTaskKind
  step: ContinuationStep | null
  order: number
  purpose: string
  /** Conservative upper-bound reserve used only for dry-run planning. */
  reservedUsd: number
}

export interface EvaluationPlan {
  schemaVersion: 1
  configHash: string
  fixtureHash: string
  modelCount: number
  callCount: number
  attempts: PlannedAttempt[]
  budgetUsd: number
  /** Sum of conservative per-attempt reserves (estimate, not a hard cap). */
  reserveTotalUsd: number
  /** Human-readable pricing/estimate assumption labels. */
  assumptions: string[]
}

export interface AttemptSummary {
  attemptId: string
  model: DeepSeekModelId
  taskId: EvaluationTaskId
  step: ContinuationStep | null
  status: AttemptStatus
  blockReason: BlockReason | null
  failure: AttemptFailure | null
  costUsd: number | null
  costUnknown: boolean
  reservedUsd: number
}

export type RunStoppedReason = 'completed' | 'budget' | 'auth' | 'incomplete'

export interface EvaluationRunReport {
  schemaVersion: 1
  dryRun: boolean
  root: string
  configHash: string
  fixtureHash: string
  attempts: AttemptSummary[]
  gatewayCalls: number
  budgetUsd: number
  /** Sum of reserves retained for attempts that reached the network gate. */
  reservedUsd: number
  /** Sum of known actual costs plus retained reserves for uncertain ones. */
  spentEstimateUsd: number
  stoppedReason: RunStoppedReason | null
  assumptions: string[]
}

// ---------------------------------------------------------------------------
// Blind comparison, ballot, diagnosis and report (slice 3)
// ---------------------------------------------------------------------------

/** Four blind A/B groups: the three independent scene pairs plus the paired
 * three-part continuations. Candidate labels never reveal the model. */
export const blindGroupIds = [
  'reunion',
  'costly-choice',
  'limited-reveal',
  'continuity',
] as const
export type BlindGroupId = (typeof blindGroupIds)[number]

export type BlindLabel = 'A' | 'B'
export type BallotChoice = 'A' | 'B' | 'tie' | 'neither'

export const evaluationBlindSchemaVersion = 1 as const
export const evaluationBallotSchemaVersion = 1 as const
export const evaluationDiagnosisSchemaVersion = 1 as const

/** One group's label->model assignment (model names are private data). */
export interface BlindGroupAssignment {
  A: DeepSeekModelId
  B: DeepSeekModelId
}

export interface BlindMapping {
  schemaVersion: 1
  configHash: string
  fixtureHash: string
  createdAt: string
  groups: Record<BlindGroupId, BlindGroupAssignment>
}

export interface BallotChoiceEntry {
  choice: BallotChoice
  /** Optional short human reason; never parsed into an automatic decision. */
  reason?: string
}

export interface EvaluationBallot {
  schemaVersion: 1
  configHash: string
  fixtureHash: string
  mappingHash: string
  /**
   * SHA-256 over the exact twelve manuscript texts (groups x A/B) the human
   * compared. Any later change to a persisted draft invalidates the ballot,
   * so diagnosis/reveal refuse to run against modified manuscripts.
   */
  artifactsHash: string
  createdAt: string
  updatedAt: string
  choices: Record<BlindGroupId, BallotChoiceEntry>
}

/**
 * One completed network attempt (or a crash-recovered one), appended to
 * `PersistedAttempt.attemptCalls` in order. Unlike the flattened attempt
 * fields (which always reflect the LATEST call), these records preserve every
 * call's own outcome, timing, usage and reserve so retry history and costs
 * (including amounts that stay unknown) survive later retries.
 */
export interface AttemptCallRecord {
  /** 1-based position of this call within the attempt's history. */
  seq: number
  status: 'failed' | 'uncertain' | 'succeeded'
  startedAt: string
  finishedAt: string | null
  /** Reserve added by THIS call (not the accumulated total). */
  reservedUsd: number
  failure: AttemptFailure | null
  usage: GenerationUsage | null
  costUsd: number | null
  costUnknown: boolean
  responseId: string | null
  responseModel: string | null
  finishReason: string | null
}

/** A factual conflict found inside a continuation candidate's own segments. */
export interface ContinuityIssue {
  conflict: string
  suggestion: string
  /** Exact quote from a segment; must appear in the source when supplied. */
  quote: string | null
}

export type DiagnosisStatus =
  | 'pending'
  | 'in-flight'
  | 'succeeded'
  | 'failed'
  | 'uncertain'

/** One persisted diagnostic request. Never stores prompt or reasoning text. */
export interface PersistedDiagnosis {
  schemaVersion: 1
  diagnosisId: string
  groupId: BlindGroupId
  label: BlindLabel
  model: DeepSeekModelId
  status: DiagnosisStatus
  createdAt: string
  updatedAt: string
  configHash: string
  fixtureHash: string
  promptHash: string | null
  reservedUsd: number
  failure: AttemptFailure | null
  responseId: string | null
  responseModel: string | null
  finishReason: string | null
  usage: GenerationUsage | null
  costUsd: number | null
  costUnknown: boolean
  startedAt: string | null
  finishedAt: string | null
  /** SHA-256 of the exact manuscript text the model was asked to judge. */
  sourceHash: string | null
  /** SHA-256 of the validated result file once persisted. */
  resultHash: string | null
  /**
   * Per-call history mirroring `PersistedAttempt.attemptCalls`, so diagnosis
   * retries preserve each call's outcome/usage/cost and uncertain charges
   * stay visible as unknown in the report.
   */
  attemptCalls?: AttemptCallRecord[]
}

/** The validated outcome of one diagnostic request. */
export interface DiagnosisResult {
  schemaVersion: 1
  diagnosisId: string
  groupId: BlindGroupId
  label: BlindLabel
  model: DeepSeekModelId
  createdAt: string
  sourceHash: string
  evaluation: CandidateEvaluation
  /** Only continuation candidates carry issues; scene candidates keep []. */
  continuityIssues: ContinuityIssue[]
}
