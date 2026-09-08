import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { qualityDimensions, type CandidateEvaluation } from '@writex/contracts'
import { createProgram, type WriteFn } from '../src/index.js'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'writex-cli-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function capture(): { outputs: string[]; write: WriteFn } {
  const outputs: string[] = []
  return {
    outputs,
    write: (chunk: string) => {
      outputs.push(String(chunk))
    },
  }
}

function lastOutput(outputs: string[]): string {
  const last = outputs[outputs.length - 1]
  if (last === undefined) {
    throw new Error('expected captured program output')
  }
  return last
}

function evaluationAt(score: number): CandidateEvaluation {
  const dimensions = {} as CandidateEvaluation['dimensions']
  for (const name of qualityDimensions) {
    dimensions[name] = {
      score,
      evidence: ['具体证据'],
      diagnosis: '诊断',
      revisionInstruction: '修改指令',
    }
  }
  return { dimensions, vetoes: [] }
}

describe('createProgram', () => {
  it('initializes a novel workspace, then a fresh status reports it as JSON', async () => {
    const root = await makeRoot()
    const { outputs, write } = capture()

    const initProgram = createProgram(write)
    await initProgram.parseAsync(
      ['novel', 'init', root, '--title', '长夜来信'],
      { from: 'user' },
    )

    const statusProgram = createProgram(write)
    await statusProgram.parseAsync(['status', root, '--json'], { from: 'user' })

    expect(outputs[0]).toBe(`Initialized ${root}\n`)

    const report = JSON.parse(lastOutput(outputs)) as {
      root: string
      title: string
      style: string
      chapters: number
    }
    expect(report.root).toBe(root)
    expect(report.title).toBe('长夜来信')
    expect(report.style).toBe('youth-mythic-melancholy')
    expect(report.chapters).toBe(0)
  })

  it('scores a CandidateEvaluation JSON file with a pass at 80 on every dimension', async () => {
    const root = await makeRoot()
    const evaluationPath = join(root, 'evaluation.json')
    await writeFile(evaluationPath, JSON.stringify(evaluationAt(80)), 'utf8')

    const { outputs, write } = capture()
    const program = createProgram(write)
    await program.parseAsync(['quality', 'score', evaluationPath, '--json'], { from: 'user' })

    const decision = JSON.parse(lastOutput(outputs)) as {
      total: number
      passed: boolean
      failedDimensions: string[]
      vetoes: string[]
    }
    expect(decision).toEqual({
      total: 80,
      passed: true,
      failedDimensions: [],
      vetoes: [],
    })
  })

  it('status counts only markdown chapter files under manuscript', async () => {
    const root = await makeRoot()
    const { outputs, write } = capture()

    const initProgram = createProgram(write)
    await initProgram.parseAsync(
      ['novel', 'init', root, '--title', '长夜来信'],
      { from: 'user' },
    )

    await writeFile(join(root, 'manuscript', 'chapter-001.md'), '# 第一章\n', 'utf8')
    await writeFile(join(root, 'manuscript', 'notes.md'), '写作备忘\n', 'utf8')

    const statusProgram = createProgram(write)
    await statusProgram.parseAsync(['status', root], { from: 'user' })

    expect(lastOutput(outputs)).toBe('长夜来信: 1 chapters\n')
  })
})
