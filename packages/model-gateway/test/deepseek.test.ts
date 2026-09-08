import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '@writex/contracts'
import {
  DeepSeekError,
  DeepSeekModelGateway,
  defaultDeepSeekApiKeyEnv,
  type DeepSeekFetch,
  type DeepSeekGatewayOptions,
} from '../src/index.js'

function request(requestId = 'attempt-1'): GenerationRequest {
  return {
    requestId,
    purpose: 'scene-draft',
    system: '系统提示',
    prompt: '请创作正文',
    metadata: { model: 'deepseek-v4-flash' },
  }
}

interface RecordedCall {
  url: string
  init: RequestInit
}

function recordFetch(bodies: Array<Response | (() => Promise<Response>)>) {
  const calls: RecordedCall[] = []
  const fetchImpl: DeepSeekFetch = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input)
    calls.push({ url, init: init ?? {} })
    const next = bodies.shift()
    if (next === undefined) {
      throw new TypeError('fetch failed: no canned response')
    }
    if (typeof next === 'function') {
      return next()
    }
    return next
  }) as DeepSeekFetch
  return { calls, fetchImpl }
}

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const keyEnv = defaultDeepSeekApiKeyEnv

function gatewayWith(
  fetchImpl: DeepSeekFetch,
  extra?: Partial<DeepSeekGatewayOptions>,
): DeepSeekModelGateway {
  return new DeepSeekModelGateway({
    model: 'deepseek-v4-flash',
    lookupEnv: (name) => (name === keyEnv ? 'sk-test-secret' : undefined),
    fetch: fetchImpl,
    ...extra,
  })
}

const successBody = {
  id: 'chatcmpl-literary-0001',
  model: 'deepseek-v4-flash',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '正文内容。',
        reasoning_content: 'secret-hidden-reasoning',
      },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 7,
    prompt_cache_hit_tokens: 4,
    prompt_cache_miss_tokens: 8,
    completion_tokens_details: { reasoning_tokens: 2 },
  },
}

describe('DeepSeekModelGateway wire mapping', () => {
  it('POSTs chat completions with the expected payload and returns mapped fields only', async () => {
    const { calls, fetchImpl } = recordFetch([jsonResponse(successBody)])
    const gateway = gatewayWith(fetchImpl)

    const result = await gateway.generate(request())

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.deepseek.com/chat/completions')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test-secret')
    expect(headers['Content-Type']).toBe('application/json')

    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(sent.model).toBe('deepseek-v4-flash')
    expect(sent.stream).toBe(false)
    expect(sent.max_tokens).toBe(4096)
    expect(sent.thinking).toEqual({ type: 'disabled' })
    expect(sent.reasoning_effort).toBeUndefined()
    expect(sent.temperature).toBeUndefined()
    expect(sent.messages).toEqual([
      { role: 'system', content: '系统提示' },
      { role: 'user', content: '请创作正文' },
    ])

    expect(result.provider).toBe('deepseek')
    expect(result.requestId).toBe('attempt-1')
    expect(result.model).toBe('deepseek-v4-flash')
    expect(result.text).toBe('正文内容。')
    expect(result.responseId).toBe('chatcmpl-literary-0001')
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      cacheHitInputTokens: 4,
      cacheMissInputTokens: 8,
      reasoningTokens: 2,
    })
  })

  it('never surfaces reasoning_content or the raw response in the result', async () => {
    const { fetchImpl } = recordFetch([jsonResponse(successBody)])
    const gateway = gatewayWith(fetchImpl)

    const result = await gateway.generate(request())

    expect(result.rawResponse).toBeUndefined()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('reasoning_content')
    expect(serialized).not.toContain('secret-hidden-reasoning')
  })

  it('records the provider-returned model when it differs from the requested one', async () => {
    const { fetchImpl } = recordFetch([
      jsonResponse({ ...successBody, model: 'deepseek-v4-pro' }),
    ])
    const gateway = gatewayWith(fetchImpl)

    const result = await gateway.generate(request())

    expect(result.model).toBe('deepseek-v4-pro')
  })

  it('sends reasoning_effort as a top-level field only, never nested in thinking', async () => {
    const { calls, fetchImpl } = recordFetch([jsonResponse(successBody)])
    const gateway = gatewayWith(fetchImpl, {
      model: 'deepseek-v4-pro',
      maxOutputTokens: 500,
      thinking: { type: 'enabled' },
      reasoningEffort: 'max',
    })

    await gateway.generate({ ...request(), temperature: 0.4, maxOutputTokens: 1000 })

    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    const thinking = sent.thinking as Record<string, unknown>
    expect(sent.model).toBe('deepseek-v4-pro')
    expect(sent.max_tokens).toBe(1000)
    expect(sent.temperature).toBe(0.4)
    expect(sent.thinking).toEqual({ type: 'enabled' })
    expect(sent.reasoning_effort).toBe('max')
    expect('budget_tokens' in thinking).toBe(false)
    expect('effort' in thinking).toBe(false)
    expect('budget_tokens' in sent).toBe(false)
  })

  it('omits reasoning_effort unless explicitly configured', async () => {
    const { calls, fetchImpl } = recordFetch([jsonResponse(successBody)])
    const gateway = gatewayWith(fetchImpl, { thinking: { type: 'enabled' } })

    await gateway.generate(request())

    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(sent.thinking).toEqual({ type: 'enabled' })
    expect(sent.reasoning_effort).toBeUndefined()
  })

  it('keeps usage unknown when the response omits usage', async () => {
    const { id, model, choices } = successBody
    const { fetchImpl } = recordFetch([jsonResponse({ id, model, choices })])
    const gateway = gatewayWith(fetchImpl)

    const result = await gateway.generate(request())

    expect(result.usage).toBeUndefined()
  })
})

