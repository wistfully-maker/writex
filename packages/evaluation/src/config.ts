import type { DeepSeekModelId, DeepSeekReasoningEffort } from '@writex/model-gateway'
import type { GenerationUsage } from '@writex/contracts'
import {
  evaluationConfigVersion,
  evaluationModels,
  type EvaluationConfig,
  type EvaluationPriceTable,
  type EvaluationThinking,
  type PriceEntry,
} from './contracts.js'
import { sha256Hex } from './fixtures.js'

export const defaultEvaluationBaseUrl = 'https://api.deepseek.com'
export const defaultEvaluationTimeoutMs = 60_000
export const defaultEvaluationMaxOutputTokens = 4096
export const defaultEvaluationThinking: EvaluationThinking = { type: 'disabled' }
export const defaultEvaluationApiKeyEnv = 'DEEPSEEK_API_KEY'
export const defaultEffectiveDate = '2026-09-07'
export const defaultPriceSource =
  'https://api-docs.deepseek.com/quick_start/pricing'

/**
 * Conservative peak rates from the official DeepSeek pricing page, in USD per
 * one million tokens. Cache-hit rates are used for reporting actual known
 * costs; budget pre-checks always reserve with cache-miss input rates.
 */
export function defaultPriceTable(): EvaluationPriceTable {
  return {
    currency: 'USD',
    source: defaultPriceSource,
    effectiveDate: defaultEffectiveDate,
    perMTokens: {
      'deepseek-v4-flash': {
        inputCacheHitUsdPerMTokens: 0.014,
        inputCacheMissUsdPerMTokens: 0.44,
        outputUsdPerMTokens: 1.32,
      },
      'deepseek-v4-pro': {
        inputCacheHitUsdPerMTokens: 0.044,
        inputCacheMissUsdPerMTokens: 1.32,
        outputUsdPerMTokens: 3.96,
      },
    },
  }
}

/** Framing allowance applied on top of reserve estimates (conservative). */
export const framingAllowanceFactor = 1.15

const USD_PER_MILLION = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function invalid(source: string, message: string): never {
  throw new Error(`${source}: ${message}`)
}

function sortObject(value: object): Record<string, unknown> {
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const entry = record[key]
    if (isRecord(entry)) {
      sorted[key] = sortObject(entry)
    } else {
      sorted[key] = entry
    }
  }
  return sorted
}

/** Deterministic serialization used for persisted config files and hashing. */
export function serializeEvaluationConfig(config: EvaluationConfig): string {
  return `${JSON.stringify(sortObject(config), null, 2)}\n`
}

export function hashEvaluationConfig(config: EvaluationConfig): string {
  return sha256Hex(serializeEvaluationConfig(config))
}

function parsePriceEntry(source: string, model: string, value: unknown): PriceEntry {
  if (!isRecord(value)) {
    invalid(source, `priceTable.perMTokens.${model} must be an object`)
  }
  const allowed = new Set([
    'inputCacheHitUsdPerMTokens',
    'inputCacheMissUsdPerMTokens',
    'outputUsdPerMTokens',
  ])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(source, `priceTable.perMTokens.${model}.${key} is not a known field`)
    }
  }
  const hit = value.inputCacheHitUsdPerMTokens
  const miss = value.inputCacheMissUsdPerMTokens
  const output = value.outputUsdPerMTokens
  if (!finiteNonNegative(hit)) {
    invalid(
      source,
      `priceTable.perMTokens.${model}.inputCacheHitUsdPerMTokens must be a finite non-negative number`,
    )
  }
  if (!finiteNonNegative(miss)) {
    invalid(
      source,
      `priceTable.perMTokens.${model}.inputCacheMissUsdPerMTokens must be a finite non-negative number`,
    )
  }
  if (!finiteNonNegative(output)) {
    invalid(
      source,
      `priceTable.perMTokens.${model}.outputUsdPerMTokens must be a finite non-negative number`,
    )
  }
  return {
    inputCacheHitUsdPerMTokens: hit,
    inputCacheMissUsdPerMTokens: miss,
    outputUsdPerMTokens: output,
  }
}

function parsePriceTable(source: string, value: unknown): EvaluationPriceTable {
  if (!isRecord(value)) {
    invalid(source, 'priceTable must be an object')
  }
  const allowed = new Set(['currency', 'source', 'effectiveDate', 'perMTokens'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(source, `priceTable.${key} is not a known field`)
    }
  }
  if (value.currency !== 'USD') {
    invalid(source, 'priceTable.currency must be "USD"')
  }
  const sourceLabel = value.source
  if (!nonBlankString(sourceLabel)) {
    invalid(source, 'priceTable.source must be a non-blank string')
  }
  const effectiveDate = value.effectiveDate
  if (
    !nonBlankString(effectiveDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)
  ) {
    invalid(source, 'priceTable.effectiveDate must be a YYYY-MM-DD date')
  }
  if (!isRecord(value.perMTokens)) {
    invalid(source, 'priceTable.perMTokens must be an object')
  }
  const keys = Object.keys(value.perMTokens)
  const expected = [...evaluationModels]
  const extra = keys.filter((key) => !expected.includes(key as DeepSeekModelId))
  const missing = expected.filter((key) => !keys.includes(key))
  if (extra.length > 0) {
    invalid(source, `priceTable.perMTokens contains unsupported model(s): ${extra.join(', ')}`)
  }
  if (missing.length > 0) {
    invalid(source, `priceTable.perMTokens is missing model(s): ${missing.join(', ')}`)
  }
  const perMTokens = {} as Record<DeepSeekModelId, PriceEntry>
  for (const model of evaluationModels) {
    perMTokens[model] = parsePriceEntry(source, model, value.perMTokens[model])
  }
  return {
    currency: 'USD',
    source: sourceLabel,
    effectiveDate,
    perMTokens,
  }
}

