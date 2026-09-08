import type {
  GenerationRequest,
  GenerationResult,
  GenerationUsage,
} from '@writex/contracts'

export const deepSeekModelIds = ['deepseek-v4-flash', 'deepseek-v4-pro'] as const
export type DeepSeekModelId = (typeof deepSeekModelIds)[number]

export const deepSeekThinkingModes = ['disabled', 'enabled'] as const
export type DeepSeekThinkingMode = (typeof deepSeekThinkingModes)[number]

/**
 * DeepSeek reasoning effort is a TOP-LEVEL request field, never nested under
 * `thinking`; the valid values are low/high/max (there is no "medium").
 */
export const deepSeekReasoningEfforts = ['low', 'high', 'max'] as const
export type DeepSeekReasoningEffort = (typeof deepSeekReasoningEfforts)[number]

/** `thinking` carries only its mode; budget and effort are not wire fields. */
export interface DeepSeekThinking {
  type: DeepSeekThinkingMode
}

export const defaultDeepSeekBaseUrl = 'https://api.deepseek.com'
export const defaultDeepSeekApiKeyEnv = 'DEEPSEEK_API_KEY'
export const defaultDeepSeekTimeoutMs = 60_000
export const defaultDeepSeekMaxOutputTokens = 4096

export type DeepSeekEnvLookup = (name: string) => string | undefined

export function defaultDeepSeekEnvLookup(name: string): string | undefined {
  return process.env[name]
}

export type DeepSeekFetch = typeof fetch

export type DeepSeekErrorCode =
  | 'config'
  | 'auth'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'invalid-response'
  | 'empty-content'
  | 'truncated'

/**
 * Sanitized metadata a caller may persist for paid requests that failed after
 * the provider answered (e.g. truncated output). Never contains reasoning or
 * response bodies.
 */
export interface DeepSeekFailureDetails {
  usage?: GenerationUsage
  responseId?: string
  model?: string
  finishReason?: string
}

export class DeepSeekError extends Error {
  readonly code: DeepSeekErrorCode
  readonly status?: number
  readonly details?: DeepSeekFailureDetails

  constructor(
    code: DeepSeekErrorCode,
    message: string,
    status?: number,
    details?: DeepSeekFailureDetails,
  ) {
    super(message)
    this.name = 'DeepSeekError'
    this.code = code
    if (status !== undefined) {
      this.status = status
    }
    if (details !== undefined) {
      this.details = details
    }
  }
}

export interface DeepSeekGatewayOptions {
  model: DeepSeekModelId
  /** Environment variable holding the API key. */
  apiKeyEnv?: string
  /** HTTPS endpoint base, default https://api.deepseek.com. */
  baseUrl?: string
  timeoutMs?: number
  maxOutputTokens?: number
  thinking?: DeepSeekThinking
  /** Top-level request field; valid only while thinking is enabled. */
  reasoningEffort?: DeepSeekReasoningEffort
  /** Injectable fetch; defaults to the global fetch. */
  fetch?: DeepSeekFetch
  /** Injectable environment lookup; defaults to process.env. */
  lookupEnv?: DeepSeekEnvLookup
}

const allowedDeepSeekHosts = new Set(['api.deepseek.com'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isValidTokenCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  )
}

/**
 * Gateway for DeepSeek chat completions over HTTPS api.deepseek.com.
 * Security rules: the API key only ever reaches the Authorization header;
 * non-2xx bodies are never read; reasoning_content and raw responses are
 * never surfaced; errors never echo raw config values.
 */
export class DeepSeekModelGateway {
  private readonly model: DeepSeekModelId
  private readonly apiKeyEnv: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxOutputTokens: number
  private readonly thinking: DeepSeekThinking
  private readonly reasoningEffort: DeepSeekReasoningEffort | undefined
  private readonly fetchImpl: DeepSeekFetch | undefined
  private readonly lookupEnv: DeepSeekEnvLookup