describe('DeepSeekModelGateway typed failures', () => {
  it('rejects a missing API key before any fetch', async () => {
    const calls: string[] = []
    const fetchImpl = (async () => {
      calls.push('called')
      return jsonResponse(successBody)
    }) as DeepSeekFetch
    const gateway = new DeepSeekModelGateway({
      model: 'deepseek-v4-flash',
      lookupEnv: () => undefined,
      fetch: fetchImpl,
    })

    await expect(gateway.generate(request())).rejects.toMatchObject({
      code: 'auth',
    })
    expect(calls).toHaveLength(0)
  })

  it('validates request maxOutputTokens and temperature before any fetch', async () => {
    const calls: string[] = []
    const fetchImpl = (async () => {
      calls.push('called')
      return jsonResponse(successBody)
    }) as DeepSeekFetch
    const gateway = gatewayWith(fetchImpl)

    for (const maxOutputTokens of [-1, 0, 1.5]) {
      await expect(
        gateway.generate({ ...request(), maxOutputTokens }),
      ).rejects.toMatchObject({ code: 'config' })
    }
    for (const temperature of [-0.1, 2.5, Number.NaN]) {
      await expect(
        gateway.generate({ ...request(), temperature }),
      ).rejects.toMatchObject({ code: 'config' })
    }
    expect(calls).toHaveLength(0)

    // Valid boundaries still reach the wire.
    await gateway.generate({ ...request(), maxOutputTokens: 1, temperature: 2 })
    expect(calls).toHaveLength(1)
  })

  it('covers delayed response bodies with the timeout, not just headers', async () => {
    let headersReceived = false
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      headersReceived = true
      return Promise.resolve({
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            )
          }),
      }) as unknown as Promise<Response>
    }) as DeepSeekFetch
    const gateway = gatewayWith(fetchImpl, { timeoutMs: 20 })

    const error = await gateway.generate(request()).catch((caught: unknown) => caught)
    expect(headersReceived).toBe(true)
    expect(error).toBeInstanceOf(DeepSeekError)
    expect((error as DeepSeekError).code).toBe('timeout')
  })

  it('maps network failures to a typed network error without leaking the cause', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed: ECONNREFUSED secret-host')
    }) as DeepSeekFetch
    const gateway = gatewayWith(fetchImpl)

    const error = await gateway.generate(request()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DeepSeekError)
    expect((error as DeepSeekError).code).toBe('network')
    expect((error as Error).message).not.toContain('secret-host')
  })

  it('maps 401 and 403 to auth errors without echoing the response body', async () => {
    const secretBody = '{"error":{"message":"super-secret-denial"}}'
    const { fetchImpl } = recordFetch([
      new Response(secretBody, { status: 401 }),
    ])
    const gateway = gatewayWith(fetchImpl)

    const error = await gateway.generate(request()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DeepSeekError)
    expect((error as DeepSeekError).code).toBe('auth')
    expect((error as DeepSeekError).status).toBe(401)
    expect((error as Error).message).not.toContain('super-secret-denial')
  })

  it('maps 429 to a rate-limit error', async () => {
    const { fetchImpl } = recordFetch([new Response('slow down', { status: 429 })])
    const gateway = gatewayWith(fetchImpl)

    await expect(gateway.generate(request())).rejects.toMatchObject({
      code: 'rate-limit',
      status: 429,
    })
  })

  it('maps 5xx to a server error', async () => {
    const { fetchImpl } = recordFetch([new Response('boom', { status: 503 })])
    const gateway = gatewayWith(fetchImpl)

    await expect(gateway.generate(request())).rejects.toMatchObject({
      code: 'server',
      status: 503,
    })
  })

  it('rejects malformed JSON responses', async () => {
    const fetchImpl = (async () =>
      new Response('this is not json', { status: 200 })) as DeepSeekFetch
    const gateway = gatewayWith(fetchImpl)

    await expect(gateway.generate(request())).rejects.toMatchObject({
      code: 'invalid-response',
    })
  })

  it('rejects responses without choices or a message object', async () => {
    const cases = [
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: null }] },
      { choices: [{ message: 'not-an-object' }] },
    ]
    for (const body of cases) {
      const { fetchImpl } = recordFetch([jsonResponse(body)])
      const gateway = gatewayWith(fetchImpl)
      await expect(gateway.generate(request())).rejects.toMatchObject({
        code: 'invalid-response',
      })
    }
  })

  it('rejects empty or non-string content as failure, never success', async () => {
    const cases = [
      { message: { content: null } },
      { message: { content: '' } },
      { message: { content: '   ' } },
      { message: { content: 42 } },
    ]
    for (const message of cases) {
      const body = {
        id: 'chatcmpl-empty',
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
      }
      const { fetchImpl } = recordFetch([jsonResponse(body)])
      const gateway = gatewayWith(fetchImpl)
      await expect(gateway.generate(request())).rejects.toMatchObject({
        code: 'empty-content',
      })
    }
  })

  it('accepts only finish_reason stop as a complete draft', async () => {
    const endings = [
      { finish_reason: 'length' },
      { finish_reason: 'content_filter' },
      {},
      { finish_reason: 'stop_' },
      { finish_reason: 7 },
    ]
    for (const ending of endings) {
      const body = {
        id: 'chatcmpl-other',
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, message: { content: '有正文但不完整' }, ...ending }],
      }
      const { fetchImpl } = recordFetch([jsonResponse(body)])
      const gateway = gatewayWith(fetchImpl)
      const error = await gateway.generate(request()).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(DeepSeekError)
      expect((error as DeepSeekError).code).toBe('truncated')
    }
  })

  it('preserves available usage/id/model/finish metadata on truncated failures', async () => {
    const body = {
      id: 'chatcmpl-truncated',
      model: 'deepseek-v4-pro',
      choices: [
        {
          index: 0,
          message: { content: '不完整的正文' },
          finish_reason: 'length',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_cache_hit_tokens: 2,
        prompt_cache_miss_tokens: 8,
      },
    }
    const { fetchImpl } = recordFetch([jsonResponse(body)])
    const gateway = gatewayWith(fetchImpl, { model: 'deepseek-v4-pro' })

    const error = await gateway.generate(request()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(DeepSeekError)
    const typed = error as DeepSeekError
    expect(typed.code).toBe('truncated')
    expect(typed.details).toEqual({
      model: 'deepseek-v4-pro',
      responseId: 'chatcmpl-truncated',
      finishReason: 'length',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheHitInputTokens: 2,
        cacheMissInputTokens: 8,
      },
    })
  })

  it('rejects non-finite, negative or fractional usage when supplied', async () => {
    const badUsageBodies = [
      { ...successBody, usage: { prompt_tokens: -1, completion_tokens: 1 } },
      { ...successBody, usage: { prompt_tokens: 1, completion_tokens: 1.5 } },
      {
        ...successBody,
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          completion_tokens_details: { reasoning_tokens: -3 },
        },
      },
    ]
    for (const body of badUsageBodies) {
      const { fetchImpl } = recordFetch([jsonResponse(body)])
      const gateway = gatewayWith(fetchImpl)
      await expect(gateway.generate(request())).rejects.toMatchObject({
        code: 'invalid-response',
      })
    }
  })
})

