import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { DshHarnessFactory, PortRunResult, WorkstreamConfig } from './contracts.js'

interface SdkRunResult {
  sessionId: string
  finalResponse: string
  events: unknown[]
  notifications: unknown[]
}

interface SdkSessionLike {
  run(message: string): Promise<SdkRunResult>
}

interface SdkHarnessLike {
  session(id: string): SdkSessionLike
  close(): Promise<void>
}

type SdkConstructor = new (options: Record<string, unknown>) => SdkHarnessLike

export function createOfficialDshHarnessFactory(
  Constructor: SdkConstructor = DeepSeekHarness as unknown as SdkConstructor,
): DshHarnessFactory {
  return (config: WorkstreamConfig) => {
    const sdk = new Constructor({
      initializeTimeoutMs: 60_000,
      profile: config.profile,
      cwd: config.workspace,
      processCwd: config.workspace,
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort
        ? { reasoningEffort: ReasoningEffortId(config.reasoningEffort) }
        : {}),
      ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
    })
    return {
      session(sessionId) {
        const session = sdk.session(sessionId)
        return {
          async run(message): Promise<PortRunResult> {
            const result = await session.run(message)
            return {
              sessionId: result.sessionId,
              finalResponse: result.finalResponse,
              events: result.events,
              notifications: result.notifications,
            }
          },
        }
      },
      close: () => sdk.close(),
    }
  }
}

export const createOfficialDshHarness = createOfficialDshHarnessFactory()
