# WriteX Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable, model-independent WriteX CLI foundation that can create a novel workspace, validate and score the five quality dimensions, persist resumable runs and events, and transactionally accept staged artifacts.

**Architecture:** Use a TypeScript/pnpm monorepo with contracts at the center and small packages for quality, workspace, model gateway, core run state, and CLI. The first slice uses a deterministic Fake Model only; real providers and DeepSeek Harness integration remain behind `ModelGateway` and are separate implementation plans after the evaluation fixtures exist.

**Tech Stack:** Node.js, TypeScript, ESM, pnpm workspaces, Vitest, Commander, YAML

---

## Scope

This plan implements only the foundation vertical slice from the approved MVP design:

- monorepo and test tooling;
- versioned domain contracts;
- five-dimension quality configuration and weighted geometric scoring;
- file-based novel workspace creation and validation;
- append-only events and resumable run state;
- staged artifact transactions with rollback;
- model-independent gateway plus Fake Model;
- `novel init`, `status`, and `quality score` CLI commands;
- one end-to-end test proving the components work together.

Real model API calls, DeepSeek Harness/Cordis integration, prompts, story development, chapter planning, three-draft competition, literary reviewers, and long-range audits are intentionally excluded from this plan. Each requires a separate tested plan after this foundation passes.

## Target file map

```text
package.json                         root commands and development dependencies
pnpm-workspace.yaml                 workspace discovery
tsconfig.json                       strict TypeScript configuration
vitest.config.ts                    test discovery
.gitignore                          generated and secret files
apps/cli/package.json               CLI package metadata
apps/cli/src/program.ts             testable command definitions
apps/cli/src/bin.ts                 process entry point
apps/cli/test/program.test.ts       CLI behavior
packages/contracts/package.json     contracts package metadata
packages/contracts/src/quality.ts   quality types
packages/contracts/src/workspace.ts workspace types
packages/contracts/src/run.ts       run and event types
packages/contracts/src/model.ts     model gateway types
packages/contracts/src/index.ts     public exports
packages/contracts/test/exports.test.ts runtime/type export smoke test
packages/quality/package.json       quality package metadata
packages/quality/src/config.ts      configuration validation and defaults
packages/quality/src/score.ts       weighted geometric decision
packages/quality/src/index.ts       public exports
packages/quality/test/score.test.ts quality behavior
packages/workspace/package.json     workspace package metadata
packages/workspace/src/layout.ts    canonical paths
packages/workspace/src/init.ts      safe workspace initialization
packages/workspace/src/config.ts    config loading and validation
packages/workspace/src/atomic.ts    atomic single-file writes
packages/workspace/src/events.ts    append-only event store
packages/workspace/src/transaction.ts staged multi-artifact commit
packages/workspace/src/index.ts     public exports
packages/workspace/test/init.test.ts workspace behavior
packages/workspace/test/events.test.ts event behavior
packages/workspace/test/transaction.test.ts transaction behavior
packages/core/package.json          core package metadata
packages/core/src/run-store.ts      run creation and transitions
packages/core/src/index.ts          public exports
packages/core/test/run-store.test.ts run state behavior
packages/model-gateway/package.json model gateway package metadata
packages/model-gateway/src/fake.ts  deterministic test provider
packages/model-gateway/src/index.ts public exports
packages/model-gateway/test/fake.test.ts fake provider behavior
tests/e2e/foundation.test.ts         full foundation slice
README.md                            development and CLI instructions
```

### Task 1: Bootstrap the TypeScript workspace

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`

- [ ] **Step 1: Add root workspace files**

Create `package.json`:

```json
{
  "name": "writex",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "writex": "tsx apps/cli/src/bin.ts"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["apps/**/*.ts", "packages/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
  },
})
```

Create `.gitignore`:

```gitignore
node_modules/
dist/
coverage/
*.tsbuildinfo
.env
.env.*
!.env.example
```

- [ ] **Step 2: Install pinned development tooling through the lockfile**

Run:

```powershell
pnpm add -Dw typescript vitest tsx @types/node
```

Expected: command exits with code 0 and creates `pnpm-lock.yaml`. The lockfile, rather than an unreviewed version string in this plan, pins the resolved tool versions.

- [ ] **Step 3: Verify the empty workspace**

Run:

```powershell
pnpm typecheck
pnpm test
```

Expected: TypeScript exits successfully; Vitest reports that no test files were found. If the installed Vitest treats an empty suite as an error, run `pnpm test -- --passWithNoTests` only for this step.

- [ ] **Step 4: Commit the bootstrap**

```powershell
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json vitest.config.ts .gitignore
git commit -m "build: bootstrap TypeScript workspace"
```

### Task 2: Define the versioned contracts

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/src/quality.ts`
- Create: `packages/contracts/src/workspace.ts`
- Create: `packages/contracts/src/run.ts`
- Create: `packages/contracts/src/model.ts`
- Create: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/exports.test.ts`

- [ ] **Step 1: Write a failing contract export test**

Create `packages/contracts/test/exports.test.ts`:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  contractVersion,
  qualityDimensions,
  type ModelGateway,
  type NovelConfig,
  type RunState,
} from '../src/index.js'

describe('contracts', () => {
  it('exports a stable contract version and dimension order', () => {
    expect(contractVersion).toBe(1)
    expect(qualityDimensions).toEqual([
      'eternal_emotion',
      'fresh_situation',
      'difficult_choice',
      'character_truth',
      'narrative_control',
    ])
  })

  it('exports public contract types', () => {
    expectTypeOf<ModelGateway>().toBeObject()
    expectTypeOf<NovelConfig>().toBeObject()
    expectTypeOf<RunState>().toBeObject()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm test -- packages/contracts/test/exports.test.ts
```

