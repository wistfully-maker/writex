import { describe, expect, it } from 'vitest'
import { summarizeEvents } from '../src/event-summary.js'

const usageEvent = (usage: Record<string, unknown>): unknown => ({
  type: 'assistant/message',
  data: { usage },
})

describe('summarizeEvents', () => {
  it('sums committed usage and counts automatic compaction events', () => {
    const events = [
      usageEvent({
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: 10,
        reasoningTokens: 12,
      }),
      { type: 'compaction/start', data: {} },
      { type: 'compaction/end', data: {} },
    ]

    expect(summarizeEvents(events)).toEqual({
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: 10,
        reasoningTokens: 12,
      },
      compactionObserved: true,
      compactCount: 1,
    })
  })

  it('keeps reasoningTokens informational and separate from outputTokens', () => {
    const summary = summarizeEvents([
      usageEvent({ inputTokens: 5, outputTokens: 5, reasoningTokens: 7 }),
    ])

    expect(summary.usage.outputTokens).toBe(5)
    expect(summary.usage.reasoningTokens).toBe(7)
  })

  it('contributes zero for unknown shapes and malformed usage without throwing', () => {
    const events: unknown[] = [
      null,
      42,
      'string',
      [],
      {},
      { type: 'assistant/message' },
      { type: 'assistant/message', data: {} },
      { type: 'assistant/message', data: { usage: 'not-an-object' } },
      {
        type: 'assistant/message',
        data: { usage: { inputTokens: 'NaN', outputTokens: -1, cacheReadTokens: Infinity } },
      },
      { type: 'compaction/start', data: {} },
    ]

    expect(() => summarizeEvents(events)).not.toThrow()
    expect(summarizeEvents(events)).toEqual({
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      },
      compactionObserved: false,
      compactCount: 0,
    })
  })

  it('accumulates usage across multiple committed messages', () => {
    const summary = summarizeEvents([
      usageEvent({ inputTokens: 100, outputTokens: 10 }),
      { type: 'user/message', data: { usage: { inputTokens: 999 } } },
      usageEvent({ inputTokens: 50, outputTokens: 20 }),
    ])

    expect(summary.usage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    })
    expect(summary.compactionObserved).toBe(false)
  })
})
