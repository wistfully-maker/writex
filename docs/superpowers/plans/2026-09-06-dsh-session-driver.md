# Persistent DSH Session Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript driver that keeps one DeepSeek Harness runtime and one named session alive across related implementation prompts, records non-sensitive workstream state, prevents concurrent writers, observes automatic compaction, and exposes a JSONL control loop for Codex.

**Architecture:** Wrap the official `@deepseek-ai/dsh-sdk-client@0.1.2-rc.1` high-level API behind small injectable ports so all normal tests use a deterministic fake runtime. One long-lived driver instance owns the SDK subprocess, named session, workspace lock, registry, usage summary, and compaction capsule; a JSONL stdin/stdout controller lets Codex keep that process alive through multiple messages.

**Tech Stack:** Node.js, TypeScript, ESM, pnpm workspaces, Vitest, `@deepseek-ai/dsh-sdk-client@0.1.2-rc.1`

---

## Scope

This plan implements one vertical slice only:

- persistent named DSH session reuse;
- one-writer-per-workspace locking;
- non-sensitive workstream registry;
- sequential prompt execution through one SDK subprocess;
- idle checkpoint results and usage/compaction summaries;
- durable compaction capsules;
- JSONL control loop for a long-running Codex terminal session;
- deterministic acceptance with two minimal related operations and one review correction;
- one explicit, paid live probe script for `deepseek-v4-flash`.

The plan does not implement literary generation, OpenAI integration, model ranking, manual compaction RPC, PR automation, or a general daemon service.

## Official SDK constraints

- Pin `@deepseek-ai/dsh-sdk-client` to `0.1.2-rc.1`; that release depends on the matching `@deepseek-ai/dsh` runtime.
- `DeepSeekHarness` owns one subprocess across multiple `HarnessSession.run()` calls.
- `harness.session(sessionId)` reuses the named live session while the driver process remains alive.
- Each `run()` owns one enqueue-receipt-to-idle interval and returns `finalResponse`, events, and notifications.
- The wire has no manual compact method. The driver observes automatic `compaction/*` events and never sends `/compact` as a model prompt.
- The wire has no mid-turn cancellation. A stuck turn is terminated by closing the owned runtime.

## Target file map

```text
.gitignore
package.json
packages/dsh-session-driver/package.json
packages/dsh-session-driver/src/contracts.ts
packages/dsh-session-driver/src/validation.ts
packages/dsh-session-driver/src/registry.ts
packages/dsh-session-driver/src/workspace-lock.ts
packages/dsh-session-driver/src/event-summary.ts
packages/dsh-session-driver/src/driver.ts
packages/dsh-session-driver/src/sdk-adapter.ts
packages/dsh-session-driver/src/jsonl-controller.ts
packages/dsh-session-driver/src/bin.ts
packages/dsh-session-driver/src/index.ts
packages/dsh-session-driver/test/validation.test.ts
packages/dsh-session-driver/test/registry.test.ts
packages/dsh-session-driver/test/workspace-lock.test.ts
packages/dsh-session-driver/test/event-summary.test.ts
packages/dsh-session-driver/test/driver.test.ts
packages/dsh-session-driver/test/jsonl-controller.test.ts
tests/live/dsh-session-probe.ts
README.md
```

### Task 1: Package and driver contracts

**Files:**
- Modify: `.gitignore`
- Create: `packages/dsh-session-driver/package.json`
- Create: `packages/dsh-session-driver/src/contracts.ts`
- Create: `packages/dsh-session-driver/src/validation.ts`
- Create: `packages/dsh-session-driver/src/index.ts`
- Test: `packages/dsh-session-driver/test/validation.test.ts`

- [ ] **Step 1: Write validation tests**

Create `packages/dsh-session-driver/test/validation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { validateWorkstreamConfig } from '../src/index.js'

const valid = {
  schemaVersion: 1 as const,
  workstreamId: 'model-evaluation-v1',
  sessionId: 'session-model-evaluation-v1',
  branch: 'feature/model-evaluation-v1',
  workspace: 'D:/program/writex/.worktrees/model-evaluation-v1',
  profile: 'sdk',
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  maxTokens: 8192,
}

describe('validateWorkstreamConfig', () => {
  it('accepts the complete configuration', () => {
    expect(validateWorkstreamConfig(valid)).toEqual(valid)
  })

  it.each(['../escape', 'CON', 'run.', ''])('rejects unsafe workstream ids: %s', (workstreamId) => {
    expect(() => validateWorkstreamConfig({ ...valid, workstreamId })).toThrow(/workstreamId/)
  })

  it('requires an absolute workspace path', () => {
    expect(() => validateWorkstreamConfig({ ...valid, workspace: './relative' })).toThrow(/workspace/)
  })

  it('rejects secret-bearing extra fields', () => {
    expect(() => validateWorkstreamConfig({ ...valid, apiKey: 'secret' } as never)).toThrow(/unknown field/)
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
pnpm test -- packages/dsh-session-driver/test/validation.test.ts
```

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Add package metadata**

