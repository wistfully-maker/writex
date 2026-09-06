export interface WorkstreamConfig {
  schemaVersion: 1
  workstreamId: string
  sessionId: string
  branch: string
  workspace: string
  profile: string
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface CompactionCapsule {
  schemaVersion: 1
  objective: string
  completed: string[]
  decisions: string[]
  currentState: {
    branch: string
    worktree: string
    lastCommit: string
    dirtyFiles: string[]
  }
  verification: string[]
  openIssues: string[]
  nextAction: string
}

export interface UsageSummary {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

export interface DriverCheckpoint {
  workstreamId: string
  sessionId: string
  status: 'idle'
  finalResponse: string
  eventCount: number
  notificationCount: number
  usage: UsageSummary
  compactionObserved: boolean
}

export interface WorkstreamRecord {
  schemaVersion: 1
  workstreamId: string
  sessionId: string
  model: string
  branch: string
  worktree: string
  status: 'opening' | 'idle' | 'busy' | 'blocked' | 'closed'
  createdAt: string
  updatedAt: string
  lastCheckpoint: string | null
  promptCount: number
  compactCount: number
  usage: UsageSummary
}

export interface PortRunResult {
  sessionId: string
  finalResponse: string
  events: unknown[]
  notifications: unknown[]
}

export interface DshSessionPort {
  run(message: string): Promise<PortRunResult>
}

export interface DshHarnessPort {
  session(sessionId: string): DshSessionPort
  close(): Promise<void>
}

export type DshHarnessFactory = (config: WorkstreamConfig) => DshHarnessPort

export interface DriverOpenOptions {
  config: unknown
  controllerRoot: string
  harnessFactory: DshHarnessFactory
  now?: () => string
  isPidAlive?: (pid: number) => boolean
}