function parseThinking(source: string, value: unknown): EvaluationThinking {
  if (!isRecord(value)) {
    invalid(source, 'thinking must be an object')
  }
  const allowed = new Set(['type'])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(source, `thinking.${key} is not a known field`)
    }
  }
  if (value.type !== 'enabled' && value.type !== 'disabled') {
    invalid(source, 'thinking.type must be "disabled" or "enabled"')
  }
  return { type: value.type }
}

/** Allowed top-level config keys (schema version 1). */
const configKeys = new Set([
  'schemaVersion',
  'apiKeyEnv',
  'baseUrl',
  'timeoutMs',
  'maxOutputTokens',
  'thinking',
  'reasoningEffort',
  'budgetUsd',
  'priceTable',
])

/**
 * Validate an external config JSON value and return a fully normalized
 * `EvaluationConfig`. Unknown keys and out-of-range values are rejected with
 * messages prefixed by `source` so callers know which file failed.
 */
export function parseEvaluationConfig(value: unknown, source: string): EvaluationConfig {
  if (!isRecord(value)) {
    invalid(source, 'config must be a JSON object')
  }
  for (const key of Object.keys(value)) {
    if (!configKeys.has(key)) {
      invalid(source, `unknown config field: ${key}`)
    }
  }
  if (value.schemaVersion !== evaluationConfigVersion) {
    invalid(source, `unsupported schemaVersion: expected ${evaluationConfigVersion}`)
  }

  const apiKeyEnv =
    value.apiKeyEnv === undefined ? defaultEvaluationApiKeyEnv : value.apiKeyEnv
  if (!nonBlankString(apiKeyEnv) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    invalid(source, 'apiKeyEnv must be a valid environment variable name')
  }

  const baseUrl =
    value.baseUrl === undefined ? defaultEvaluationBaseUrl : value.baseUrl
  if (!nonBlankString(baseUrl)) {
    invalid(source, 'baseUrl must be a non-blank string')
  }
  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    invalid(source, 'baseUrl is not a valid URL')
  }
  if (parsedUrl.protocol !== 'https:') {
    invalid(source, 'baseUrl must use https')
  }
  if (parsedUrl.hostname !== 'api.deepseek.com') {
    invalid(source, 'baseUrl host must be api.deepseek.com')
  }
  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    invalid(source, 'baseUrl must not contain userinfo')
  }
  if (parsedUrl.port !== '' && parsedUrl.port !== '443') {
    invalid(source, 'baseUrl must not use a custom port')
  }
  if (parsedUrl.search !== '' || parsedUrl.hash !== '') {
    invalid(source, 'baseUrl must not contain a query or fragment')
  }

  const timeoutMs =
    value.timeoutMs === undefined ? defaultEvaluationTimeoutMs : value.timeoutMs
  if (!positiveInteger(timeoutMs)) {
    invalid(source, 'timeoutMs must be a positive integer')
  }
  const maxOutputTokens =
    value.maxOutputTokens === undefined
      ? defaultEvaluationMaxOutputTokens
      : value.maxOutputTokens
  if (!positiveInteger(maxOutputTokens)) {
    invalid(source, 'maxOutputTokens must be a positive integer')
  }
  const budgetUsd = value.budgetUsd
  if (!finitePositive(budgetUsd)) {
    invalid(source, 'budgetUsd must be a finite positive number')
  }
  const thinking =
    value.thinking === undefined
      ? { ...defaultEvaluationThinking }
      : parseThinking(source, value.thinking)

  let reasoningEffort: DeepSeekReasoningEffort | undefined
  if (value.reasoningEffort !== undefined) {
    const raw = value.reasoningEffort
    if (raw !== 'low' && raw !== 'high' && raw !== 'max') {
      invalid(source, 'reasoningEffort must be "low", "high" or "max"')
    }
    if (thinking.type !== 'enabled') {
      invalid(source, 'reasoningEffort requires thinking.type "enabled"')
    }
    reasoningEffort = raw
  }

  const config: EvaluationConfig = {
    schemaVersion: evaluationConfigVersion,
    apiKeyEnv,
    baseUrl: parsedUrl.origin,
    timeoutMs,
    maxOutputTokens,
    thinking,
    budgetUsd,
    priceTable: parsePriceTable(source, value.priceTable),
  }
  if (reasoningEffort !== undefined) {
    config.reasoningEffort = reasoningEffort
  }
  return config
}