Create `packages/dsh-session-driver/package.json`:

```json
{
  "name": "@writex/dsh-session-driver",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@deepseek-ai/dsh-llm": "0.1.2-rc.1",
    "@deepseek-ai/dsh-sdk-client": "0.1.2-rc.1",
    "@writex/workspace": "workspace:*"
  }
}
```

Run:

```powershell
pnpm install --frozen-lockfile=false
```

Expected: the exact SDK release and matching DSH runtime are recorded in `pnpm-lock.yaml`.

- [ ] **Step 4: Define the public contracts**

Create `packages/dsh-session-driver/src/contracts.ts`:

```ts
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
```

- [ ] **Step 5: Implement strict validation**

Create `packages/dsh-session-driver/src/validation.ts`:

```ts
import { isAbsolute, resolve } from 'node:path'
import type { CompactionCapsule, WorkstreamConfig } from './contracts.js'

const allowedFields = new Set([
  'schemaVersion', 'workstreamId', 'sessionId', 'branch', 'workspace', 'profile',
  'provider', 'model', 'reasoningEffort', 'maxTokens',
])
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i

function assertId(name: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || !safeId.test(value) || /[. ]$/.test(value) || reserved.test(value)) {
    throw new Error(`invalid ${name}`)
  }
}

export function validateWorkstreamConfig(input: unknown): WorkstreamConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid workstream config')
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) if (!allowedFields.has(key)) throw new Error(`unknown field: ${key}`)
  if (record.schemaVersion !== 1) throw new Error('invalid schemaVersion')
  assertId('workstreamId', record.workstreamId)
  assertId('sessionId', record.sessionId)
  if (typeof record.branch !== 'string' || record.branch.trim() === '') throw new Error('branch is required')
  if (typeof record.workspace !== 'string' || !isAbsolute(record.workspace)) throw new Error('workspace must be absolute')
  for (const key of ['profile', 'provider', 'model'] as const) {
    if (typeof record[key] !== 'string' || record[key].trim() === '') throw new Error(`${key} is required`)
  }
  if (record.reasoningEffort !== undefined && (typeof record.reasoningEffort !== 'string' || record.reasoningEffort === '')) {
    throw new Error('invalid reasoningEffort')
  }
  if (record.maxTokens !== undefined && (!Number.isSafeInteger(record.maxTokens) || Number(record.maxTokens) <= 0)) {
    throw new Error('invalid maxTokens')
  }
  return { ...record, workspace: resolve(record.workspace) } as unknown as WorkstreamConfig
}

export function validateCompactionCapsule(input: unknown): CompactionCapsule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid capsule')
  const record = input as Record<string, unknown>
  const keys = ['schemaVersion', 'objective', 'completed', 'decisions', 'currentState', 'verification', 'openIssues', 'nextAction']
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error('unknown capsule field')
  if (record.schemaVersion !== 1) throw new Error('invalid capsule schemaVersion')
  for (const key of ['objective', 'nextAction'] as const) {
    if (typeof record[key] !== 'string' || record[key].trim() === '') throw new Error(`invalid capsule ${key}`)
  }
  for (const key of ['completed', 'decisions', 'verification', 'openIssues'] as const) {
    if (!Array.isArray(record[key]) || record[key].some((value) => typeof value !== 'string')) {
      throw new Error(`invalid capsule ${key}`)
    }
  }
  if (!record.currentState || typeof record.currentState !== 'object' || Array.isArray(record.currentState)) {
    throw new Error('invalid capsule currentState')
  }
  const state = record.currentState as Record<string, unknown>
  const stateKeys = ['branch', 'worktree', 'lastCommit', 'dirtyFiles']
  if (Object.keys(state).some((key) => !stateKeys.includes(key))) throw new Error('unknown capsule state field')
  if (typeof state.branch !== 'string' || typeof state.worktree !== 'string' || !isAbsolute(state.worktree) || typeof state.lastCommit !== 'string') {
    throw new Error('invalid capsule currentState')
  }
  if (!Array.isArray(state.dirtyFiles) || state.dirtyFiles.some((value) => typeof value !== 'string')) {
    throw new Error('invalid capsule dirtyFiles')
  }
  return structuredClone(input) as CompactionCapsule
}
```

Create `packages/dsh-session-driver/src/index.ts`:

```ts
export * from './contracts.js'
export * from './validation.js'
```

Append to `.gitignore`:

```gitignore
.writex/dev/
```

- [ ] **Step 6: Verify and commit**

Run:

```powershell
pnpm test -- packages/dsh-session-driver/test/validation.test.ts
pnpm typecheck
```

Expected: four tests PASS and typecheck succeeds.

Commit:

```powershell
git add .gitignore packages/dsh-session-driver pnpm-lock.yaml
git commit -m "feat: define persistent DSH driver contracts"
```

### Task 2: Workstream registry and workspace lock

**Files:**
- Create: `packages/dsh-session-driver/src/registry.ts`
- Create: `packages/dsh-session-driver/src/workspace-lock.ts`
- Modify: `packages/dsh-session-driver/src/index.ts`
- Test: `packages/dsh-session-driver/test/registry.test.ts`
- Test: `packages/dsh-session-driver/test/workspace-lock.test.ts`

- [ ] **Step 1: Write failing registry and lock tests**

Create tests that verify:

```ts
it('persists a registry record without prompts or credentials')
it('updates status, prompt count, usage, and compaction count atomically')
it('allows one workspace writer and rejects a second live writer')
it('reclaims a lock whose owner pid is no longer alive')
it('releases only the lock token owned by this driver')
```

Use `mkdtemp`, an injected clock, injected `isPidAlive`, and safe `afterEach` cleanup. Assert registry JSON contains no keys matching `/key|token|prompt|message/i` except the numeric `promptCount` field.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm test -- packages/dsh-session-driver/test/registry.test.ts packages/dsh-session-driver/test/workspace-lock.test.ts
```

Expected: FAIL because registry and lock exports do not exist.

- [ ] **Step 3: Implement the registry**

`WorkstreamRegistry` owns `<controllerRoot>/.writex/dev/workstreams/<workstreamId>.json`. Its constructor receives `controllerRoot` and an optional ISO clock. Implement:

```ts
create(record: WorkstreamRecord): Promise<void>
read(workstreamId: string): Promise<WorkstreamRecord>
update(workstreamId: string, mutate: (current: WorkstreamRecord) => WorkstreamRecord): Promise<WorkstreamRecord>
saveCapsule(workstreamId: string, capsule: CompactionCapsule): Promise<string>
```

Use `atomicWriteFile`, pretty JSON, final newlines, strict safe IDs, and create-only semantics for the initial record. Capsules go to `.writex/dev/capsules/<workstreamId>.json` and contain no model response or hidden reasoning.

For create-only semantics, create the parent directory and open the record with `open(path, 'wx')`; do not implement a read-then-write existence check. `update()` uses `atomicWriteFile` only after a successful validated read.

Create `packages/dsh-session-driver/src/registry.ts`:

```ts
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { atomicWriteFile } from '@writex/workspace'
import type { CompactionCapsule, WorkstreamRecord } from './contracts.js'

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function recordText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function assertSafeId(value: string): void {
  if (!safeId.test(value) || /[. ]$/.test(value)) throw new Error('invalid workstreamId')
}

export class WorkstreamRegistry {
  constructor(
    private readonly root: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    if (!isAbsolute(root)) throw new Error('controllerRoot must be absolute')
  }

  private recordPath(id: string): string {
    assertSafeId(id)
    return join(this.root, '.writex', 'dev', 'workstreams', `${id}.json`)
  }

  async create(record: WorkstreamRecord): Promise<void> {
    const path = this.recordPath(record.workstreamId)
    await mkdir(dirname(path), { recursive: true })
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(recordText(record), 'utf8')
    } finally {
      await handle.close()
    }
  }

  async read(id: string): Promise<WorkstreamRecord> {
    return JSON.parse(await readFile(this.recordPath(id), 'utf8')) as WorkstreamRecord
  }

  async update(
    id: string,
    mutate: (current: WorkstreamRecord) => WorkstreamRecord,
  ): Promise<WorkstreamRecord> {
    const current = await this.read(id)
    const next = { ...mutate(structuredClone(current)), updatedAt: this.now() }
    if (next.workstreamId !== id) throw new Error('workstreamId is immutable')
    await atomicWriteFile(this.recordPath(id), recordText(next))
    return next
  }

  async saveCapsule(id: string, capsule: CompactionCapsule): Promise<string> {
    assertSafeId(id)
    const path = join(this.root, '.writex', 'dev', 'capsules', `${id}.json`)
    await atomicWriteFile(path, recordText(capsule))
    return path
  }
}
```

- [ ] **Step 4: Implement the lock**

`WorkspaceLock.acquire(workspace, workstreamId, isPidAlive?)` creates `<workspace>/.writex/dev/driver.lock` using `open(path, 'wx')`. The JSON contains schema version, pid, random ownership token, workstream ID, and timestamp.

If the file exists:

- a live PID produces `workspace already has an active DSH writer`;
- a dead PID permits removal of that exact lock file and one retry;
- malformed lock JSON fails closed and is not removed.

`release()` rereads the file and removes it only when its ownership token matches. It is idempotent when the file is already absent.

Create `packages/dsh-session-driver/src/workspace-lock.ts`:

```ts
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'

