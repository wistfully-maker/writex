import { afterEach, describe, expect, it } from 'vitest'
import {
  costFromUsage,
  defaultPriceTable,
  estimateReserveUsd,
  estimateReserveUsdFromTokens,
  framingAllowanceFactor,
  hashEvaluationConfig,
  parseEvaluationConfig,
  serializeEvaluationConfig,
} from '../src/index.js'
import {
  cleanupRoots,
  deepClone,
  makeConfig,
  outputOnlyPriceTable,
} from './helpers.js'

const priceTable = defaultPriceTable()

function parse(value: unknown): ReturnType<typeof parseEvaluationConfig> {
  return parseEvaluationConfig(value, 'test-config.json')
}

afterEach(cleanupRoots)

describe('parseEvaluationConfig', () => {
  it('applies documented defaults for omitted optional fields', () => {
    const raw = {
      schemaVersion: 1,
      budgetUsd: 2.5,
      priceTable: deepClone(priceTable),
    }
    const config = parse(raw)
    expect(config.maxOutputTokens).toBe(4096)
    expect(config.timeoutMs).toBe(60_000)
    expect(config.thinking).toEqual({ type: 'disabled' })
    expect(config.baseUrl).toBe('https://api.deepseek.com')
    expect(config.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
  })

  it('accepts enabled thinking with a top-level reasoning effort (low/high/max)', () => {
    const base = { schemaVersion: 1, budgetUsd: 1, priceTable: deepClone(priceTable) }
    const max = parse({ ...base, thinking: { type: 'enabled' }, reasoningEffort: 'max' })
    expect(max.thinking).toEqual({ type: 'enabled' })
    expect(max.reasoningEffort).toBe('max')
    const low = parse({ ...base, thinking: { type: 'enabled' }, reasoningEffort: 'low' })
    expect(low.reasoningEffort).toBe('low')
  })

  it('rejects unknown top-level fields', () => {
    expect(() =>
      parse({
        schemaVersion: 1,
        budgetUsd: 1,
        maxOutpuTokens: 500,
        priceTable: deepClone(priceTable),
      }),
    ).toThrowError(/unknown config field/)
  })

  it('rejects unsupported schema versions', () => {
    expect(() =>
      parse({ schemaVersion: 2, budgetUsd: 1, priceTable: deepClone(priceTable) }),
    ).toThrowError(/unsupported schemaVersion/)
  })

  it('rejects non-object configs', () => {
    expect(() => parse('nope')).toThrowError(/must be a JSON object/)
    expect(() => parse([])).toThrowError(/must be a JSON object/)
  })

  it('rejects an invalid apiKeyEnv name', () => {
    expect(() =>
      parse({
        schemaVersion: 1,
        apiKeyEnv: 'not a valid env',
        budgetUsd: 1,
        priceTable: deepClone(priceTable),
      }),
    ).toThrowError(/apiKeyEnv must be a valid environment variable name/)
    expect(() =>
      parse({
        schemaVersion: 1,
        apiKeyEnv: '1STARTS_WITH_DIGIT',
        budgetUsd: 1,
        priceTable: deepClone(priceTable),
      }),
    ).toThrowError(/apiKeyEnv must be a valid environment variable name/)
  })

  it('rejects non-HTTPS or non-allowlisted baseUrl', () => {
    const base = { schemaVersion: 1, budgetUsd: 1, priceTable: deepClone(priceTable) }
    expect(() => parse({ ...base, baseUrl: 'http://api.deepseek.com' })).toThrowError(
      /baseUrl must use https/,
    )
    expect(() => parse({ ...base, baseUrl: 'https://evil.example.com' })).toThrowError(
      /baseUrl host must be api.deepseek.com/,
    )
    expect(() => parse({ ...base, baseUrl: 'not a url' })).toThrowError(/not a valid URL/)
  })

  it('rejects userinfo, custom ports, query and fragment without echoing raw values', () => {
    const base = { schemaVersion: 1, budgetUsd: 1, priceTable: deepClone(priceTable) }
    const cases: Array<[string, RegExp]> = [
      ['https://user:sekret@api.deepseek.com', /must not contain userinfo/],
      ['https://api.deepseek.com:444', /must not use a custom port/],
      ['https://api.deepseek.com?key=sekret', /must not contain a query or fragment/],
      ['https://api.deepseek.com/#sekret', /must not contain a query or fragment/],
    ]
    for (const [baseUrl, pattern] of cases) {
      try {
        parse({ ...base, baseUrl })
        expect.unreachable(`should have rejected ${baseUrl}`)
      } catch (error) {
        expect((error as Error).message).toMatch(pattern)
        expect((error as Error).message).not.toContain('sekret')
      }
    }
  })

  it('rejects bad numbers for budget, timeout and maxOutputTokens', () => {
    const base = { schemaVersion: 1, priceTable: deepClone(priceTable) }
    expect(() => parse({ ...base, budgetUsd: 0 })).toThrowError(/budgetUsd/)
    expect(() => parse({ ...base, budgetUsd: -3 })).toThrowError(/budgetUsd/)
    expect(() => parse({ ...base, budgetUsd: 1, timeoutMs: 0 })).toThrowError(/timeoutMs/)
    expect(() => parse({ ...base, budgetUsd: 1, maxOutputTokens: -1 })).toThrowError(
      /maxOutputTokens/,
    )
  })

  it('rejects invalid thinking configuration and reasoningEffort', () => {
    const base = { schemaVersion: 1, budgetUsd: 1, priceTable: deepClone(priceTable) }
    expect(() => parse({ ...base, thinking: { type: 'turbo' } })).toThrowError(
      /thinking.type/,
    )
    // No invented nested effort/budget wire fields.
    expect(() =>
      parse({ ...base, thinking: { type: 'enabled', effort: 'high' } }),
    ).toThrowError(/thinking\.effort is not a known field/)
    expect(() =>
      parse({ ...base, thinking: { type: 'enabled', budgetTokens: 2048 } }),
    ).toThrowError(/thinking\.budgetTokens is not a known field/)
    // Reasoning effort is top-level, limited to low/high/max, needs enabled thinking.
    expect(() =>
      parse({ ...base, thinking: { type: 'disabled' }, reasoningEffort: 'max' }),
    ).toThrowError(/requires thinking\.type "enabled"/)
    expect(() =>
      parse({ ...base, thinking: { type: 'enabled' }, reasoningEffort: 'medium' }),
    ).toThrowError(/reasoningEffort must be/)
  })

  it('requires exactly Flash and Pro in the price table', () => {
    const base = { schemaVersion: 1, budgetUsd: 1 }
    const onlyFlash = {
      ...deepClone(priceTable),
      perMTokens: { 'deepseek-v4-flash': priceTable.perMTokens['deepseek-v4-flash'] },
    }
    expect(() => parse({ ...base, priceTable: onlyFlash })).toThrowError(/missing model/)
    const extraModel = {
      ...deepClone(priceTable),
      perMTokens: {
        ...deepClone(priceTable).perMTokens,
        'claude-x': { inputCacheHitUsdPerMTokens: 1, inputCacheMissUsdPerMTokens: 1, outputUsdPerMTokens: 1 },
      },
    }
    expect(() => parse({ ...base, priceTable: extraModel })).toThrowError(
      /unsupported model/,
    )
  })

  it('validates price entries and source metadata', () => {
    const base = { schemaVersion: 1, budgetUsd: 1 }
    const badRate = {
      ...deepClone(priceTable),
      perMTokens: {
        ...deepClone(priceTable).perMTokens,
        'deepseek-v4-pro': {
          inputCacheHitUsdPerMTokens: 0.1,
          inputCacheMissUsdPerMTokens: -1,
          outputUsdPerMTokens: 2,
        },
      },
    }
    expect(() => parse({ ...base, priceTable: badRate })).toThrowError(/non-negative/)
    const badCurrency = { ...deepClone(priceTable), currency: 'EUR' }
    expect(() => parse({ ...base, priceTable: badCurrency })).toThrowError(/currency/)
    const badDate = { ...deepClone(priceTable), effectiveDate: 'September 7 2026' }
    expect(() => parse({ ...base, priceTable: badDate })).toThrowError(/effectiveDate/)
    const noSource = { ...deepClone(priceTable), source: '  ' }
    expect(() => parse({ ...base, priceTable: noSource })).toThrowError(/priceTable.source/)
  })

  it('keeps only the supported model keys after normalization', () => {
    const raw = {
      schemaVersion: 1,
      budgetUsd: 1,
      priceTable: deepClone(priceTable),
    }
    const config = parse(raw)
    expect(Object.keys(config.priceTable.perMTokens).sort()).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
    ])
  })
})

