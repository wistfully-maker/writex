import type {
  GenerationRequest,
  GenerationResult,
  GenerationUsage,
  ModelGateway,
} from '@writex/contracts'

/**
 * Synthetic usage reported by the fake. These are NOT token counts: they are
 * derived from string lengths so tests get deterministic numbers. Only tests
 * that assert request wiring or budget accounting may rely on them; real
 * tokenizers report real usage through the adapters.
 */
export interface FakeUsage extends GenerationUsage {
  inputTokens: number
  outputTokens: number
}

export interface FakeGenerationResult extends GenerationResult {
  usage: FakeUsage
}

export class FakeModelGateway implements ModelGateway {
  readonly requests: GenerationRequest[] = []
  private readonly queue: string[]

  constructor(responses: string[]) {
    this.queue = [...responses]
  }

  async generate(request: GenerationRequest): Promise<FakeGenerationResult> {
    this.requests.push(structuredClone(request))
    const text = this.queue.shift()
    if (text === undefined) {
      throw new Error(
        `fake model has no queued response for ${request.requestId}`,
      )
    }
    return {
      requestId: request.requestId,
      provider: 'fake',
      model: 'fake-v1',
      text,
      usage: {
        inputTokens: request.system.length + request.prompt.length,
        outputTokens: text.length,
      },
    }
  }
}
