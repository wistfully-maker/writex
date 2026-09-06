import { describe, expect, it, vi } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { WorkstreamConfig } from '../src/contracts.js'
import { createOfficialDshHarnessFactory } from '../src/sdk-adapter.js'

const absoluteWorkspace = process.cwd()

const config: WorkstreamConfig = {
  schemaVersion: 1,
  workstreamId: 'model-evaluation-v1',
  sessionId: 'session-model-evaluation-v1',
  branch: 'feature/model-evaluation-v1',
  workspace: absoluteWorkspace,
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 8192,
}

function fakeSdkRecord() {
  const constructed: Record<string, unknown>[] = []
  const sessionIds: string[] = []
  let closeCalls = 0
  class FakeSdk {
    constructor(options: Record<string, unknown>) {
      constructed.push(options)
    }

    session(id: string) {
      sessionIds.push(id)
      return {
        run: vi.fn(async (message: string) => ({
          sessionId: id,
          finalResponse: `final: ${message}`,
          events: [],
          notifications: [],
        })),
      }
    }

    async close(): Promise<void> {
      closeCalls += 1
    }
  }
  return { Constructor: FakeSdk, constructed, sessionIds, closeCalls: () => closeCalls }
}

describe('createOfficialDshHarnessFactory', () => {
  it('passes the validated config to the SDK constructor without an env object', () => {
    const record = fakeSdkRecord()

    const harness = createOfficialDshHarnessFactory(record.Constructor)(config)

    expect(harness).toBeDefined()
    expect(record.constructed).toHaveLength(1)
    expect(record.constructed[0]).toEqual({
      profile: 'sdk',
      cwd: absoluteWorkspace,
      processCwd: absoluteWorkspace,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      reasoningEffort: ReasoningEffortId('high'),
      maxTokens: 8192,
    })
    expect('env' in record.constructed[0]!).toBe(false)
  })

  it('omits optional reasoning and token settings when absent', () => {
    const record = fakeSdkRecord()
    const minimal = { ...config }
    delete minimal.reasoningEffort
    delete minimal.maxTokens

    createOfficialDshHarnessFactory(record.Constructor)(minimal)

    expect(record.constructed[0]).toEqual({
      profile: 'sdk',
      cwd: absoluteWorkspace,
      processCwd: absoluteWorkspace,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
  })

  it('exposes session(id).run(message) returning only the four port fields', async () => {
    const record = fakeSdkRecord()

    const harness = createOfficialDshHarnessFactory(record.Constructor)(config)
    const session = harness.session('session-model-evaluation-v1')
    expect(record.sessionIds).toEqual(['session-model-evaluation-v1'])

    const result = await session.run('first operation')
    expect(Object.keys(result).sort()).toEqual([
      'events',
      'finalResponse',
      'notifications',
      'sessionId',
    ])
    expect(result).toEqual({
      sessionId: 'session-model-evaluation-v1',
      finalResponse: 'final: first operation',
      events: [],
      notifications: [],
    })
  })

  it('close() delegates once to the underlying SDK harness', async () => {
    const record = fakeSdkRecord()

    const harness = createOfficialDshHarnessFactory(record.Constructor)(config)
    await harness.close()

    expect(record.closeCalls()).toBe(1)
  })
})
