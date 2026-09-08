export interface GenerationRequest {
  requestId: string
  purpose: string
  system: string
  prompt: string
  temperature?: number
  maxOutputTokens?: number
  metadata: Record<string, string>
}

/**
 * Token usage reported by a model provider. Every field is optional: a
 * provider may omit usage entirely (cost stays unknown) or report only part
 * of it. When a field is supplied it must be finite and non-negative.
 * Cache-aware models additionally report prompt tokens served from cache
 * (`cacheHitInputTokens`) and prompt tokens that missed (`cacheMissInputTokens`);
 * reasoning models may report reasoning tokens inside `reasoningTokens`.
 */
export interface GenerationUsage {
  inputTokens?: number
  outputTokens?: number
  cacheHitInputTokens?: number
  cacheMissInputTokens?: number
  reasoningTokens?: number
}

export interface GenerationResult {
  requestId: string
  provider: string
  model: string
  text: string
  /** Unknown (absent) when the provider did not report usage. */
  usage?: GenerationUsage
  /**
   * Provider completion state, e.g. `stop`, `length` or `content_filter`.
   * Absent when the provider did not report one. A `length` result is never
   * returned as success by adapters.
   */
  finishReason?: string
  /** Provider-issued response identifier when reported. */
  responseId?: string
  rawResponse?: unknown
}

export interface ModelGateway {
  generate(request: GenerationRequest): Promise<GenerationResult>
}