interface LockRecord {
  schemaVersion: 1
  pid: number
  token: string
  workstreamId: string
  createdAt: string
}

export type IsPidAlive = (pid: number) => boolean

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class WorkspaceLock {
  private released = false

  private constructor(
    private readonly path: string,
    private readonly token: string,
  ) {}

  static async acquire(
    workspace: string,
    workstreamId: string,
    isPidAlive: IsPidAlive = defaultIsPidAlive,
  ): Promise<WorkspaceLock> {
    if (!isAbsolute(workspace)) throw new Error('workspace must be absolute')
    const path = join(workspace, '.writex', 'dev', 'driver.lock')
    await mkdir(dirname(path), { recursive: true })
    const token = randomUUID()
    const value: LockRecord = {
      schemaVersion: 1,
      pid: process.pid,
      token,
      workstreamId,
      createdAt: new Date().toISOString(),
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, 'wx')
        try {
          await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
        } finally {
          await handle.close()
        }
        return new WorkspaceLock(path, token)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let existing: LockRecord
        try {
          existing = JSON.parse(await readFile(path, 'utf8')) as LockRecord
        } catch {
          throw new Error('workspace lock is malformed')
        }
        if (!Number.isSafeInteger(existing.pid) || typeof existing.token !== 'string') {
          throw new Error('workspace lock is malformed')
        }
        if (isPidAlive(existing.pid)) throw new Error('workspace already has an active DSH writer')
        await rm(path)
      }
    }
    throw new Error('could not acquire workspace lock')
  }

  async release(): Promise<void> {
    if (this.released) return
    try {
      const current = JSON.parse(await readFile(this.path, 'utf8')) as LockRecord
      if (current.token !== this.token) throw new Error('workspace lock ownership changed')
      await rm(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    this.released = true
  }
}
```

- [ ] **Step 5: Verify and commit**

Run:

```powershell
pnpm test -- packages/dsh-session-driver/test/registry.test.ts packages/dsh-session-driver/test/workspace-lock.test.ts
pnpm typecheck
pnpm test
```

Expected: new tests and all existing tests PASS.

Commit:

```powershell
git add packages/dsh-session-driver
git commit -m "feat: add DSH workstream registry and lock"
```

### Task 3: Event summaries and persistent driver

**Files:**
- Create: `packages/dsh-session-driver/src/event-summary.ts`
- Create: `packages/dsh-session-driver/src/driver.ts`
- Modify: `packages/dsh-session-driver/src/index.ts`
- Test: `packages/dsh-session-driver/test/event-summary.test.ts`
- Test: `packages/dsh-session-driver/test/driver.test.ts`

- [ ] **Step 1: Write failing summary tests**

Use synthetic, non-reasoning events:

```ts
const events = [
  { type: 'assistant/message', data: { usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 10, reasoningTokens: 12 } } },
  { type: 'compaction/start', data: {} },
  { type: 'compaction/end', data: {} },
]
```

Assert `summarizeEvents(events)` returns usage `120/30/80/10/12`, `compactionObserved: true`, and `compactCount: 1`. Unknown shapes contribute zero and never throw. `reasoningTokens` is informational and is not added to `outputTokens`.

- [ ] **Step 2: Write failing driver tests**

Create a fake harness whose `session(id)` records the ID and whose session stores every message. Test:

- `open()` creates one harness, one named session, one lock, and an `idle` registry record;
- three sequential `send()` calls reuse exactly the same session object;
- registry `promptCount` becomes three and usage totals accumulate;
- an automatic `compaction/end` event increments `compactCount`;
- a failed run sets registry status `blocked` and preserves the error;
- concurrent `send()` rejects `driver is busy`;
- `close()` closes the harness once, marks the registry closed, and releases the lock.

- [ ] **Step 3: Implement event summarization**

Create `summarizeEvents(events: unknown[])` using type guards only. Never retain event content. Sum finite non-negative numeric usage fields from committed `assistant/message` events and count `compaction/end`. Return:

```ts
{ usage: { inputTokens, outputTokens, cacheReadTokens }, compactionObserved, compactCount }
```

Create `packages/dsh-session-driver/src/event-summary.ts`:

```ts
import type { UsageSummary } from './contracts.js'