describe('reserve estimation and cost', () => {
  it('grows with input size and never drops below the output-cap reserve', () => {
    const small = estimateReserveUsd({
      inputUtf8Bytes: 10,
      maxOutputTokens: 100,
      model: 'deepseek-v4-flash',
      priceTable,
    })
    const large = estimateReserveUsd({
      inputUtf8Bytes: 10_000,
      maxOutputTokens: 100,
      model: 'deepseek-v4-flash',
      priceTable,
    })
    expect(large).toBeGreaterThan(small)
    const zero = estimateReserveUsdFromTokens({
      inputTokensUpper: 0,
      maxOutputTokens: 100,
      model: 'deepseek-v4-flash',
      priceTable,
    })
    expect(zero).toBeGreaterThan(0)
  })

  it('models the reserve exactly from an output-only price table', () => {
    const table = outputOnlyPriceTable(1)
    const reserve = estimateReserveUsdFromTokens({
      inputTokensUpper: 0,
      maxOutputTokens: 10,
      model: 'deepseek-v4-pro',
      priceTable: table,
    })
    expect(reserve).toBe(10 * 1e-6 * framingAllowanceFactor)
    expect(estimateReserveUsdFromTokens({
      inputTokensUpper: 0,
      maxOutputTokens: 10,
      model: 'deepseek-v4-pro',
      priceTable: defaultPriceTable(),
    })).toBeGreaterThan(reserve)
  })

  it('charges cache-miss rate when no cache split is reported', () => {
    const { costUsd } = costFromUsage(
      { inputTokens: 1_000_000, outputTokens: 0 },
      'deepseek-v4-flash',
      priceTable,
    )
    expect(costUsd).toBeCloseTo(0.44, 6)
  })

  it('uses a cache split only when consistent with the reported total input', () => {
    const { costUsd, unknown } = costFromUsage(
      {
        inputTokens: 2_000_000,
        cacheHitInputTokens: 1_000_000,
        cacheMissInputTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      'deepseek-v4-pro',
      priceTable,
    )
    expect(unknown).toBe(false)
    expect(costUsd).toBeCloseTo(0.044 + 1.32 + 3.96, 6)

    // One leg missing: derive the other from the total.
    const derived = costFromUsage(
      { inputTokens: 2_000_000, cacheHitInputTokens: 1_000_000, outputTokens: 0 },
      'deepseek-v4-pro',
      priceTable,
    )
    expect(derived.unknown).toBe(false)
    expect(derived.costUsd).toBeCloseTo(0.044 + 1.32, 6)
  })

  it('returns unknown for missing, incomplete or inconsistent usage instead of zeros', () => {
    // No output tokens at all.
    expect(
      costFromUsage({ inputTokens: 1_000_000 }, 'deepseek-v4-pro', priceTable),
    ).toEqual({ costUsd: null, unknown: true })
    // Split reported but no total input to verify it against.
    expect(
      costFromUsage(
        {
          cacheHitInputTokens: 1_000_000,
          cacheMissInputTokens: 1_000_000,
          outputTokens: 100,
        },
        'deepseek-v4-pro',
        priceTable,
      ),
    ).toEqual({ costUsd: null, unknown: true })
    // Split contradicts the total input.
    expect(
      costFromUsage(
        {
          inputTokens: 2_000_000,
          cacheHitInputTokens: 1_000_000,
          cacheMissInputTokens: 500_000,
          outputTokens: 0,
        },
        'deepseek-v4-pro',
        priceTable,
      ),
    ).toEqual({ costUsd: null, unknown: true })
    // Total smaller than the reported hit leg.
    expect(
      costFromUsage(
        { inputTokens: 500_000, cacheHitInputTokens: 1_000_000, outputTokens: 0 },
        'deepseek-v4-pro',
        priceTable,
      ),
    ).toEqual({ costUsd: null, unknown: true })
    // Missing usage entirely.
    expect(costFromUsage(null, 'deepseek-v4-pro', priceTable)).toEqual({
      costUsd: null,
      unknown: true,
    })
  })

  it('never adds reasoning tokens on top of output tokens', () => {
    // DeepSeek completion_tokens already include reasoning_tokens.
    const { costUsd, unknown } = costFromUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        reasoningTokens: 500_000,
      },
      'deepseek-v4-pro',
      priceTable,
    )
    expect(unknown).toBe(false)
    expect(costUsd).toBeCloseTo(1.32 + 3.96, 6)
  })

  it('reports unknown cost for missing usage and never treats it as zero', () => {
    const result = costFromUsage(null, 'deepseek-v4-pro', priceTable)
    expect(result.unknown).toBe(true)
    expect(result.costUsd).toBeNull()
  })
})

describe('config hashing and serialization', () => {
  it('hashes stable canonical configs and is sensitive to any field', () => {
    const a = makeConfig()
    const b = makeConfig()
    expect(hashEvaluationConfig(a)).toBe(hashEvaluationConfig(b))
    expect(hashEvaluationConfig(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashEvaluationConfig(makeConfig({ budgetUsd: 99 }))).not.toBe(
      hashEvaluationConfig(a),
    )
  })

  it('serializes deterministically regardless of key order in the input', () => {
    const json = serializeEvaluationConfig(makeConfig({ budgetUsd: 3 }))
    const parsed = JSON.parse(json) as Record<string, unknown>
    const keys = Object.keys(parsed)
    expect(keys).toEqual([...keys].sort())
    const reparsed = parse(parsed)
    expect(serializeEvaluationConfig(reparsed)).toBe(json)
  })
})
