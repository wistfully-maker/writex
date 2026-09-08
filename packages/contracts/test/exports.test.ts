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