  constructor(options: DeepSeekGatewayOptions) {
    if (!deepSeekModelIds.includes(options.model)) {
      throw new DeepSeekError('config', 'unsupported DeepSeek model')
    }
    this.model = options.model
    this.apiKeyEnv = options.apiKeyEnv ?? defaultDeepSeekApiKeyEnv
    const baseUrl = options.baseUrl ?? defaultDeepSeekBaseUrl
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new DeepSeekError('config', 'invalid DeepSeek base URL')
    }
    if (parsed.protocol !== 'https:') {
      throw new DeepSeekError('config', 'DeepSeek base URL must use https')
    }
    if (!allowedDeepSeekHosts.has(parsed.hostname)) {
      throw new DeepSeekError('config', 'DeepSeek base URL host is not allowed')
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new DeepSeekError(
        'config',
        'DeepSeek base URL must not contain userinfo',
      )
    }
    if (parsed.port !== '' && parsed.port !== '443') {
      throw new DeepSeekError(
        'config',
        'DeepSeek base URL must not use a custom port',
      )
    }
    if (parsed.search !== '' || parsed.hash !== '') {
      throw new DeepSeekError(
        'config',
        'DeepSeek base URL must not contain a query or fragment',
      )
    }
    // `origin` is scheme://host[:port] only; validated above so it is safe.
    this.baseUrl = parsed.origin
    this.timeoutMs = options.timeoutMs ?? defaultDeepSeekTimeoutMs
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new DeepSeekError('config', 'DeepSeek timeoutMs must be positive')
    }
    this.maxOutputTokens =
      options.maxOutputTokens ?? defaultDeepSeekMaxOutputTokens
    if (
      !Number.isInteger(this.maxOutputTokens) ||
      this.maxOutputTokens <= 0
    ) {
      throw new DeepSeekError(
        'config',
        'DeepSeek maxOutputTokens must be a positive integer',
      )
    }
    this.thinking = options.thinking ?? { type: 'disabled' }
    if (
      this.thinking.type !== 'enabled' &&
      this.thinking.type !== 'disabled'
    ) {
      throw new DeepSeekError(
        'config',
        'DeepSeek thinking.type must be enabled or disabled',
      )
    }
    this.reasoningEffort = options.reasoningEffort
    if (
      this.reasoningEffort !== undefined &&
      !deepSeekReasoningEfforts.includes(this.reasoningEffort)
    ) {
      throw new DeepSeekError(
        'config',
        'DeepSeek reasoningEffort must be low, high or max',
      )
    }
    if (this.reasoningEffort !== undefined && this.thinking.type !== 'enabled') {
      throw new DeepSeekError(
        'config',
        'DeepSeek reasoningEffort requires thinking.type enabled',
      )
    }
    this.fetchImpl = options.fetch
    this.lookupEnv = options.lookupEnv ?? defaultDeepSeekEnvLookup
  }

  private endpointsPath(): string {
    return `${this.baseUrl}/chat/completions`
  }

  private validateRequest(request: GenerationRequest): void {
    if (
      request.maxOutputTokens !== undefined &&
      (!Number.isInteger(request.maxOutputTokens) ||
        request.maxOutputTokens <= 0)
    ) {
      throw new DeepSeekError(
        'config',
        'request maxOutputTokens must be a positive integer',
      )
    }
    if (
      request.temperature !== undefined &&
      (!Number.isFinite(request.temperature) ||
        request.temperature < 0 ||
        request.temperature > 2)
    ) {
      throw new DeepSeekError(
        'config',
        'request temperature must be finite and between 0 and 2',
      )
    }
  }

  private parseUsage(body: Record<string, unknown>): GenerationUsage | undefined {
    if (body.usage === undefined) {
      return undefined
    }
    if (!isRecord(body.usage)) {
      throw new DeepSeekError(
        'invalid-response',
        'model response usage must be an object when supplied',
      )
    }
    const usage = body.usage
    const mapped: GenerationUsage = {}
    const fields: Array<[keyof GenerationUsage, unknown]> = [
      ['inputTokens', usage.prompt_tokens],
      ['outputTokens', usage.completion_tokens],
      ['cacheHitInputTokens', usage.prompt_cache_hit_tokens],
      ['cacheMissInputTokens', usage.prompt_cache_miss_tokens],
    ]
    for (const [field, value] of fields) {
      if (value === undefined) {
        continue
      }
      if (!isValidTokenCount(value)) {
        throw new DeepSeekError(
          'invalid-response',
          'model response usage tokens must be finite non-negative integers',
        )
      }
      mapped[field] = value
    }
    if (usage.completion_tokens_details !== undefined) {
      if (!isRecord(usage.completion_tokens_details)) {
        throw new DeepSeekError(
          'invalid-response',
          'model response completion_tokens_details must be an object when supplied',
        )
      }
      const reasoning = usage.completion_tokens_details.reasoning_tokens
      if (reasoning !== undefined) {
        if (!isValidTokenCount(reasoning)) {
          throw new DeepSeekError(
            'invalid-response',
            'model response reasoning tokens must be finite non-negative integers',
          )
        }
        mapped.reasoningTokens = reasoning
      }
    }
    return Object.keys(mapped).length === 0 ? undefined : mapped
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    const apiKey = this.lookupEnv(this.apiKeyEnv)
    if (apiKey === undefined || apiKey === '') {
      throw new DeepSeekError(
        'auth',
        `DeepSeek API key is missing: environment variable ${this.apiKeyEnv} is not set`,
      )
    }
    this.validateRequest(request)

    const fetchImpl =
      this.fetchImpl ??
      (typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined)
    if (fetchImpl === undefined) {
      throw new DeepSeekError(
        'config',
        'no fetch implementation available for DeepSeek gateway',
      )
    }

    const payload: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      stream: false,
      max_tokens: request.maxOutputTokens ?? this.maxOutputTokens,
      thinking: { type: this.thinking.type },
    }
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature
    }
    if (this.reasoningEffort !== undefined) {
      payload.reasoning_effort = this.reasoningEffort
    }

    // The timer covers headers AND body reads: fetch resolves once headers
    // arrive while response.json() may still be streaming the body.
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    try {
      const response = await fetchImpl(this.endpointsPath(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      })

      const status = response.status
      if (status === 401 || status === 403) {
        throw new DeepSeekError(
          'auth',
          `DeepSeek authentication failed (HTTP ${status})`,
          status,
        )
      }
      if (status === 429) {
        throw new DeepSeekError(
          'rate-limit',
          'DeepSeek rate limit exceeded (HTTP 429)',
          status,
        )
      }
      if (status >= 500) {
        throw new DeepSeekError(
          'server',
          `DeepSeek server error (HTTP ${status})`,
          status,
        )
      }
      if (status < 200 || status >= 300) {
        throw new DeepSeekError(
          'invalid-response',
          `DeepSeek returned unexpected status (HTTP ${status})`,
          status,
        )
      }

      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new DeepSeekError(
          'invalid-response',
          'DeepSeek response is not valid JSON',
        )
      }
      if (!isRecord(body)) {
        throw new DeepSeekError(
          'invalid-response',
          'DeepSeek response body must be an object',
        )
      }

      const usage = this.parseUsage(body)
      const responseId = isNonEmptyString(body.id) ? body.id : undefined
      const responseModel = isNonEmptyString(body.model)
        ? body.model
        : this.model

      if (!Array.isArray(body.choices) || body.choices.length === 0) {
        throw new DeepSeekError(
          'invalid-response',
          'DeepSeek response has no choices',
        )
      }
      const choice = body.choices[0]
      if (!isRecord(choice) || !isRecord(choice.message)) {
        throw new DeepSeekError(
          'invalid-response',
          'DeepSeek response choice has no message',
        )
      }
      const finishReason =
        typeof choice.finish_reason === 'string' && choice.finish_reason !== ''
          ? choice.finish_reason
          : undefined

      const content = choice.message.content
      if (typeof content !== 'string' || content.trim() === '') {
        const details: DeepSeekFailureDetails = { model: responseModel }
        if (usage !== undefined) details.usage = usage
        if (responseId !== undefined) details.responseId = responseId
        if (finishReason !== undefined) details.finishReason = finishReason
        throw new DeepSeekError(
          'empty-content',
          'DeepSeek returned empty content',
          undefined,
          details,
        )
      }

      // Only finish_reason "stop" counts as a complete draft.
      if (finishReason !== 'stop') {
        const details: DeepSeekFailureDetails = { model: responseModel }
        if (usage !== undefined) details.usage = usage
        if (responseId !== undefined) details.responseId = responseId
        if (finishReason !== undefined) details.finishReason = finishReason
        throw new DeepSeekError(
          'truncated',
          'DeepSeek output did not end with finish_reason stop',
          undefined,
          details,
        )
      }

      // reasoning_content is deliberately never read or surfaced.
      const result: GenerationResult = {
        requestId: request.requestId,
        provider: 'deepseek',
        model: responseModel,
        text: content,
        finishReason: 'stop',
      }
      if (usage !== undefined) {
        result.usage = usage
      }
      if (responseId !== undefined) {
        result.responseId = responseId
      }
      return result
    } catch (error) {
      if (timedOut) {
        throw new DeepSeekError(
          'timeout',
          `DeepSeek request timed out after ${this.timeoutMs}ms`,
        )
      }
      if (error instanceof DeepSeekError) {
        throw error
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new DeepSeekError('timeout', 'DeepSeek request was aborted')
      }
      throw new DeepSeekError('network', 'network error while reaching DeepSeek')
    } finally {
      clearTimeout(timer)
    }
  }
}
