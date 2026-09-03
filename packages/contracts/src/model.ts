export interface GenerationRequest {
  requestId: string
  purpose: string
  system: string
  prompt: string
  temperature?: number
  maxOutputTokens?: number
  metadata: Record<string, string>
}

export interface GenerationUsage {
  inputTokens: number
  outputTokens: number
}

export interface GenerationResult {
  requestId: string
  provider: string
  model: string
  text: string
  usage: GenerationUsage
  rawResponse?: unknown
}

export interface ModelGateway {
  generate(request: GenerationRequest): Promise<GenerationResult>
}
