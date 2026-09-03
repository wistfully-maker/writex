import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '@writex/contracts'
import { FakeModelGateway } from '../src/index.js'

function request(requestId: string): GenerationRequest {
  return {
    requestId,
    purpose: 'scene-draft',
    system: 'system',
    prompt: 'prompt',
    metadata: { candidate: 'a' },
  }
}

describe('FakeModelGateway', () => {
  it('serves queued responses deterministically and records a clone of the request', async () => {
    const gateway = new FakeModelGateway(['第一稿', '第二稿'])
    const input = request('request-1')

    const result = await gateway.generate(input)

    expect(result.text).toBe('第一稿')
    expect(result.provider).toBe('fake')
    expect(result.model).toBe('fake-v1')
    expect(result.requestId).toBe('request-1')
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0)
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0)
    expect(gateway.requests).toHaveLength(1)
    expect(gateway.requests[0]).toEqual(input)
    expect(gateway.requests[0]).not.toBe(input)
  })

  it('rejects when no queued response remains', async () => {
    const gateway = new FakeModelGateway([])

    await expect(gateway.generate(request('request-2'))).rejects.toThrow(
      /no queued response/,
    )
  })

  it('copies the supplied responses so generation does not mutate the caller array', async () => {
    const responses = ['第一稿']
    const gateway = new FakeModelGateway(responses)

    await gateway.generate(request('request-3'))

    expect(responses).toEqual(['第一稿'])
  })
})
