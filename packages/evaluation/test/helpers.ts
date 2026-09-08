import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeepSeekModelId, DeepSeekReasoningEffort } from '@writex/model-gateway'
import {
  defaultEvaluationBaseUrl,
  defaultEvaluationTimeoutMs,
  defaultPriceTable,
  type EvaluationConfig,
  type EvaluationPriceTable,
  type EvaluationThinking,
} from '../src/index.js'

const roots: string[] = []

export async function makeRoot(prefix = 'writex-eval-'): Promise<string> {
  // The run root itself must not exist (create-only init), so create a temp
  // parent and return a nested, not-yet-existing path under it.
  const parent = await mkdtemp(join(tmpdir(), prefix))
  roots.push(parent)
  return join(parent, 'run')
}

export async function cleanupRoots(): Promise<void> {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
}

export interface ConfigOverrides {
  budgetUsd?: number
  maxOutputTokens?: number
  apiKeyEnv?: string
  timeoutMs?: number
  thinking?: EvaluationThinking
  reasoningEffort?: DeepSeekReasoningEffort
  priceTable?: EvaluationPriceTable
}

/** A valid, fully normalized config for tests (100 output tokens by default). */
export function makeConfig(overrides: ConfigOverrides = {}): EvaluationConfig {
  const config: EvaluationConfig = {
    schemaVersion: 1,
    apiKeyEnv: overrides.apiKeyEnv ?? 'DEEPSEEK_API_KEY',
    baseUrl: defaultEvaluationBaseUrl,
    timeoutMs: overrides.timeoutMs ?? defaultEvaluationTimeoutMs,
    maxOutputTokens: overrides.maxOutputTokens ?? 100,
    thinking: overrides.thinking ?? { type: 'disabled' },
    budgetUsd: overrides.budgetUsd ?? 100,
    priceTable: overrides.priceTable ?? defaultPriceTable(),
  }
  if (overrides.reasoningEffort !== undefined) {
    config.reasoningEffort = overrides.reasoningEffort
  }
  return config
}

/**
 * Price table that prices only output tokens at `outputUsdPerMTokens` and
 * charges nothing for input tokens; convenient for deterministic budget tests.
 */
export function outputOnlyPriceTable(
  outputUsdPerMTokens: number,
  options: { inputCacheMissUsdPerMTokens?: number; inputCacheHitUsdPerMTokens?: number } = {},
): EvaluationPriceTable {
  const base = defaultPriceTable()
  for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro'] as const) {
    base.perMTokens[model] = {
      inputCacheHitUsdPerMTokens:
        options.inputCacheHitUsdPerMTokens ?? 0,
      inputCacheMissUsdPerMTokens:
        options.inputCacheMissUsdPerMTokens ?? 0,
      outputUsdPerMTokens,
    }
  }
  return base
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export type { DeepSeekModelId, DeepSeekReasoningEffort }