export interface EventSummary {
  usage: UsageSummary
  compactionObserved: boolean
  compactCount: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function token(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

export function summarizeEvents(events: unknown[]): EventSummary {
  const usage: UsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let compactCount = 0
  for (const event of events) {
    const envelope = record(event)
    if (!envelope) continue
    if (envelope.type === 'compaction/end') compactCount += 1
    if (envelope.type !== 'assistant/message') continue
    const data = record(envelope.data)
    const eventUsage = record(data?.usage)
    if (!eventUsage) continue
    usage.inputTokens += token(eventUsage.inputTokens)
    usage.outputTokens += token(eventUsage.outputTokens)
    usage.cacheReadTokens += token(eventUsage.cacheReadTokens)
    usage.cacheWriteTokens += token(eventUsage.cacheWriteTokens)
    usage.reasoningTokens += token(eventUsage.reasoningTokens)
  }
  return { usage, compactionObserved: compactCount > 0, compactCount }
}
```

- [ ] **Step 4: Implement the driver**

`PersistentDshSessionDriver.open(options: DriverOpenOptions)` validates `options.config`, requires an absolute `controllerRoot`, acquires the workspace lock, creates the registry record using `config.branch`, creates one harness through `options.harnessFactory`, opens one session handle, and changes status to idle. On partial failure it closes acquired resources and releases the lock.

`send(message)`:

1. rejects blank messages, closed drivers, and concurrent calls;
2. sets status busy;
3. calls the existing session handle exactly once;
4. summarizes events without storing raw prompts, events, or reasoning;
5. accumulates usage and prompt/compact counts;
6. sets status idle and returns `DriverCheckpoint`;
7. on failure sets status blocked and rethrows the original error;
8. clears the in-memory busy flag in `finally`.

`saveCompactionCapsule(capsule)` writes through the registry and records its path as the last checkpoint. `close()` is idempotent, closes the harness, marks the registry closed, and releases the lock even if runtime shutdown fails; dual failure becomes `AggregateError`.

Create `packages/dsh-session-driver/src/driver.ts`:

```ts
import { isAbsolute } from 'node:path'
import type {
  CompactionCapsule,
  DriverCheckpoint,
  DriverOpenOptions,
  DshHarnessPort,
  DshSessionPort,
  UsageSummary,
  WorkstreamConfig,
  WorkstreamRecord,
} from './contracts.js'
import { summarizeEvents } from './event-summary.js'
import { WorkstreamRegistry } from './registry.js'
import { validateCompactionCapsule, validateWorkstreamConfig } from './validation.js'
import { WorkspaceLock } from './workspace-lock.js'

const zeroUsage = (): UsageSummary => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
})

export class PersistentDshSessionDriver {
  private busy = false
  private closed = false

  private constructor(
    private readonly config: WorkstreamConfig,
    private readonly registry: WorkstreamRegistry,
    private readonly lock: WorkspaceLock,
    private readonly harness: DshHarnessPort,
    private readonly session: DshSessionPort,
  ) {}

  static async open(options: DriverOpenOptions): Promise<PersistentDshSessionDriver> {
    const config = validateWorkstreamConfig(options.config)
    if (!isAbsolute(options.controllerRoot)) throw new Error('controllerRoot must be absolute')
    const registry = new WorkstreamRegistry(options.controllerRoot, options.now)
    const lock = await WorkspaceLock.acquire(config.workspace, config.workstreamId, options.isPidAlive)
    let harness: DshHarnessPort | undefined
    try {
      const createdAt = (options.now ?? (() => new Date().toISOString()))()
      const record: WorkstreamRecord = {
        schemaVersion: 1,
        workstreamId: config.workstreamId,
        sessionId: config.sessionId,
        model: config.model,
        branch: config.branch,
        worktree: config.workspace,
        status: 'opening',
        createdAt,
        updatedAt: createdAt,
        lastCheckpoint: null,
        promptCount: 0,
        compactCount: 0,
        usage: zeroUsage(),
      }
      await registry.create(record)
      harness = options.harnessFactory(config)
      const session = harness.session(config.sessionId)
      await registry.update(config.workstreamId, (current) => ({ ...current, status: 'idle' }))
      return new PersistentDshSessionDriver(config, registry, lock, harness, session)
    } catch (error) {
      const failures: unknown[] = [error]
      if (harness) try { await harness.close() } catch (closeError) { failures.push(closeError) }
      try { await lock.release() } catch (lockError) { failures.push(lockError) }
      if (failures.length > 1) throw new AggregateError(failures, 'driver open and cleanup failed')
      throw error
    }
  }