Expected: FAIL because `packages/contracts/src/index.ts` does not exist.

- [ ] **Step 3: Add the contracts package and quality types**

Create `packages/contracts/package.json`:

```json
{
  "name": "@writex/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  }
}
```

Run:

```powershell
pnpm install
```

Expected: pnpm discovers `@writex/contracts` and records the workspace importer in `pnpm-lock.yaml`.

Create `packages/contracts/src/quality.ts`:

```ts
export const qualityDimensions = [
  'eternal_emotion',
  'fresh_situation',
  'difficult_choice',
  'character_truth',
  'narrative_control',
] as const

export type QualityDimension = (typeof qualityDimensions)[number]

export interface DimensionRule {
  weight: number
  minimum: number
}

export interface QualityGateConfig {
  scale: 100
  dimensions: Record<QualityDimension, DimensionRule>
  passing: {
    minimumTotal: number
    requireEveryDimension: boolean
    maxRevisionRounds: number
  }
}

export interface DimensionEvaluation {
  score: number
  evidence: string[]
  diagnosis: string
  revisionInstruction: string
}

export interface CandidateEvaluation {
  dimensions: Record<QualityDimension, DimensionEvaluation>
  vetoes: string[]
}

export interface QualityDecision {
  total: number
  passed: boolean
  failedDimensions: QualityDimension[]
  vetoes: string[]
}
```

- [ ] **Step 4: Add workspace, run, and model contracts**

Create `packages/contracts/src/workspace.ts`:

```ts
export interface NovelConfig {
  schemaVersion: 1
  title: string
  language: 'zh-CN'
  style: string
  qualityProfile: string
}

export interface NovelSnapshot {
  root: string
  config: NovelConfig
}
```

Create `packages/contracts/src/run.ts`:

```ts
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
```

Create `packages/contracts/src/model.ts`:

```ts
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
```

Create `packages/contracts/src/index.ts`:

```ts
export const contractVersion = 1 as const

export * from './model.js'
export * from './quality.js'
export * from './run.js'
export * from './workspace.js'
```

- [ ] **Step 5: Verify contracts**

Run:

```powershell
pnpm test -- packages/contracts/test/exports.test.ts
pnpm typecheck
```

Expected: both commands PASS.

- [ ] **Step 6: Commit contracts**

```powershell
git add packages/contracts pnpm-lock.yaml
git commit -m "feat: define WriteX domain contracts"
```

### Task 3: Implement the five-dimension quality gate

**Files:**
- Create: `packages/quality/package.json`
- Create: `packages/quality/src/config.ts`
- Create: `packages/quality/src/score.ts`
- Create: `packages/quality/src/index.ts`
- Test: `packages/quality/test/score.test.ts`

- [ ] **Step 1: Write failing quality tests**

Create `packages/quality/test/score.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { CandidateEvaluation } from '@writex/contracts'
import {
  defaultQualityGate,
  scoreQuality,
  validateQualityGateConfig,
} from '../src/index.js'

function evaluation(score: number): CandidateEvaluation {
  const result = Object.fromEntries(
    Object.keys(defaultQualityGate.dimensions).map((dimension) => [
      dimension,
      {
        score,
        evidence: ['具体证据'],
        diagnosis: '诊断',
        revisionInstruction: '修改指令',
      },
    ]),
  ) as CandidateEvaluation['dimensions']

  return { dimensions: result, vetoes: [] }
}

describe('scoreQuality', () => {
  it('returns the common score when every dimension is equal', () => {
    expect(scoreQuality(evaluation(80), defaultQualityGate)).toEqual({
      total: 80,
      passed: true,
      failedDimensions: [],
      vetoes: [],
    })
  })

  it('fails when one dimension is below its hard minimum', () => {
    const input = evaluation(80)
    input.dimensions.character_truth.score = 60
    const decision = scoreQuality(input, defaultQualityGate)
    expect(decision.passed).toBe(false)
    expect(decision.failedDimensions).toContain('character_truth')
  })

  it('returns zero when one dimension is zero', () => {
    const input = evaluation(80)
    input.dimensions.eternal_emotion.score = 0
    expect(scoreQuality(input, defaultQualityGate).total).toBe(0)
  })

  it('cannot pass a veto', () => {
    const input = evaluation(90)
    input.vetoes.push('人物知道了不应知道的信息')
    expect(scoreQuality(input, defaultQualityGate).passed).toBe(false)
  })

  it('rejects weights that do not sum to one', () => {
    const invalid = structuredClone(defaultQualityGate)
    invalid.dimensions.eternal_emotion.weight = 0.5
    expect(() => validateQualityGateConfig(invalid)).toThrow(/sum to 1/)
  })

  it('rejects a score without evidence', () => {
    const input = evaluation(80)
    input.dimensions.narrative_control.evidence = []
    expect(() => scoreQuality(input, defaultQualityGate)).toThrow(/evidence/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
pnpm test -- packages/quality/test/score.test.ts
```

Expected: FAIL because `@writex/quality` is not implemented.

- [ ] **Step 3: Add package metadata and workspace dependency**

Create `packages/quality/package.json`:

```json
{
  "name": "@writex/quality",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@writex/contracts": "workspace:*"
  }
}
```

Run:

```powershell
pnpm install
```

Expected: `@writex/contracts` is linked into the quality workspace and the lockfile importer is updated.

- [ ] **Step 4: Implement configuration validation**

Create `packages/quality/src/config.ts`:

```ts
import {
  qualityDimensions,
  type QualityGateConfig,
} from '@writex/contracts'

export const defaultQualityGate: QualityGateConfig = {
  scale: 100,
  dimensions: {
    eternal_emotion: { weight: 0.25, minimum: 65 },
    fresh_situation: { weight: 0.15, minimum: 60 },
    difficult_choice: { weight: 0.2, minimum: 65 },
    character_truth: { weight: 0.25, minimum: 70 },
    narrative_control: { weight: 0.15, minimum: 65 },
  },
  passing: {
    minimumTotal: 72,
    requireEveryDimension: true,
    maxRevisionRounds: 3,
  },
}

export function validateQualityGateConfig(config: QualityGateConfig): void {
  const weights = qualityDimensions.map((name) => config.dimensions[name].weight)
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)

  if (weights.some((weight) => !Number.isFinite(weight) || weight < 0)) {
    throw new Error('quality weights must be finite and non-negative')
  }
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new Error('quality weights must sum to 1')
  }

  for (const name of qualityDimensions) {
    const minimum = config.dimensions[name].minimum
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
      throw new Error(`${name} minimum must be between 0 and 100`)
    }
  }

  if (config.passing.minimumTotal < 0 || config.passing.minimumTotal > 100) {
    throw new Error('minimumTotal must be between 0 and 100')
  }
  if (!Number.isInteger(config.passing.maxRevisionRounds) || config.passing.maxRevisionRounds < 0) {
    throw new Error('maxRevisionRounds must be a non-negative integer')
  }
}
```

- [ ] **Step 5: Implement weighted geometric scoring**

Create `packages/quality/src/score.ts`:

```ts
import {
  qualityDimensions,
  type CandidateEvaluation,
  type QualityDecision,
  type QualityGateConfig,
} from '@writex/contracts'
import { validateQualityGateConfig } from './config.js'

export function scoreQuality(
  evaluation: CandidateEvaluation,
  config: QualityGateConfig,
): QualityDecision {
  validateQualityGateConfig(config)

  let containsZero = false
  let weightedLog = 0
  const failedDimensions: QualityDecision['failedDimensions'] = []

  for (const name of qualityDimensions) {
    const result = evaluation.dimensions[name]
    if (!result) throw new Error(`missing evaluation for ${name}`)
    if (!Number.isFinite(result.score) || result.score < 0 || result.score > 100) {
      throw new Error(`${name} score must be between 0 and 100`)
    }
    if (result.evidence.length === 0 || result.evidence.some((item) => item.trim() === '')) {
      throw new Error(`${name} evaluation requires evidence`)
    }

    if (result.score === 0) {
      containsZero = true
    } else {
      weightedLog += config.dimensions[name].weight * Math.log(result.score / 100)
    }

    if (config.passing.requireEveryDimension && result.score < config.dimensions[name].minimum) {
      failedDimensions.push(name)
    }
  }

  const total = containsZero ? 0 : Math.round(10000 * Math.exp(weightedLog)) / 100
  const passed =
    failedDimensions.length === 0 &&
    evaluation.vetoes.length === 0 &&
    total >= config.passing.minimumTotal

  return {
    total,
    passed,
    failedDimensions,
    vetoes: [...evaluation.vetoes],
  }
}
```

Create `packages/quality/src/index.ts`:

```ts
export * from './config.js'
export * from './score.js'
```

- [ ] **Step 6: Verify quality behavior**

Run:

```powershell
pnpm test -- packages/quality/test/score.test.ts
pnpm typecheck
```

Expected: all six tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit the quality gate**

```powershell
git add packages/quality pnpm-lock.yaml
git commit -m "feat: add configurable literary quality gate"
```

### Task 4: Create and validate novel workspaces

**Files:**
- Create: `packages/workspace/package.json`
- Create: `packages/workspace/src/layout.ts`
- Create: `packages/workspace/src/init.ts`
- Create: `packages/workspace/src/config.ts`
- Create: `packages/workspace/src/atomic.ts`
- Create: `packages/workspace/src/index.ts`
- Test: `packages/workspace/test/init.test.ts`

- [ ] **Step 1: Write failing initialization tests**

Create `packages/workspace/test/init.test.ts`:

```ts
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initNovelWorkspace, loadNovelConfig } from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('initNovelWorkspace', () => {
  it('creates the canonical layout and readable config', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'writex-init-'))
    roots.push(parent)
    const root = join(parent, 'novel')

    await initNovelWorkspace(root, {
      title: '长夜来信',
      style: 'youth-mythic-melancholy',
    })

    const config = await loadNovelConfig(root)
    expect(config).toMatchObject({ title: '长夜来信', language: 'zh-CN' })
    expect((await readdir(join(root, 'state'))).sort()).toEqual([
      'character-knowledge.json',
      'motif-ledger.json',
      'promises.json',
      'timeline.json',
    ])
    expect(await readFile(join(root, 'brief.md'), 'utf8')).toContain('# 长夜来信')
  })

  it('refuses to initialize a non-empty directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writex-nonempty-'))
    roots.push(root)
    await import('node:fs/promises').then(({ writeFile }) => writeFile(join(root, 'keep.txt'), 'user data'))
    await expect(initNovelWorkspace(root, { title: '不会覆盖', style: 'default' })).rejects.toThrow(/not empty/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
pnpm test -- packages/workspace/test/init.test.ts
```

Expected: FAIL because the workspace package does not exist.

- [ ] **Step 3: Add workspace metadata and dependencies**

Create `packages/workspace/package.json`:

```json
{
  "name": "@writex/workspace",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@writex/contracts": "workspace:*"
  }
}
```

Run:

```powershell
pnpm --filter @writex/workspace add yaml
```

Expected: command exits successfully and updates the workspace package plus lockfile.

- [ ] **Step 4: Add canonical layout and atomic file writing**

Create `packages/workspace/src/layout.ts`:

```ts
export const novelDirectories = [
  'canon/characters',
  'outline/volumes',
  'outline/chapter-cards',
  'state',
  'manuscript',
  'drafts',
  'reviews',
  '.writex/runs',
  '.writex/snapshots',
  '.writex/staged',
] as const
```

Create `packages/workspace/src/atomic.ts`:

```ts
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content, 'utf8')
  await rename(temporary, path)
}
```

- [ ] **Step 5: Implement initialization and config loading**

Create `packages/workspace/src/init.ts`:

```ts
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stringify } from 'yaml'
import type { NovelConfig } from '@writex/contracts'
import { novelDirectories } from './layout.js'

export interface InitNovelInput {
  title: string
  style: string
}

export async function initNovelWorkspace(root: string, input: InitNovelInput): Promise<void> {
  await mkdir(root, { recursive: true })
  const existing = await readdir(root)
  if (existing.length > 0) throw new Error(`workspace is not empty: ${root}`)
  if (input.title.trim() === '') throw new Error('title is required')
  if (input.style.trim() === '') throw new Error('style is required')

  await Promise.all(novelDirectories.map((directory) => mkdir(join(root, directory), { recursive: true })))

  const config: NovelConfig = {
    schemaVersion: 1,
    title: input.title.trim(),
    language: 'zh-CN',
    style: input.style.trim(),
    qualityProfile: 'default',
  }

  const files: Array<[string, string]> = [
    ['writex.yaml', stringify(config)],
    ['brief.md', `# ${config.title}\n\n## 创作意图\n\n`],
    ['canon/world.md', '# 世界正典\n'],
    ['canon/relationships.yaml', 'relationships: []\n'],
    ['outline/main-arc.md', '# 全书主线\n'],
    ['state/timeline.json', '[]\n'],
    ['state/character-knowledge.json', '{}\n'],
    ['state/motif-ledger.json', '[]\n'],
    ['state/promises.json', '[]\n'],
    ['.writex/events.jsonl', ''],
  ]

  await Promise.all(files.map(([path, content]) => writeFile(join(root, path), content, 'utf8')))
}
```

Create `packages/workspace/src/config.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { NovelConfig } from '@writex/contracts'

export async function loadNovelConfig(root: string): Promise<NovelConfig> {
  const value = parse(await readFile(join(root, 'writex.yaml'), 'utf8')) as Partial<NovelConfig>
  if (value.schemaVersion !== 1) throw new Error('unsupported workspace schemaVersion')
  if (typeof value.title !== 'string' || value.title.trim() === '') throw new Error('invalid workspace title')
  if (value.language !== 'zh-CN') throw new Error('unsupported workspace language')
  if (typeof value.style !== 'string' || value.style.trim() === '') throw new Error('invalid workspace style')
  if (typeof value.qualityProfile !== 'string' || value.qualityProfile.trim() === '') {
    throw new Error('invalid quality profile')
  }
  return value as NovelConfig
}
```

Create `packages/workspace/src/index.ts`:

```ts
export * from './atomic.js'
export * from './config.js'
export * from './init.js'
export * from './layout.js'
```

- [ ] **Step 6: Verify workspace initialization**

Run:

```powershell
pnpm test -- packages/workspace/test/init.test.ts
pnpm typecheck
```

Expected: both initialization tests PASS and typecheck succeeds.

- [ ] **Step 7: Commit workspace initialization**

```powershell
git add packages/workspace pnpm-lock.yaml
git commit -m "feat: initialize novel workspaces"
```

### Task 5: Persist append-only events and resumable run state

**Files:**
- Create: `packages/workspace/src/events.ts`
- Modify: `packages/workspace/src/index.ts`
- Test: `packages/workspace/test/events.test.ts`
- Create: `packages/core/package.json`
- Create: `packages/core/src/run-store.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/test/run-store.test.ts`

- [ ] **Step 1: Write failing event and run-state tests**

Create `packages/workspace/test/events.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendRunEvent, readRunEvents } from '../src/index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('run events', () => {
  it('appends and reads events in order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writex-events-'))
    roots.push(root)
    await appendRunEvent(root, {
      schemaVersion: 1,
      eventId: 'event-1',
      runId: 'run-1',
      type: 'run/created',
      occurredAt: '2026-09-02T00:00:00.000Z',
      payload: {},
    })
    expect(await readRunEvents(root)).toHaveLength(1)
  })
})
```

Create `packages/core/test/run-store.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RunStore } from '../src/index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('RunStore', () => {
  it('persists legal transitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writex-run-'))
    roots.push(root)
    const store = new RunStore(root, () => '2026-09-02T00:00:00.000Z')
    await store.create({ runId: 'run-1', command: 'novel init', inputHash: 'abc' })
    await store.transition('run-1', 'running')
    await store.transition('run-1', 'succeeded')
    expect((await store.read('run-1')).status).toBe('succeeded')
  })

  it('rejects transitions out of a terminal state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writex-run-terminal-'))
    roots.push(root)
    const store = new RunStore(root)
    await store.create({ runId: 'run-1', command: 'status', inputHash: 'abc' })
    await store.transition('run-1', 'cancelled')
    await expect(store.transition('run-1', 'running')).rejects.toThrow(/illegal run transition/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
pnpm test -- packages/workspace/test/events.test.ts packages/core/test/run-store.test.ts
```

Expected: FAIL because event persistence and `RunStore` do not exist.

- [ ] **Step 3: Implement append-only events**

Create `packages/workspace/src/events.ts`:

```ts
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunEvent } from '@writex/contracts'

function eventsPath(root: string): string {
  return join(root, '.writex', 'events.jsonl')
}

export async function appendRunEvent(root: string, event: RunEvent): Promise<void> {
  const path = eventsPath(root)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
}