/**
 * Upper-bound estimate of prompt tokens from its UTF-8 byte length.
 * Conservative: at most one token per input byte. Real tokenizers run around
 * 0.25 tokens/byte for ASCII and 1–2 tokens per 3-byte CJK character, so this
 * over-estimates and keeps reserves on the safe side.
 */
export function inputTokenUpperEstimate(utf8Bytes: number): number {
  return Math.max(0, Math.ceil(utf8Bytes))
}

/**
 * Conservative USD reserve for one request priced from an upper-bound token
 * estimate: input tokens at the cache-miss input rate plus the full output
 * token cap at the output rate, times the framing allowance. This is an
 * estimate, never a billing cap.
 */
export function estimateReserveUsdFromTokens(input: {
  inputTokensUpper: number
  maxOutputTokens: number
  model: DeepSeekModelId
  priceTable: EvaluationPriceTable
}): number {
  const entry = input.priceTable.perMTokens[input.model]
  const missPerToken = entry.inputCacheMissUsdPerMTokens / USD_PER_MILLION
  const outputPerToken = entry.outputUsdPerMTokens / USD_PER_MILLION
  const inputTokens = Math.max(0, Math.ceil(input.inputTokensUpper))
  const base = inputTokens * missPerToken + input.maxOutputTokens * outputPerToken
  return base * framingAllowanceFactor
}

/**
 * Conservative USD reserve for one request derived from the UTF-8 byte length
 * of its prompt (see `inputTokenUpperEstimate`).
 */
export function estimateReserveUsd(input: {
  inputUtf8Bytes: number
  maxOutputTokens: number
  model: DeepSeekModelId
  priceTable: EvaluationPriceTable
}): number {
  return estimateReserveUsdFromTokens({
    inputTokensUpper: inputTokenUpperEstimate(input.inputUtf8Bytes),
    maxOutputTokens: input.maxOutputTokens,
    model: input.model,
    priceTable: input.priceTable,
  })
}

/**
 * Derive an ESTIMATED USD cost from reported usage (price-derived, never a
 * billing figure; peak default rates may overestimate). Rules:
 * - Missing output tokens, or missing total input when no split is reported,
 *   make the cost unknown — missing fields are never treated as zero.
 * - A cache split is used only when it is consistent with the reported total
 *   input; a single reported leg is completed as total minus that leg.
 * - reasoningTokens are deliberately ignored: DeepSeek completion tokens
 *   already include reasoning tokens, so adding them would double-count.
 */
export function costFromUsage(
  usage: GenerationUsage | null,
  model: DeepSeekModelId,
  priceTable: EvaluationPriceTable,
): { costUsd: number | null; unknown: boolean } {
  if (usage === null || usage.outputTokens === undefined) {
    return { costUsd: null, unknown: true }
  }
  const entry = priceTable.perMTokens[model]
  const missPerToken = entry.inputCacheMissUsdPerMTokens / USD_PER_MILLION
  const hitPerToken = entry.inputCacheHitUsdPerMTokens / USD_PER_MILLION
  const outputPerToken = entry.outputUsdPerMTokens / USD_PER_MILLION

  const hitReported = usage.cacheHitInputTokens
  const missReported = usage.cacheMissInputTokens
  const totalInput = usage.inputTokens

  let hitTokens = 0
  let missTokens = 0
  if (hitReported === undefined && missReported === undefined) {
    // No caching reported: the whole input is priced at the miss rate.
    if (totalInput === undefined) {
      return { costUsd: null, unknown: true }
    }
    missTokens = totalInput
  } else {
    // A split was reported: it is only trustworthy against the total input.
    if (totalInput === undefined) {
      return { costUsd: null, unknown: true }
    }
    if (hitReported !== undefined && missReported !== undefined) {
      if (hitReported + missReported !== totalInput) {
        return { costUsd: null, unknown: true }
      }
      hitTokens = hitReported
      missTokens = missReported
    } else if (hitReported !== undefined) {
      const derivedMiss = totalInput - hitReported
      if (derivedMiss < 0) {
        return { costUsd: null, unknown: true }
      }
      hitTokens = hitReported
      missTokens = derivedMiss
    } else {
      const derivedHit = totalInput - (missReported as number)
      if (derivedHit < 0) {
        return { costUsd: null, unknown: true }
      }
      hitTokens = derivedHit
      missTokens = missReported as number
    }
  }

  const cost =
    missTokens * missPerToken +
    hitTokens * hitPerToken +
    usage.outputTokens * outputPerToken
  return { costUsd: cost, unknown: false }
}

/** Labels that every plan/report must state about price and budget meaning. */
export function priceAssumptions(priceTable: EvaluationPriceTable): string[] {
  return [
    `价格来源：${priceTable.source}；生效日期：${priceTable.effectiveDate}；币种 USD。`,
    '预留与估算按输入字节数上界 × 缓存未命中单价 + 输出上限 × 输出单价，并含 15% 框算余量；这是估算，不是计费硬上限。',
    '未上报用量时成本记为未知，绝不当作零；预算检查在每次请求前执行，失败与不确定的请求保留预留额。',
  ]
}
