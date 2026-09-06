import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DriverCheckpoint, UsageSummary } from '../src/contracts.js'
import { JsonlController, startJsonlLoop } from '../src/jsonl-controller.js'

const zeroUsage = (): UsageSummary => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
})

interface FakeDriverState {
  sends: string[]
  capsules: unknown[]
  closed: number
}

function makeFakeDriver(state: FakeDriverState) {
  return {
    async send(message: string): Promise<DriverCheckpoint> {
      state.sends.push(message)
      return {
        workstreamId: 'jsonl-v1',
        sessionId: 'session-jsonl-v1',
        status: 'idle',
        finalResponse: `final: ${message}`,
        eventCount: 1,
        notificationCount: 0,
        usage: zeroUsage(),
        compactionObserved: false,
      }
    },
    async saveCompactionCapsule(capsule: unknown): Promise<string> {
      state.capsules.push(capsule)
      return `/capsules/jsonl-v1.json`
    },
    async close(): Promise<void> {
      state.closed += 1
    },
  }
}

function makeOpenDriver(state: FakeDriverState, openImpl?: () => Promise<unknown>) {
  const openCalls: Array<{ config: unknown; controllerRoot: string }> = []
  const openDriver = vi.fn(async (options: { config: unknown; controllerRoot: string }) => {
    openCalls.push({ config: options.config, controllerRoot: options.controllerRoot })
    if (openImpl) await openImpl()
    return makeFakeDriver(state)
  })
  return { openDriver, openCalls }
}

const controllerRoot = 'D:/program/writex'
const config = {
  schemaVersion: 1,
  workstreamId: 'jsonl-v1',
  sessionId: 'session-jsonl-v1',
  branch: 'feature/jsonl-v1',
  workspace: 'D:/program/writex/.worktrees/jsonl-v1',
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
}

const noopHarnessFactory = (): never => {
  throw new Error('harnessFactory must not be used in controller tests')
}

describe('JsonlController', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('handles an ordered open/send/capsule/close sequence through one driver', async () => {
    const state: FakeDriverState = { sends: [], capsules: [], closed: 0 }
    const { openDriver, openCalls } = makeOpenDriver(state)
    const controller = new JsonlController(openDriver, noopHarnessFactory)

    const open = await controller.handle({
      id: '1',
      type: 'open',
      controllerRoot,
      config,
    })
    expect(open).toEqual({ id: '1', ok: true, result: { status: 'idle' } })
    expect(openCalls).toHaveLength(1)
    expect(openCalls[0]).toMatchObject({ controllerRoot, config })

    const send = await controller.handle({ id: '2', type: 'send', message: 'first operation' })
    expect(send).toMatchObject({
      id: '2',
      ok: true,
      result: { status: 'idle', finalResponse: 'final: first operation' },
    })

    const capsule = await controller.handle({
      id: '3',
      type: 'capsule',
      capsule: { objective: 'finish jsonl' },
    })
    expect(capsule).toEqual({ id: '3', ok: true, result: { path: '/capsules/jsonl-v1.json' } })

    const close = await controller.handle({ id: '4', type: 'close' })
    expect(close).toEqual({ id: '4', ok: true, result: { status: 'closed' } })

    expect(openDriver).toHaveBeenCalledTimes(1)
    expect(state.sends).toEqual(['first operation'])
    expect(state.capsules).toEqual([{ objective: 'finish jsonl' }])
    expect(state.closed).toBe(1)
  })

  it('rejects send before open and a second open while one driver is open', async () => {
    const state: FakeDriverState = { sends: [], capsules: [], closed: 0 }
    const { openDriver } = makeOpenDriver(state)
    const controller = new JsonlController(openDriver, noopHarnessFactory)

    const early = await controller.handle({ id: '1', type: 'send', message: 'too early' })
    expect(early).toEqual({
      id: '1',
      ok: false,
      error: { code: 'DSH_DRIVER_ERROR', message: 'driver is not open' },
    })

    await controller.handle({ id: '2', type: 'open', controllerRoot, config })
    const again = await controller.handle({ id: '3', type: 'open', controllerRoot, config })
    expect(again).toMatchObject({
      id: '3',
      ok: false,
      error: { code: 'DSH_DRIVER_ERROR', message: 'driver is already open' },
    })
    expect(openDriver).toHaveBeenCalledTimes(1)

    await controller.handle({ id: '4', type: 'close' })
    const reopen = await controller.handle({ id: '5', type: 'open', controllerRoot, config })
    expect(reopen).toEqual({ id: '5', ok: true, result: { status: 'idle' } })
    expect(openDriver).toHaveBeenCalledTimes(2)
  })

  it('rejects unknown command types and unknown fields while preserving the id', async () => {
    const state: FakeDriverState = { sends: [], capsules: [], closed: 0 }
    const { openDriver } = makeOpenDriver(state)
    const controller = new JsonlController(openDriver, noopHarnessFactory)
    await controller.handle({ id: '1', type: 'open', controllerRoot, config })

    const unknownType = await controller.handle({ id: '9', type: 'explode' })
    expect(unknownType).toMatchObject({
      id: '9',
      ok: false,
      error: { code: 'DSH_DRIVER_ERROR', message: 'unknown command type' },
    })

    const unknownField = await controller.handle({
      id: '10',
      type: 'send',
      message: 'first operation',
      extra: 1,
    })
    expect(unknownField).toMatchObject({
      id: '10',
      ok: false,
      error: { code: 'DSH_DRIVER_ERROR', message: 'unknown command field: extra' },
    })

    expect(state.sends).toEqual([])
  })

  it('returns sanitized errors without stack traces', async () => {
    const state: FakeDriverState = { sends: [], capsules: [], closed: 0 }
    const { openDriver } = makeOpenDriver(state, async () => {
      const error = new Error('profile handshake failed')
      error.stack = 'Error: profile handshake failed\n    at HarnessClient.start (client.ts:88:12)'
      throw error
    })
    const controller = new JsonlController(openDriver, noopHarnessFactory)

    const open = await controller.handle({ id: '1', type: 'open', controllerRoot, config })

    expect(open).toEqual({
      id: '1',
      ok: false,
      error: { code: 'DSH_DRIVER_ERROR', message: 'profile handshake failed' },
    })
    expect(JSON.stringify(open)).not.toContain('client.ts')
    expect(JSON.stringify(open)).not.toMatch(/\n/)
  })

  it('rejects non-object commands and missing ids', async () => {
    const state: FakeDriverState = { sends: [], capsules: [], closed: 0 }
    const { openDriver } = makeOpenDriver(state)
    const controller = new JsonlController(openDriver, noopHarnessFactory)

    const nonObject = await controller.handle('not-an-object')
    expect(nonObject).toMatchObject({
      id: 'unknown',
      ok: false,
      error: { message: 'command must be an object' },
    })

    const missingId = await controller.handle({ type: 'open', controllerRoot, config })
    expect(missingId).toMatchObject({
      id: 'unknown',
      ok: false,
      error: { message: 'command id is required' },
    })
  })
})

