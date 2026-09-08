export const runStatuses = [
  'queued',
  'running',
  'needs-human-review',
  'succeeded',
  'failed',
  'cancelled',
] as const

export type RunStatus = (typeof runStatuses)[number]

export interface RunState {
  schemaVersion: 1
  runId: string
  command: string
  status: RunStatus
  createdAt: string
  updatedAt: string
  inputHash: string
}

export interface RunEvent {
  schemaVersion: 1
  eventId: string
  runId: string
  type: string
  occurredAt: string
  payload: Record<string, unknown>
}