export async function readRunEvents(root: string): Promise<RunEvent[]> {
  try {
    const content = await readFile(eventsPath(root), 'utf8')
    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as RunEvent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
```

Add to `packages/workspace/src/index.ts`:

```ts
export * from './events.js'
```

- [ ] **Step 4: Implement the run store**

Create `packages/core/package.json`:

```json
{
  "name": "@writex/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@writex/contracts": "workspace:*",
    "@writex/workspace": "workspace:*"
  }
}
```

Run:

```powershell
pnpm install
```

Expected: the core workspace receives links for `@writex/contracts` and `@writex/workspace`.

Create `packages/core/src/run-store.ts`:

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunState, RunStatus } from '@writex/contracts'
import { atomicWriteFile } from '@writex/workspace'

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['needs-human-review', 'succeeded', 'failed', 'cancelled'],
  'needs-human-review': ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export interface CreateRunInput {
  runId: string
  command: string
  inputHash: string
}

export class RunStore {
  constructor(
    private readonly root: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private path(runId: string): string {
    return join(this.root, '.writex', 'runs', runId, 'state.json')
  }

  async create(input: CreateRunInput): Promise<RunState> {
    const timestamp = this.now()
    const state: RunState = {
      schemaVersion: 1,
      ...input,
      status: 'queued',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await atomicWriteFile(this.path(input.runId), `${JSON.stringify(state, null, 2)}\n`)
    return state
  }

  async read(runId: string): Promise<RunState> {
    return JSON.parse(await readFile(this.path(runId), 'utf8')) as RunState
  }

  async transition(runId: string, next: RunStatus): Promise<RunState> {
    const current = await this.read(runId)
    if (!transitions[current.status].includes(next)) {
      throw new Error(`illegal run transition: ${current.status} -> ${next}`)
    }
    const updated: RunState = { ...current, status: next, updatedAt: this.now() }
    await atomicWriteFile(this.path(runId), `${JSON.stringify(updated, null, 2)}\n`)
    return updated
  }
}
```

Create `packages/core/src/index.ts`:

```ts
export * from './run-store.js'
```

- [ ] **Step 5: Verify persistence and transitions**

Run:

```powershell
pnpm test -- packages/workspace/test/events.test.ts packages/core/test/run-store.test.ts
pnpm typecheck
```

Expected: all three tests PASS and typecheck succeeds.

- [ ] **Step 6: Commit persistence**

```powershell
git add packages/workspace packages/core pnpm-lock.yaml
git commit -m "feat: persist runs and append-only events"
```

### Task 6: Add staged artifact transactions

**Files:**
- Create: `packages/workspace/src/transaction.ts`
- Modify: `packages/workspace/src/index.ts`
- Test: `packages/workspace/test/transaction.test.ts`

- [ ] **Step 1: Write failing transaction tests**

Create `packages/workspace/test/transaction.test.ts`:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTransaction } from '../src/index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('WorkspaceTransaction', () => {
  it('commits staged artifacts together', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writex-transaction-'))
    roots.push(root)
    const transaction = new WorkspaceTransaction(root, 'run-1')
    await transaction.stageText('manuscript/chapter-001.md', '正文\n')
    await transaction.stageText('state/timeline.json', '[{"chapter":1}]\n')
    await transaction.commit()
    expect(await readFile(join(root, 'manuscript/chapter-001.md'), 'utf8')).toBe('正文\n')
    expect(await readFile(join(root, 'state/timeline.json'), 'utf8')).toContain('chapter')
  })

  it('restores replaced files when apply fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writex-rollback-'))
    roots.push(root)
    await mkdir(join(root, 'state'), { recursive: true })
    await writeFile(join(root, 'state/timeline.json'), 'old\n')
    const transaction = new WorkspaceTransaction(root, 'run-2', async (index) => {
      if (index === 1) throw new Error('injected apply failure')
    })
    await transaction.stageText('state/timeline.json', 'new\n')
    await transaction.stageText('manuscript/chapter-001.md', '正文\n')
    await expect(transaction.commit()).rejects.toThrow(/injected apply failure/)
    expect(await readFile(join(root, 'state/timeline.json'), 'utf8')).toBe('old\n')
  })

  it('rejects traversal and infrastructure paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writex-path-'))
    roots.push(root)
    const transaction = new WorkspaceTransaction(root, 'run-3')
    await expect(transaction.stageText('../escape.txt', 'bad')).rejects.toThrow(/unsafe artifact path/)
    await expect(transaction.stageText('.git/config', 'bad')).rejects.toThrow(/unsafe artifact path/)
  })

  it('recovers a process interrupted during commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writex-recovery-'))
    roots.push(root)
    const base = join(root, '.writex/staged/run-4')
    await mkdir(join(root, 'state'), { recursive: true })
    await mkdir(join(base, 'backups/state'), { recursive: true })
    await writeFile(join(root, 'state/timeline.json'), 'new\n')
    await writeFile(join(base, 'backups/state/timeline.json'), 'old\n')
    await writeFile(join(base, 'manifest.json'), JSON.stringify({
      schemaVersion: 1,
      runId: 'run-4',
      status: 'committing',
      files: ['state/timeline.json'],
      applied: ['state/timeline.json'],
      current: null,
    }))

    const transaction = new WorkspaceTransaction(root, 'run-4')
    expect(await transaction.recover()).toBe('rolled-back')
    expect(await readFile(join(root, 'state/timeline.json'), 'utf8')).toBe('old\n')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm test -- packages/workspace/test/transaction.test.ts
```

Expected: FAIL because `WorkspaceTransaction` does not exist.

- [ ] **Step 3: Implement staged commit and rollback**

Create `packages/workspace/src/transaction.ts`:

```ts
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { atomicWriteFile } from './atomic.js'