describe('startJsonlLoop', () => {
  it('serializes a JSONL stream into one compact JSON line per command', async () => {
    const state: FakeDriverState = { sends: [], capsules: [], closed: 0 }
    const { openDriver } = makeOpenDriver(state)
    const controller = new JsonlController(openDriver, noopHarnessFactory)
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      text += chunk
    })

    const loop = startJsonlLoop(input, output, controller)

    input.write(`${JSON.stringify({ id: '1', type: 'open', controllerRoot, config })}\n`)
    input.write(`${JSON.stringify({ id: '2', type: 'send', message: 'first operation' })}\n`)
    input.write(`${JSON.stringify({ id: '3', type: 'capsule', capsule: { objective: 'x' } })}\n`)
    input.write('this is not json\n')
    input.write('\n')
    input.write(`${JSON.stringify({ id: '4', type: 'close' })}\n`)
    input.end()
    await loop

    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(5)
    const responses = lines.map((line) => JSON.parse(line) as { id: string; ok: boolean })
    expect(responses.map((response) => response.id)).toEqual(['1', '2', '3', 'unknown', '4'])
    expect(responses[3]).toEqual({
      id: 'unknown',
      ok: false,
      error: { code: 'INVALID_JSON', message: 'invalid JSON' },
    })
    expect(responses.map((response) => response.ok)).toEqual([true, true, true, false, true])
    expect(state.sends).toEqual(['first operation'])
    expect(state.closed).toBe(1)
  })

  it('shutdown() idempotently closes and clears the open driver so a new open can start', async () => {
    const state: FakeDriverState = { sends: [], capsules: [], closed: 0 }
    const { openDriver } = makeOpenDriver(state)
    const controller = new JsonlController(openDriver, noopHarnessFactory)

    await controller.handle({ id: '1', type: 'open', controllerRoot, config })
    await controller.shutdown()
    await controller.shutdown()

    expect(state.closed).toBe(1)
    const reopen = await controller.handle({ id: '2', type: 'open', controllerRoot, config })
    expect(reopen).toEqual({ id: '2', ok: true, result: { status: 'idle' } })
    expect(openDriver).toHaveBeenCalledTimes(2)
  })

  it('closes an open driver when input ends without a close command', async () => {
    const state: FakeDriverState = { sends: [], capsules: [], closed: 0 }
    const { openDriver } = makeOpenDriver(state)
    const controller = new JsonlController(openDriver, noopHarnessFactory)
    const input = new PassThrough()
    const output = new PassThrough()
    output.resume()

    const loop = startJsonlLoop(input, output, controller)

    input.write(`${JSON.stringify({ id: '1', type: 'open', controllerRoot, config })}\n`)
    input.end()
    await loop

    expect(openDriver).toHaveBeenCalledTimes(1)
    expect(state.closed).toBe(1)
  })

  it('resolves promptly after a successful close command without waiting for stdin EOF', async () => {
    const state: FakeDriverState = { sends: [], capsules: [], closed: 0 }
    const { openDriver } = makeOpenDriver(state)
    const controller = new JsonlController(openDriver, noopHarnessFactory)
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => {
      text += chunk
    })

    const loop = startJsonlLoop(input, output, controller)

    input.write(`${JSON.stringify({ id: '1', type: 'open', controllerRoot, config })}\n`)
    input.write(`${JSON.stringify({ id: '2', type: 'close' })}\n`)
    await loop

    await new Promise((resolve) => setImmediate(resolve))
    const responses = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string; ok: boolean; result?: { status: string } })
    expect(responses).toEqual([
      { id: '1', ok: true, result: { status: 'idle' } },
      { id: '2', ok: true, result: { status: 'closed' } },
    ])
    expect(state.closed).toBe(1)
  })
})