  async send(message: string): Promise<DriverCheckpoint> {
    if (this.closed) throw new Error('driver is closed')
    if (this.busy) throw new Error('driver is busy')
    if (message.trim() === '') throw new Error('message must not be blank')
    this.busy = true
    await this.registry.update(this.config.workstreamId, (current) => ({ ...current, status: 'busy' }))
    try {
      const result = await this.session.run(message)
      const summary = summarizeEvents(result.events)
      const updated = await this.registry.update(this.config.workstreamId, (current) => ({
        ...current,
        status: 'idle',
        promptCount: current.promptCount + 1,
        compactCount: current.compactCount + summary.compactCount,
        usage: {
          inputTokens: current.usage.inputTokens + summary.usage.inputTokens,
          outputTokens: current.usage.outputTokens + summary.usage.outputTokens,
          cacheReadTokens: current.usage.cacheReadTokens + summary.usage.cacheReadTokens,
          cacheWriteTokens: current.usage.cacheWriteTokens + summary.usage.cacheWriteTokens,
          reasoningTokens: current.usage.reasoningTokens + summary.usage.reasoningTokens,
        },
      }))
      return {
        workstreamId: this.config.workstreamId,
        sessionId: result.sessionId,
        status: 'idle',
        finalResponse: result.finalResponse,
        eventCount: result.events.length,
        notificationCount: result.notifications.length,
        usage: updated.usage,
        compactionObserved: summary.compactionObserved,
      }
    } catch (error) {
      await this.registry.update(this.config.workstreamId, (current) => ({ ...current, status: 'blocked' }))
      throw error
    } finally {
      this.busy = false
    }
  }

  async saveCompactionCapsule(capsule: CompactionCapsule): Promise<string> {
    if (this.closed) throw new Error('driver is closed')
    const validated = validateCompactionCapsule(capsule)
    const path = await this.registry.saveCapsule(this.config.workstreamId, validated)
    await this.registry.update(this.config.workstreamId, (current) => ({ ...current, lastCheckpoint: path }))
    return path
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const failures: unknown[] = []
    try { await this.harness.close() } catch (error) { failures.push(error) }
    try {
      await this.registry.update(this.config.workstreamId, (current) => ({ ...current, status: 'closed' }))
    } catch (error) { failures.push(error) }
    try { await this.lock.release() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'driver close failed')
  }
}
```

- [ ] **Step 5: Verify and commit**

Run:

```powershell
pnpm test -- packages/dsh-session-driver/test/event-summary.test.ts packages/dsh-session-driver/test/driver.test.ts
pnpm typecheck
pnpm test
```

Expected: all tests PASS.

Commit:

```powershell
git add packages/dsh-session-driver
git commit -m "feat: add persistent DSH session lifecycle"
```

### Task 4: Official DeepSeek Harness SDK adapter

**Files:**
- Create: `packages/dsh-session-driver/src/sdk-adapter.ts`
- Modify: `packages/dsh-session-driver/src/index.ts`
- Test: `packages/dsh-session-driver/test/sdk-adapter.test.ts`

- [ ] **Step 1: Write a construction test with an injected SDK constructor**

Use an exported `createOfficialDshHarnessFactory(SdkConstructor)` builder so the test can inject a fake SDK constructor without module mocking. The test constructor records options and returns a fake SDK object. Assert the adapter passes:

```ts
{
  profile: 'sdk',
  cwd: absoluteWorkspace,
  processCwd: absoluteWorkspace,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  reasoningEffort: ReasoningEffortId('high'),
  maxTokens: 8192,
}
```

Assert `session(id).run(message)` returns only `sessionId`, `finalResponse`, `events`, and `notifications`, and `close()` delegates once.

- [ ] **Step 2: Implement the adapter**

Use:

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
```

Export `createOfficialDshHarnessFactory(SdkConstructor)` and `createOfficialDshHarness` as the default `DshHarnessFactory`. Do not pass an `env` object, so the child uses the established DSH credential policy. Never read credential files or copy API keys into registry records.

Create `packages/dsh-session-driver/src/sdk-adapter.ts`:

```ts
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
```

- [ ] **Step 3: Verify and commit**

Run the adapter test, typecheck, and full suite. Expected: PASS without starting a real SDK process or making a model call.

Commit:

```powershell
git add packages/dsh-session-driver pnpm-lock.yaml
git commit -m "feat: connect persistent driver to official DSH SDK"
```

### Task 5: JSONL control loop

