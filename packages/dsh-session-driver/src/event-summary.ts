import type { UsageSummary } from './contracts.js'

export interface EventSummary {
  usage: UsageSummary
  compactionObserved: boolean
  compactCount: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function token(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function summarizeEvents(events: unknown[]): EventSummary {
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let compactCount = 0
  for (const event of events) {
    const envelope = record(event)
    if (!envelope) continue
    if (envelope.type === 'compaction/end') compactCount += 1
    if (envelope.type !== 'assistant/message') continue
    const data = record(envelope.data)
    const eventUsage = record(data?.usage)
    if (!eventUsage) continue
    usage.inputTokens += token(eventUsage.inputTokens)
    usage.outputTokens += token(eventUsage.outputTokens)
    usage.cacheReadTokens += token(eventUsage.cacheReadTokens)
    usage.cacheWriteTokens += token(eventUsage.cacheWriteTokens)
    usage.reasoningTokens += token(eventUsage.reasoningTokens)
  }
  return { usage, compactionObserved: compactCount > 0, compactCount }
}