describe('DeepSeekModelGateway configuration guardrails', () => {
  it('rejects non-allowlisted models before any request', () => {
    expect(
      () =>
        new DeepSeekModelGateway({
          model: 'gpt-4' as 'deepseek-v4-flash',
          fetch: (async () => jsonResponse(successBody)) as DeepSeekFetch,
        }),
    ).toThrowError(/unsupported DeepSeek model/)
  })

  it('rejects non-HTTPS base URLs', () => {
    expect(
      () =>
        new DeepSeekModelGateway({
          model: 'deepseek-v4-flash',
          baseUrl: 'http://api.deepseek.com',
        }),
    ).toThrowError(/must use https/)
  })

  it('rejects base URLs on disallowed hosts', () => {
    expect(
      () =>
        new DeepSeekModelGateway({
          model: 'deepseek-v4-flash',
          baseUrl: 'https://evil.example.com',
        }),
    ).toThrowError(/host is not allowed/)
  })

  it('rejects userinfo, custom ports, query and fragments without echoing the raw URL', () => {
    const secretRaw = 'https://user:sekret@api.deepseek.com'
    const cases: Array<[string, RegExp]> = [
      [secretRaw, /userinfo/],
      ['https://api.deepseek.com:444', /custom port/],
      ['https://api.deepseek.com?token=sekret', /query or fragment/],
      ['https://api.deepseek.com/#sekret', /query or fragment/],
    ]
    for (const [baseUrl, pattern] of cases) {
      try {
        new DeepSeekModelGateway({ model: 'deepseek-v4-flash', baseUrl })
        expect.unreachable(`should have rejected ${baseUrl}`)
      } catch (error) {
        expect(error).toBeInstanceOf(DeepSeekError)
        expect((error as Error).message).toMatch(pattern)
        expect((error as Error).message).not.toContain('sekret')
      }
    }
  })

  it('rejects invalid thinking modes and reasoningEffort values', () => {
    expect(
      () =>
        new DeepSeekModelGateway({
          model: 'deepseek-v4-flash',
          thinking: { type: 'medium' as 'enabled' },
        }),
    ).toThrowError(/thinking.type/)
    expect(
      () =>
        new DeepSeekModelGateway({
          model: 'deepseek-v4-flash',
          thinking: { type: 'enabled' },
          reasoningEffort: 'turbo' as 'max',
        }),
    ).toThrowError(/reasoningEffort must be low, high or max/)
    expect(
      () =>
        new DeepSeekModelGateway({
          model: 'deepseek-v4-flash',
          thinking: { type: 'disabled' },
          reasoningEffort: 'high',
        }),
    ).toThrowError(/requires thinking.type enabled/)
  })

  it('accepts all three reasoning effort levels with enabled thinking', () => {
    for (const effort of ['low', 'high', 'max'] as const) {
      expect(
        () =>
          new DeepSeekModelGateway({
            model: 'deepseek-v4-flash',
            thinking: { type: 'enabled' },
            reasoningEffort: effort,
          }),
      ).not.toThrow()
    }
  })
})
