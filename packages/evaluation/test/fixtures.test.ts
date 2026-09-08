import { describe, expect, it } from 'vitest'
import {
  buildContinuationUserPrompt,
  buildSceneUserPrompt,
  buildUserPrompt,
  continuityCharacters,
  continuityFacts,
  continuityOpening,
  continuityStageTasks,
  currentFixtureHash,
  evaluationSystemPrompt,
  fixtureSnapshot,
  outputLengthRequirement,
  promptHash,
  sceneInstructions,
  serializeFixtures,
  sha256Hex,
} from '../src/index.js'
import { sceneTaskIds } from '../src/contracts.js'

describe('evaluation fixtures', () => {
  it('provides the three scene tasks with distinct original instructions and a length target', () => {
    expect(sceneTaskIds).toHaveLength(3)
    const seen = new Set<string>()
    for (const taskId of sceneTaskIds) {
      const instruction = sceneInstructions[taskId]
      expect(instruction.length).toBeGreaterThan(0)
      expect(instruction).toContain(outputLengthRequirement)
      seen.add(instruction)
    }
    expect(seen.size).toBe(3)
  })

  it('provides a three-step continuity with fixed people, facts, opening and stage tasks', () => {
    expect(continuityCharacters).toContain('沈砚')
    expect(continuityCharacters).toContain('周闻溪')
    expect(continuityCharacters).toContain('许照')
    expect(continuityFacts).toContain('报岁兰')
    expect(continuityFacts).toContain('铜风铃')
    expect(continuityOpening).toContain('水文站')
    for (const step of [1, 2, 3] as const) {
      expect(continuityStageTasks[step]).toContain(outputLengthRequirement)
    }
    expect(continuityStageTasks[1]).not.toBe(continuityStageTasks[2])
    expect(continuityStageTasks[2]).not.toBe(continuityStageTasks[3])
  })

  it('builds a step-1 prompt from the fixed brief and never requires previous text', () => {
    const prompt = buildContinuationUserPrompt(1)
    expect(prompt).toContain('【人物档案】')
    expect(prompt).toContain('【事实表】')
    expect(prompt).toContain('【开篇场景】')
    expect(prompt).toContain(continuityStageTasks[1])
  })

  it('keeps the fixed brief and the full same-model history on every later step', () => {
    expect(() => buildContinuationUserPrompt(2)).toThrowError(/previous segments/)
    expect(() => buildContinuationUserPrompt(2, [])).toThrowError(/exactly 1/)
    expect(() => buildContinuationUserPrompt(3, ['只给了一段'])).toThrowError(
      /exactly 2/,
    )
    expect(() => buildContinuationUserPrompt(1, ['多余前文'])).toThrowError(
      /step 1 must not receive/,
    )

    const first = '第一段正文内容。'
    const second = '第二段正文内容。'
    const step2 = buildContinuationUserPrompt(2, [first])
    expect(step2).toContain('【人物档案】')
    expect(step2).toContain('【事实表】')
    expect(step2).toContain(continuityOpening)
    expect(step2).toContain(first)
    expect(step2).toContain(continuityStageTasks[2])
    // Fixed brief precedes the model's own history.
    expect(step2.indexOf('【人物档案】')).toBeLessThan(step2.indexOf(first))

    const step3 = buildContinuationUserPrompt(3, [first, second])
    expect(step3).toContain('【人物档案】')
    expect(step3).toContain(first)
    expect(step3).toContain(second)
    expect(step3.indexOf(first)).toBeLessThan(step3.indexOf(second))
    expect(step3).toContain(continuityStageTasks[3])
  })

  it('stays identical across models for the same step and fixed materials', () => {
    const flashStep1 = buildUserPrompt('three-step-continuity', 'continuation', 1)
    const proStep1 = buildUserPrompt('three-step-continuity', 'continuation', 1)
    expect(flashStep1).toBe(proStep1)
    const step2A = buildContinuationUserPrompt(2, ['甲模型前文'])
    const step2B = buildContinuationUserPrompt(2, ['乙模型前文'])
    expect(step2A.replace('甲模型前文', '')).toBe(
      step2B.replace('乙模型前文', ''),
    )
  })

  it('builds scene prompts via the generic builder and rejects bad kinds', () => {
    const prompt = buildUserPrompt('reunion', 'scene', null)
    expect(prompt).toBe(buildSceneUserPrompt('reunion'))
    expect(() => buildUserPrompt('reunion', 'continuation', null)).toThrowError(
      /invalid continuation attempt/,
    )
  })

  it('hashes snapshots and prompts deterministically', () => {
    expect(currentFixtureHash()).toMatch(/^[0-9a-f]{64}$/)
    expect(currentFixtureHash()).toBe(sha256Hex(serializeFixtures()))
    const snapshot = fixtureSnapshot()
    expect(snapshot.fixtureVersion).toBe(1)
    expect(snapshot.systemPrompt).toBe(evaluationSystemPrompt)
    const first = promptHash('system', 'user')
    const second = promptHash('system', 'user')
    expect(first).toBe(second)
    expect(first).not.toBe(promptHash('system', 'user2'))
  })
})
