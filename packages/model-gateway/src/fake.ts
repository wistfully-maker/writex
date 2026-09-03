import type {
  GenerationRequest,
  GenerationResult,
  ModelGateway,
} from '@writex/contracts'

export class FakeModelGateway implements ModelGateway {
  readonly requests: GenerationRequest[] = []
  private readonly queue: string[]

  constructor(responses: string[]) {
    this.queue = [...responses]
  }

  async generate(request: GenerationRequest): Promise<GenerationResult> {
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