**Files:**
- Create: `packages/dsh-session-driver/src/jsonl-controller.ts`
- Create: `packages/dsh-session-driver/src/bin.ts`
- Modify: `packages/dsh-session-driver/src/index.ts`
- Modify: `package.json`
- Test: `packages/dsh-session-driver/test/jsonl-controller.test.ts`

- [ ] **Step 1: Write controller tests**

Drive `JsonlController.handle()` directly with:

```json
{"id":"1","type":"open","controllerRoot":"D:/program/writex","config":{}}
{"id":"2","type":"send","message":"first operation"}
{"id":"3","type":"capsule","capsule":{}}
{"id":"4","type":"close"}
```

Tests must prove ordered responses, one open driver, same session across sends, sanitized errors without stack traces, rejection of unknown commands/fields, and no prompt text in registry output.

- [ ] **Step 2: Implement the controller**

Use a discriminated command union with exact-field validation. Responses are one compact JSON object per line:

```ts
type JsonlResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } }
```

`startJsonlLoop(input, output, controller)` uses `readline.createInterface`, serializes command handling through a promise chain, writes only JSONL to stdout, and sends diagnostics to stderr. A `close` command closes resources and ends the loop.

Create `packages/dsh-session-driver/src/jsonl-controller.ts`:

```ts
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { CompactionCapsule, DriverCheckpoint, DriverOpenOptions } from './contracts.js'
import { PersistentDshSessionDriver } from './driver.js'

interface DriverLike {
  send(message: string): Promise<DriverCheckpoint>
  saveCompactionCapsule(capsule: CompactionCapsule): Promise<string>
  close(): Promise<void>
}

export type OpenDriver = (options: DriverOpenOptions) => Promise<DriverLike>

type Response =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: { code: string; message: string } }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('command must be an object')
  return value as Record<string, unknown>
}

function exact(record: Record<string, unknown>, fields: string[]): void {
  const allowed = new Set(fields)
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`unknown command field: ${key}`)
}

export class JsonlController {
  private driver: DriverLike | undefined

  constructor(
    private readonly openDriver: OpenDriver,
    private readonly harnessFactory: DriverOpenOptions['harnessFactory'],
  ) {}

  async handle(input: unknown): Promise<Response> {
    let id = 'unknown'
    try {
      const command = object(input)
      if (typeof command.id !== 'string' || command.id === '') throw new Error('command id is required')
      id = command.id
      if (command.type === 'open') {
        exact(command, ['id', 'type', 'controllerRoot', 'config'])
        if (this.driver) throw new Error('driver is already open')
        if (typeof command.controllerRoot !== 'string') throw new Error('controllerRoot is required')
        this.driver = await this.openDriver({
          config: command.config,
          controllerRoot: command.controllerRoot,
          harnessFactory: this.harnessFactory,
        })
        return { id, ok: true, result: { status: 'idle' } }
      }
      if (!this.driver) throw new Error('driver is not open')
      if (command.type === 'send') {
        exact(command, ['id', 'type', 'message'])
        if (typeof command.message !== 'string') throw new Error('message is required')
        return { id, ok: true, result: await this.driver.send(command.message) }
      }
      if (command.type === 'capsule') {
        exact(command, ['id', 'type', 'capsule'])
        return {
          id,
          ok: true,
          result: { path: await this.driver.saveCompactionCapsule(command.capsule as CompactionCapsule) },
        }
      }
      if (command.type === 'close') {
        exact(command, ['id', 'type'])
        await this.driver.close()
        this.driver = undefined
        return { id, ok: true, result: { status: 'closed' } }
      }
      throw new Error('unknown command type')
    } catch (error) {
      return {
        id,
        ok: false,
        error: { code: 'DSH_DRIVER_ERROR', message: error instanceof Error ? error.message : 'unknown error' },
      }
    }
  }
}

export async function startJsonlLoop(
  input: Readable,
  output: Writable,
  controller: JsonlController,
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  let chain = Promise.resolve()
  for await (const line of lines) {
    if (line.trim() === '') continue
    chain = chain.then(async () => {
      let command: unknown
      try {
        command = JSON.parse(line)
      } catch {
        output.write(`${JSON.stringify({ id: 'unknown', ok: false, error: { code: 'INVALID_JSON', message: 'invalid JSON' } })}\n`)
        return
      }
      output.write(`${JSON.stringify(await controller.handle(command))}\n`)
    })
    await chain
  }
}
```

Create `packages/dsh-session-driver/src/bin.ts`:

```ts
#!/usr/bin/env node
import { JsonlController, startJsonlLoop } from './jsonl-controller.js'
import { PersistentDshSessionDriver } from './driver.js'
import { createOfficialDshHarness } from './sdk-adapter.js'

const controller = new JsonlController(
  (options) => PersistentDshSessionDriver.open(options),
  createOfficialDshHarness,
)

await startJsonlLoop(process.stdin, process.stdout, controller)
```

