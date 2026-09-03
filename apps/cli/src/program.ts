import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import type { CandidateEvaluation } from '@writex/contracts'
import { defaultQualityGate, scoreQuality } from '@writex/quality'
import { initNovelWorkspace, loadNovelConfig } from '@writex/workspace'

export type WriteFn = (chunk: string) => unknown

const chapterName = /^chapter-\d+\.md$/

/** Count regular chapter files directly inside `<root>/manuscript`; 0 when the directory is missing. */
async function countChapters(root: string): Promise<number> {
  const manuscriptDir = join(root, 'manuscript')
  let count = 0
  try {
    const entries = await readdir(manuscriptDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && chapterName.test(entry.name)) {
        count += 1
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
  return count
}

interface StatusOptions {
  json?: boolean
}

export function createProgram(writeOut: WriteFn = process.stdout.write.bind(process.stdout)): Command {
  const program = new Command()

  program
    .name('writex')
    .description('writex 基础命令行：初始化长篇小说工作区、查询作品状态、评估稿件质量')
    .showHelpAfterError()

  program.configureOutput({ writeOut: (text: string) => writeOut(text) })

  const novel = program.command('novel').description('长篇小说工作区命令')

  novel
    .command('init <path>')
    .description('在 <path> 处初始化一个新的长篇小说工作区')
    .requiredOption('--title <title>', '小说标题')
    .option('--style <style>', '文风预设', 'youth-mythic-melancholy')
    .action(async (target: string, options: { title: string; style: string }) => {
      const root = resolve(target)
      await initNovelWorkspace(root, { title: options.title, style: options.style })
      writeOut(`Initialized ${root}\n`)
    })

  program
    .command('status [path]')
    .description('读取工作区配置并统计已完成的章节数')
    .option('--json', '以 JSON 格式输出')
    .action(
      async (
        pathOrOptions: string | StatusOptions | undefined,
        optionsArg?: StatusOptions,
      ) => {
        // Commander omits absent optional arguments in some versions, so the
        // options object can arrive as the first handler parameter.
        const options: StatusOptions =
          typeof pathOrOptions === 'string' || pathOrOptions === undefined
            ? optionsArg ?? {}
            : pathOrOptions
        const requested = typeof pathOrOptions === 'string' ? pathOrOptions : '.'
        const root = resolve(requested)
        const config = await loadNovelConfig(root)
        const chapters = await countChapters(root)
        if (options.json) {
          writeOut(`${JSON.stringify({ root, title: config.title, style: config.style, chapters })}\n`)
        } else {
          writeOut(`${config.title}: ${chapters} chapters\n`)
        }
      },
    )

  const quality = program.command('quality').description('稿件质量评估命令')

  quality
    .command('score <evaluation>')
    .description('对 CandidateEvaluation JSON 文件打分')
    .option('--json', '以 JSON 格式输出')
    .action(async (evaluationPath: string, options: { json?: boolean }) => {
      const text = await readFile(evaluationPath, 'utf8')
      const evaluation: CandidateEvaluation = JSON.parse(text) as CandidateEvaluation
      const decision = scoreQuality(evaluation, defaultQualityGate)
      if (options.json) {
        writeOut(`${JSON.stringify(decision)}\n`)
      } else {
        writeOut(`Score ${decision.total}: ${decision.passed ? 'PASS' : 'FAIL'}\n`)
      }
    })

  return program
}