interface Manifest {
  schemaVersion: 1
  runId: string
  status: 'staging' | 'committing' | 'committed' | 'rolled-back'
  files: string[]
  applied: string[]
  current: {
    path: string
    installed: boolean
  } | null
}

type BeforeApply = (index: number, relativePath: string) => Promise<void>

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function safeRelativePath(value: string): string {
  const normalized = normalize(value)
  const portable = normalized.split(sep).join('/')
  if (
    value.trim() === '' ||
    isAbsolute(value) ||
    portable === '..' ||
    portable.startsWith('../') ||
    portable === '.git' ||
    portable.startsWith('.git/') ||
    portable === '.writex' ||
    portable.startsWith('.writex/')
  ) {
    throw new Error(`unsafe artifact path: ${value}`)
  }
  return portable
}

export class WorkspaceTransaction {
  private readonly base: string
  private readonly filesRoot: string
  private readonly backupsRoot: string
  private readonly manifestPath: string
  private manifest: Manifest

  constructor(
    private readonly root: string,
    private readonly runId: string,
    private readonly beforeApply: BeforeApply = async () => undefined,
  ) {
    this.base = join(root, '.writex', 'staged', runId)
    this.filesRoot = join(this.base, 'files')
    this.backupsRoot = join(this.base, 'backups')
    this.manifestPath = join(this.base, 'manifest.json')
    this.manifest = {
      schemaVersion: 1,
      runId,
      status: 'staging',
      files: [],
      applied: [],
      current: null,
    }
  }

  private async saveManifest(): Promise<void> {
    await atomicWriteFile(this.manifestPath, `${JSON.stringify(this.manifest, null, 2)}\n`)
  }

  async stageText(relativePath: string, content: string): Promise<void> {
    const path = safeRelativePath(relativePath)
    if (!this.manifest.files.includes(path)) this.manifest.files.push(path)
    await mkdir(dirname(join(this.filesRoot, path)), { recursive: true })
    await writeFile(join(this.filesRoot, path), content, 'utf8')
    await this.saveManifest()
  }

  private async restoreApplied(): Promise<void> {
    if (this.manifest.current) {
      const path = this.manifest.current.path
      const target = join(this.root, path)
      const backup = join(this.backupsRoot, path)
      const staged = join(this.filesRoot, path)
      const installed = this.manifest.current.installed || !(await exists(staged))
      if (installed) await rm(target, { force: true })
      if (await exists(backup)) {
        await mkdir(dirname(target), { recursive: true })
        await rename(backup, target)
      }
    }

    for (const path of [...this.manifest.applied].reverse()) {
      const target = join(this.root, path)
      const backup = join(this.backupsRoot, path)
      await rm(target, { force: true })
      if (await exists(backup)) {
        await mkdir(dirname(target), { recursive: true })
        await rename(backup, target)
      }
    }
    this.manifest.current = null
    this.manifest.status = 'rolled-back'
    await this.saveManifest()
  }

  async commit(): Promise<void> {
    this.manifest.status = 'committing'
    await this.saveManifest()
    try {
      for (const [index, path] of this.manifest.files.entries()) {
        await this.beforeApply(index, path)
        const staged = join(this.filesRoot, path)
        const target = join(this.root, path)
        const backup = join(this.backupsRoot, path)
        if (relative(this.root, target).startsWith('..')) throw new Error(`unsafe artifact path: ${path}`)
        this.manifest.current = { path, installed: false }
        await this.saveManifest()
        await mkdir(dirname(target), { recursive: true })
        if (await exists(target)) {
          await mkdir(dirname(backup), { recursive: true })
          await rename(target, backup)
        }
        await rename(staged, target)
        this.manifest.current.installed = true
        await this.saveManifest()
        this.manifest.applied.push(path)
        this.manifest.current = null
        await this.saveManifest()
      }
      this.manifest.status = 'committed'
      await this.saveManifest()
    } catch (error) {
      await this.restoreApplied()
      throw error
    }
  }

  async recover(): Promise<Manifest['status']> {
    this.manifest = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest
    if (this.manifest.status === 'committing') await this.restoreApplied()
    return this.manifest.status
  }

  async readManifest(): Promise<Manifest> {
    return JSON.parse(await readFile(this.manifestPath, 'utf8')) as Manifest
  }
}
```

Add to `packages/workspace/src/index.ts`:

```ts
export * from './transaction.js'
```

- [ ] **Step 4: Verify transactions**

Run:

```powershell
pnpm test -- packages/workspace/test/transaction.test.ts
pnpm typecheck
```

Expected: all four transaction tests PASS. The injected second-file failure and simulated process interruption both restore the original file to `old\n`.

- [ ] **Step 5: Commit transactions**

```powershell
git add packages/workspace
git commit -m "feat: add staged workspace transactions"
```

### Task 7: Define the gateway with a deterministic Fake Model

**Files:**
- Create: `packages/model-gateway/package.json`
- Create: `packages/model-gateway/src/fake.ts`
- Create: `packages/model-gateway/src/index.ts`
- Test: `packages/model-gateway/test/fake.test.ts`

- [ ] **Step 1: Write a failing fake-provider test**

Create `packages/model-gateway/test/fake.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { FakeModelGateway } from '../src/index.js'

