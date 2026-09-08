import { createHash } from 'node:crypto'
import {
  continuityTaskId,
  evaluationFixtureVersion,
  type ContinuationStep,
  type EvaluationTaskKind,
  type SceneTaskId,
} from './contracts.js'

export const outputLengthRequirement =
  '正文长度请控制在 800–1200 个中文字之间。'

export const evaluationSystemPrompt = `你是中文小说的作者。下面给出一个创作任务与必要材料。请只输出正文本身：不要输出标题、章节名、创作说明、修改说明或任何题外话。正文使用简体中文。风格要求：情感克制，不把心情直接说出口；多用具体可见的动作、物件与场景推进；对话要有潜台词；避免堆砌成语与说明性总结。若给出你此前生成的正文，只应自然承接，不要复述前文。`

const reunionSceneInstruction = `【创作任务：重逢】
情境：小城青瓷窑址的整理库房。陆既明（男，34 岁）受聘修复一批刚出土的青瓷，温叙（女，33 岁）回来拍摄窑址纪录片。两人高中同校：毕业那年夏夜，他们为抄近路翻进实验楼，碰倒走廊里的旧酒精柜引起小火灾；慌乱中两人一起隐瞒了走火原因，处分落在温叙身上，她随后转学。十六年过去，两人没有联系。

请写两人重逢的第一场戏。要求：
- 从具体动作与物什进入（清点瓷片、登记编号、灯管闪烁等），不要交代性开场；
- 让"共同隐瞒的旧事"压在对话的沉默与岔开的话题里，人物不能直接说出道歉或解释；
- 至少一次让物件或声音打断话头（如一件瓷器的缺口、库房外的雨声）；
- 只写正文，人物情感靠动作与潜台词显现，不出现"他心想""她回忆起"式的直白总结；
- ${outputLengthRequirement}`

const costlyChoiceSceneInstruction = `【创作任务：选择】
情境：南方临江小镇，暴雨连降三日，上游水库决定两小时后开闸泄洪。方迟（男，38 岁）是镇里老街片区的防汛疏散小组长，负责劝离低洼地段的住户；九岁的女儿方小满在河对岸参加暑期夏令营，连接两岸的桥已在限行，广播说一小时后封桥。妻子在电话里催他立刻过桥接女儿，而老街深处独居的卢大爷还在守店搬货，拒不撤离，片区花名册上只剩下他这一户没有签离。

请写泄洪前这一个小时，让代价在场景里真实发生。要求：
- 展示方迟在两件都不能辜负的责任之间做选择的过程，选择发生在动作中而非内心独白里；
- 至少出现三次与"时间"有关的物件细节（水位标尺、泄洪广播、桥闸栏杆、手电筒、对讲机）推动情节；
- 无论他最终走向哪一边，都必须让另一边付出可感知的具体代价，且这个代价当场显现；
- 与卢大爷的对话写足潜台词，谁都不把害怕直接说出口；不出现任何事后说明或内心总结句；
- ${outputLengthRequirement}`

const limitedRevealSceneInstruction = `【创作任务：有限视角揭示】
情境：旧城街角。陈见山（男，30 岁）在"槐安旧书店"做店员。街对面"阿绣面馆"的老板娘阿绣（35 岁）每天打烊前来买一份晚报，雷打不动；更奇怪的是，每晚七点面馆总会多出一碗牛肉面，阿绣却从不解释。陈见山视角有限，读者和他一样只看见这些日常。

请以陈见山的有限视角写一场戏，让一个改变两人关系的事实被逐渐显露，但陈见山本人最后才隐约明白。可自行组织线索：那碗多出的面、一本旧书里夹的挂号单、阿绣系围裙时露出的手腕，或某个固定的日子。要求：
- 信息必须通过可见细节一层层给出，严禁旁白直接揭示真相；
- 让陈见山对阿绣的解读与真实情况错位（他以为的善意或记性差，与真实缘由不同）；
- 结尾停在"他仍不完全确定"或"刚刚明白"的瞬间即可，不必说破；
- 只写正文，${outputLengthRequirement}`

export const sceneInstructions: Record<SceneTaskId, string> = {
  reunion: reunionSceneInstruction,
  'costly-choice': costlyChoiceSceneInstruction,
  'limited-reveal': limitedRevealSceneInstruction,
}

export const continuityCharacters = `【人物档案】
沈砚：男，44 岁，瓷镇文物修复师。寡言，习惯用做事代替说话。
周闻溪：女，42 岁，植物学家，沈砚之妻。七年前雨季在青埂垭调查崖墓壁画时失踪，官方结论为意外坠崖，遗体未寻获。
许照：女，17 岁，沈砚与周闻溪的女儿。暑假后升高三，性子执拗，会修摩托车。`

export const continuityFacts = `【事实表】
1. 周闻溪失踪前从青埂垭寄回一封信，信里只有一片压干的报岁兰花瓣和一句"等雨季再来"；沈砚从未把信给许照看。
2. 沈砚每年雨季都会独自去青埂垭住几天，名义是"补采植物标本"。
3. 家里灶台边挂着一只旧铜风铃，铃舌是周闻溪用一枚弹壳磨的，据说只在雨季的南风里会响。
4. 许照不知道信与花瓣的事，只隐约觉得父亲每年雨季都要出门"出差"。
5. 青埂垭崖壁上有一道被藤蔓遮住的旧凿痕，据说与明清年间一次封洞有关。`