Create `src/bin.ts` that starts the controller with `createOfficialDshHarness`. Add root script:

```json
"dsh:driver": "tsx packages/dsh-session-driver/src/bin.ts"
```

- [ ] **Step 3: Verify and commit**

Run controller tests, typecheck, and full tests. Then pipe a fake/validation-only invalid command to the binary and assert one JSON error line with a nonzero command result only if startup itself fails.

Commit:

```powershell
git add package.json packages/dsh-session-driver
git commit -m "feat: add persistent DSH JSONL controller"
```

### Task 6: Minimal persistent-session acceptance

**Files:**
- Create: `packages/dsh-session-driver/test/persistent-session.acceptance.test.ts`

- [ ] **Step 1: Implement the deterministic acceptance**

Use one stateful fake session and three messages:

1. `Remember marker ORCHID-17 and create the probe state.`
2. `Use the marker from the previous operation and append :continued.`
3. `Review correction: replace :continued with :reviewed.`

The fake must reject message 2 if it did not receive message 1 on the same session object. Assert:

- one harness instance;
- one session ID and one session object;
- three sequential prompts;
- final state `ORCHID-17:reviewed`;
- registry prompt count three;
- no repeated full context in messages 2 and 3;
- a synthetic `compaction/end` on message 2 is recorded;
- after saving a capsule, message 3 still succeeds on the same session;
- close releases the lock.

- [ ] **Step 2: Run the complete deterministic suite**

Run:

```powershell
pnpm typecheck
pnpm test
git diff --check
```

Expected: all tests PASS and no diff errors.

- [ ] **Step 3: Commit**

```powershell
git add packages/dsh-session-driver/test/persistent-session.acceptance.test.ts
git commit -m "test: verify persistent DSH session reuse"
```

### Task 7: Credential-gated live probe and documentation

**Files:**
- Create: `tests/live/dsh-session-probe.ts`
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Add the live probe**

The script must exit without a model call unless passed `--live`. With `--live`, it:

1. creates one exact temporary workspace below the system temp directory;
2. opens one driver using `deepseek-official`, `deepseek-v4-flash`, `sdk`, high effort, and `maxTokens: 2048`;
3. sends a first prompt asking the agent to write a random marker to `session-probe.txt`;
4. sends a second prompt, without repeating the marker, asking it to append `:continued`;
5. sends one review correction asking it to replace that suffix with `:reviewed`;
6. verifies the file equals `<marker>:reviewed`;
7. verifies all checkpoints report the same `sessionId`;
8. writes a compaction capsule without prompt or key material;
9. closes the driver;
10. verifies and removes only the exact temporary workspace.

Add root script:

```json
"test:dsh-live": "tsx tests/live/dsh-session-probe.ts"
```

The live command is:

```powershell
pnpm test:dsh-live -- --live
```

- [ ] **Step 2: Document operation**

Add a README section showing how Codex starts one long-lived JSONL process, sends `open`, multiple `send` commands, one `capsule`, and `close`. State that the process must remain alive for session reuse, model calls cost money, raw prompts are not stored in the registry, automatic compaction is observed rather than manually faked, and Git remains controller-owned.

- [ ] **Step 3: Verify without model cost**

Run:

```powershell
pnpm test:dsh-live
pnpm typecheck
pnpm test
git diff --check
```

Expected: the live probe prints a skip message and makes no model call; all deterministic tests PASS.

- [ ] **Step 4: Run the explicit paid live probe once**

Run only after Codex has reviewed the diff and the user has authorized DeepSeek usage for this stage:

```powershell
pnpm test:dsh-live -- --live
```

Expected: three prompts use one `sessionId`, the final temporary file contains the reviewed marker, and cleanup succeeds. Do not force a high-token compaction event; record it later when a real development session naturally compacts.

- [ ] **Step 5: Final verification and commit**

Run frozen install, typecheck, complete tests, diff check, and the CLI JSONL smoke test. Commit:

```powershell
git add README.md package.json tests/live/dsh-session-probe.ts
git commit -m "docs: add persistent DSH driver workflow"
```

## Completion boundary

This plan is complete when the deterministic suite proves one driver process reuses one DSH session through two minimal related operations and one review correction, the controller can hold that process over JSONL, automatic compaction events and capsules are recorded without prompt content, the workspace lock rejects concurrent writers, and the explicit live probe succeeds once with `deepseek-v4-flash`.

Completing this plan does not select the final literary model. It only establishes the cost-efficient development channel needed to implement and compare DeepSeek and OpenAI model adapters in the next workstream.