describe('FakeModelGateway', () => {
  it('returns queued responses and records requests', async () => {
    const gateway = new FakeModelGateway(['第一稿', '第二稿'])
    const first = await gateway.generate({
      requestId: 'request-1',
      purpose: 'scene-draft',
      system: 'system',
      prompt: 'prompt',
      metadata: { candidate: 'a' },
    })
    expect(first.text).toBe('第一稿')
    expect(first.provider).toBe('fake')
    expect(gateway.requests).toHaveLength(1)
  })

  it('fails loudly when no response remains', async () => {
    const gateway = new FakeModelGateway([])
    await expect(gateway.generate({
      requestId: 'request-1',
      purpose: 'test',
      system: '',
      prompt: '',
      metadata: {},
    })).rejects.toThrow(/no queued response/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
pnpm test -- packages/model-gateway/test/fake.test.ts
```

Expected: FAIL because `FakeModelGateway` does not exist.

- [ ] **Step 3: Implement the fake gateway**

Create `packages/model-gateway/package.json`:

```json
{
  "name": "@writex/model-gateway",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@writex/contracts": "workspace:*"
  }
}
```

Run:

```powershell
pnpm install
```

Expected: the model gateway receives its `@writex/contracts` workspace link.

Create `packages/model-gateway/src/fake.ts`:

```ts
import type {
  GenerationRequest,
  GenerationResult,
  ModelGateway,
} from '@writex/contracts'

export class FakeModelGateway implements ModelGateway {
  readonly requests: GenerationRequest[] = []

  constructor(private readonly responses: string[]) {}

  async generate(request: GenerationRequest): Promise<GenerationResult> {
    this.requests.push(structuredClone(request))
    const text = this.responses.shift()
    if (text === undefined) throw new Error(`fake model has no queued response for ${request.requestId}`)
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
```

Create `packages/model-gateway/src/index.ts`:

```ts
export * from './fake.js'
```

- [ ] **Step 4: Verify the gateway**

Run:

```powershell
pnpm test -- packages/model-gateway/test/fake.test.ts
pnpm typecheck
```

Expected: both tests PASS and typecheck succeeds.

- [ ] **Step 5: Commit the model boundary**

```powershell
git add packages/model-gateway pnpm-lock.yaml
git commit -m "feat: add model gateway test double"
```

### Task 8: Expose the foundation through the CLI

**Files:**
- Create: `apps/cli/package.json`
- Create: `apps/cli/src/program.ts`
- Create: `apps/cli/src/bin.ts`
- Test: `apps/cli/test/program.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `apps/cli/test/program.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createProgram } from '../src/program.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('writex CLI', () => {
  it('initializes and reports a novel workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'writex-cli-'))
    roots.push(parent)
    const root = join(parent, 'novel')
    const output: string[] = []
    await createProgram((value) => output.push(value)).parseAsync(
      ['novel', 'init', root, '--title', '长夜来信'],
      { from: 'user' },
    )
    await createProgram((value) => output.push(value)).parseAsync(
      ['status', root, '--json'],
      { from: 'user' },
    )
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ title: '长夜来信', chapters: 0 })
  })

  it('scores a complete evaluation file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'writex-score-'))
    roots.push(root)
    const evaluationPath = join(root, 'evaluation.json')
    const dimension = {
      score: 80,
      evidence: ['证据'],
      diagnosis: '诊断',
      revisionInstruction: '修改',
    }
    await writeFile(evaluationPath, JSON.stringify({
      dimensions: {
        eternal_emotion: dimension,
        fresh_situation: dimension,
        difficult_choice: dimension,
        character_truth: dimension,
        narrative_control: dimension,
      },
      vetoes: [],
    }))
    const output: string[] = []
    const program = createProgram((value) => output.push(value))
    await program.parseAsync(['quality', 'score', evaluationPath, '--json'], { from: 'user' })
    expect(JSON.parse(output.at(-1) ?? '{}')).toMatchObject({ total: 80, passed: true })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```powershell
pnpm test -- apps/cli/test/program.test.ts
```

Expected: FAIL because the CLI package does not exist.

- [ ] **Step 3: Add CLI metadata and dependencies**

Create `apps/cli/package.json`:

```json
{
  "name": "@writex/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@writex/contracts": "workspace:*",
    "@writex/quality": "workspace:*",
    "@writex/workspace": "workspace:*"
  }
}
```

Run:

```powershell
pnpm --filter @writex/cli add commander
```

Expected: Commander is added and the lockfile changes.

- [ ] **Step 4: Implement testable commands**

Create `apps/cli/src/program.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import type { CandidateEvaluation } from '@writex/contracts'
import { defaultQualityGate, scoreQuality } from '@writex/quality'
import { initNovelWorkspace, loadNovelConfig } from '@writex/workspace'

async function countMarkdownFiles(path: string): Promise<number> {
  try {
    return (await readdir(path)).filter((name) => name.endsWith('.md')).length
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
}

export function createProgram(writeOut: (value: string) => void = (value) => process.stdout.write(value)) {
  const program = new Command()
  program.name('writex').description('中文长篇文学创作工作流').showHelpAfterError()
  program.configureOutput({ writeOut })

  const novel = program.command('novel')
  novel
    .command('init <path>')
    .requiredOption('--title <title>')
    .option('--style <style>', '风格包', 'youth-mythic-melancholy')
    .action(async (path, options) => {
      const root = resolve(path)
      await initNovelWorkspace(root, { title: options.title, style: options.style })
      writeOut(`Initialized ${root}\n`)
    })

  program
    .command('status [path]')
    .option('--json')
    .action(async (path = '.', options) => {
      const root = resolve(path)
      const config = await loadNovelConfig(root)
      const status = {
        root,
        title: config.title,
        style: config.style,
        chapters: await countMarkdownFiles(join(root, 'manuscript')),
      }
      writeOut(options.json ? `${JSON.stringify(status)}\n` : `${status.title}: ${status.chapters} chapters\n`)
    })

  const quality = program.command('quality')
  quality
    .command('score <evaluation>')
    .option('--json')
    .action(async (evaluation, options) => {
      const input = JSON.parse(await readFile(resolve(evaluation), 'utf8')) as CandidateEvaluation
      const decision = scoreQuality(input, defaultQualityGate)
      writeOut(options.json ? `${JSON.stringify(decision)}\n` : `Score ${decision.total}: ${decision.passed ? 'PASS' : 'FAIL'}\n`)
    })

  return program
}
```

Create `apps/cli/src/bin.ts`:

```ts
#!/usr/bin/env node
import { createProgram } from './program.js'

await createProgram().parseAsync(process.argv)
```

- [ ] **Step 5: Verify CLI behavior**

Run:

```powershell
pnpm test -- apps/cli/test/program.test.ts
pnpm typecheck
```

Expected: both CLI tests PASS and typecheck succeeds.

- [ ] **Step 6: Perform a manual CLI smoke test**

Run from a disposable directory outside the repository or use a newly created child of the system temporary directory:

```powershell
$writexSmoke = Join-Path ([System.IO.Path]::GetTempPath()) "writex-smoke-$([guid]::NewGuid())"
pnpm writex novel init $writexSmoke --title "长夜来信"
pnpm writex status $writexSmoke --json
```

Expected: initialization succeeds and status emits JSON with `"title":"长夜来信"` and `"chapters":0`. Remove only the exact `$writexSmoke` directory after verifying its resolved path is under the system temporary directory.

- [ ] **Step 7: Commit the CLI**

```powershell
git add apps/cli pnpm-lock.yaml
git commit -m "feat: expose WriteX foundation CLI"
```

### Task 9: Prove the foundation vertical slice

**Files:**
- Create: `tests/e2e/foundation.test.ts`
- Create: `README.md`

- [ ] **Step 1: Write the end-to-end foundation test**

Create `tests/e2e/foundation.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CandidateEvaluation } from '@writex/contracts'
import { RunStore } from '@writex/core'
import { defaultQualityGate, scoreQuality } from '@writex/quality'
import {
  appendRunEvent,
  initNovelWorkspace,
  WorkspaceTransaction,
} from '@writex/workspace'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('foundation vertical slice', () => {
  it('accepts a passing artifact and advances durable run state', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'writex-e2e-'))
    roots.push(parent)
    const root = join(parent, 'novel')
    await initNovelWorkspace(root, { title: '长夜来信', style: 'youth-mythic-melancholy' })

    const store = new RunStore(root, () => '2026-09-02T00:00:00.000Z')
    await store.create({ runId: 'run-1', command: 'chapter accept 1', inputHash: 'fixture-hash' })
    await store.transition('run-1', 'running')

    const dimension = {
      score: 80,
      evidence: ['夹具中的具体证据'],
      diagnosis: '无需修改',
      revisionInstruction: '保持当前结构',
    }
    const evaluation: CandidateEvaluation = {
      dimensions: {
        eternal_emotion: { ...dimension },
        fresh_situation: { ...dimension },
        difficult_choice: { ...dimension },
        character_truth: { ...dimension },
        narrative_control: { ...dimension },
      },
      vetoes: [],
    }
    const decision = scoreQuality(evaluation, defaultQualityGate)
    expect(decision.passed).toBe(true)

    const transaction = new WorkspaceTransaction(root, 'run-1')
    await transaction.stageText('manuscript/chapter-001.md', '# 第一章\n\n正文。\n')
    await transaction.stageText('state/timeline.json', '[{"chapter":1,"event":"开端"}]\n')
    await transaction.commit()
    await appendRunEvent(root, {
      schemaVersion: 1,
      eventId: 'event-1',
      runId: 'run-1',
      type: 'chapter/accepted',
      occurredAt: '2026-09-02T00:00:00.000Z',
      payload: { chapter: 1, score: decision.total },
    })
    await store.transition('run-1', 'succeeded')

    expect(await readFile(join(root, 'manuscript/chapter-001.md'), 'utf8')).toContain('正文')
    expect((await store.read('run-1')).status).toBe('succeeded')
  })
})
```

- [ ] **Step 2: Run the end-to-end test**

Run:

```powershell
pnpm test -- tests/e2e/foundation.test.ts
```

Expected: the vertical-slice test PASSes.

- [ ] **Step 3: Add the project README**

Create `README.md`:

````markdown
# WriteX

WriteX 是一个面向中文长篇文学创作的可检查、可恢复工作流。当前阶段优先验证文学质量和长程一致性，产品形态为本地 CLI。

## 开发

```powershell
pnpm install
pnpm typecheck
pnpm test
```

## CLI

```powershell
pnpm writex novel init ./my-novel --title "长夜来信"
pnpm writex status ./my-novel
```

详细设计见 `docs/superpowers/specs/2026-09-02-writex-mvp-design.md`。
````

- [ ] **Step 4: Run the complete verification suite**

Run:

```powershell
pnpm typecheck
pnpm test
git diff --check
```

Expected: typecheck succeeds, every test PASSes, and `git diff --check` produces no output.

- [ ] **Step 5: Inspect the final diff and repository status**

Run:

```powershell
git status --short
git diff --stat HEAD
```

Expected: only the README and end-to-end test from this task remain uncommitted; generated temporary novel workspaces are absent.

- [ ] **Step 6: Commit the verified vertical slice**

```powershell
git add README.md tests/e2e/foundation.test.ts
git commit -m "test: verify WriteX foundation workflow"
```

## Completion boundary

This plan is complete when all nine tasks are committed, `pnpm typecheck` and `pnpm test` pass from a fresh install, and the manual CLI smoke test succeeds. Completion does not authorize real model calls, external publishing, DeepSeek Harness integration, or literary-quality claims beyond the deterministic foundation tests.