export const continuityOpening = `【开篇场景】
雨下到第三天傍晚，青埂垭下的水文站就只剩一盏灯还亮着。沈砚坐在灯下修一只被水泡松的铜铃——不是家里那只，是站长老周从崖壁洞里掏出来的。风从河面灌进来，他搁下锉刀去关窗，窗台上多出一双沾满泥的白色运动鞋。许照背着湿透的帆布包站在门口，刘海贴在额头上，说："爸，我摩托车坏在半路了。"`

export const continuityStageTasks: Record<ContinuationStep, string> = {
  1: `请续写第一段：许照擅自跟来，父女在雨夜的水文站里围绕"你为什么会来"与"我为什么不能来"展开，谁都没有把真正的原因说出口。让一个与周闻溪有关的物件（铜铃、花瓣、标本夹、信）第一次在场出现并改变两人的动作。${outputLengthRequirement}`,
  2: `承接你自己上一段生成的正文续写第二段：雨夜之后，父女沿崖壁小路上行，那道被藤蔓遮住的旧凿痕在渗水后显露出痕迹；许照在途中发现一件她不该知道的东西，父女间维持多年的默契第一次出现裂痕。让"等雨季再来"这句旧话以某种可见的形式被重新提起（可以是一张纸、一行刻字、一截别在标本册里的花瓣）。${outputLengthRequirement}`,
  3: `承接你自己上一段生成的正文续写第三段并收束本次续写：在旧凿痕处，父女面临一个具体的决定——是撬开被藤蔓封住的洞口一探究竟，还是按许照的意愿就此下山；决定必须当场做出并付出可见的代价。让铜风铃的响声（或它的缺席）成为收束的意象。${outputLengthRequirement}`,
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Stable, dependency-free serialization of the fixture snapshot for hashing. */
export function fixtureSnapshot(): {
  schemaVersion: 1
  fixtureVersion: number
  systemPrompt: string
  scenes: Record<SceneTaskId, string>
  continuity: {
    characters: string
    facts: string
    opening: string
    stages: Record<ContinuationStep, string>
  }
} {
  return {
    schemaVersion: 1,
    fixtureVersion: evaluationFixtureVersion,
    systemPrompt: evaluationSystemPrompt,
    scenes: sceneInstructions,
    continuity: {
      characters: continuityCharacters,
      facts: continuityFacts,
      opening: continuityOpening,
      stages: continuityStageTasks,
    },
  }
}

export function serializeFixtures(): string {
  return `${JSON.stringify(fixtureSnapshot(), null, 2)}\n`
}

export function currentFixtureHash(): string {
  return sha256Hex(serializeFixtures())
}

/** Compose the deterministic user prompt for a scene task. */
export function buildSceneUserPrompt(taskId: SceneTaskId): string {
  return sceneInstructions[taskId]
}

export const continuityFixedBrief = `${continuityCharacters}

${continuityFacts}

${continuityOpening}`

function historyBlock(segments: readonly string[]): string {
  return segments
    .map(
      (segment, index) =>
        `【你此前生成的第 ${index + 1} 段正文，只供衔接，不要复述或改写】\n${segment}`,
    )
    .join('\n\n')
}

/**
 * Compose the deterministic user prompt for one three-step continuation.
 * Step 1 starts from the fixed characters/facts/opening. Every later step
 * keeps the SAME fixed brief AND the model's own full preceding history (all
 * previous segments, in order) plus that step's fixed stage brief.
 */
export function buildContinuationUserPrompt(
  step: ContinuationStep,
  previousSegments: readonly string[] = [],
): string {
  const stage = continuityStageTasks[step]
  if (step === 1) {
    if (previousSegments.length !== 0) {
      throw new Error(
        'continuation step 1 must not receive previous segments',
      )
    }
    return `${continuityFixedBrief}\n\n${stage}`
  }
  if (previousSegments.length !== step - 1) {
    throw new Error(
      `continuation step ${step} requires exactly ${step - 1} previous segments from the same model`,
    )
  }
  return `${continuityFixedBrief}\n\n${historyBlock(previousSegments)}\n\n${stage}`
}

export function buildUserPrompt(
  taskId: string,
  kind: EvaluationTaskKind,
  step: ContinuationStep | null,
  previousSegments: readonly string[] = [],
): string {
  if (kind === 'scene') {
    return buildSceneUserPrompt(taskId as SceneTaskId)
  }
  if (kind === 'continuation') {
    if (taskId !== continuityTaskId || step === null) {
      throw new Error(`invalid continuation attempt definition: ${taskId}`)
    }
    return buildContinuationUserPrompt(step, previousSegments)
  }
  throw new Error(`unknown task kind: ${kind}`)
}

export function promptHash(systemPrompt: string, userPrompt: string): string {
  return sha256Hex(`${systemPrompt}\u0000${userPrompt}`)
}
