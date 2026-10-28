import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModeBadge, JudgeModeInfo } from '../../../../shared/judgeMode'
import type { ModeContext, ModePaths, ModeProblem, ModeRunContext } from '../registry'
import { graderInputs } from '../../../problem/grader'
import { problemDir } from '../../../problem/store'
import { inspectCheckerSource } from '../../../../shared/checkerSource'
import { activeJudgeTools } from '../../../../shared/checkerSelection'

export function solutionBuild({ sourcePath, problem }: ModePaths) {
    const units = graderInputs(sourcePath, problem.grader)
    const toolDirs = activeJudgeTools(problem).flatMap((tool) =>
        tool?.path
            ? [tool.path, ...(tool.files ?? [])].map((file) =>
                  path.dirname(
                      path.resolve(
                          tool.relativeTo === 'source' ? path.dirname(sourcePath) : problemDir(sourcePath),
                          file
                      )
                  )
              )
            : []
    )
    return {
        ...units,
        includeDirs: [
            ...new Set([...units.includeDirs, ...units.sources.map((file) => path.dirname(file)), ...toolDirs])
        ]
    }
}
export async function prepareShared(
    ctx: ModeContext,
    requireChecker = false
): Promise<{ runner?: string; checker?: () => Promise<string> }> {
    const runner = await ctx.runner()
    let prepared: Promise<string> | undefined
    // Build a checker only when a selected test actually compares output. A run-only
    // case must not fail just because an unused SPJ file is missing or cannot compile.
    const checker =
        requireChecker || ctx.problem.checker.kind === 'custom'
            ? () => (prepared ??= ctx.prepareTool(ctx.problem.checker.path ?? '', ctx.problem.checker.relativeTo))
            : undefined
    return { runner, checker }
}
export async function runShared(ctx: ModeRunContext) {
    const tools = ctx.prepared as Awaited<ReturnType<typeof prepareShared>>
    return ctx.runShared({
        runner: tools.runner,
        checker: ctx.test.compareOutput === false ? undefined : await tools.checker?.()
    })
}
export async function fileBadge(label: string, file: string): Promise<ModeBadge> {
    file = path.resolve(file)
    const exists = await fs.stat(file).then(
        (s) => s.isFile(),
        () => false
    )
    return {
        label,
        value: path.basename(file),
        file,
        ...(exists ? {} : { tone: 'error' as const, detail: '文件不存在' })
    }
}
export async function toolBadges(
    label: string,
    tool: { path?: string; relativeTo?: 'source' } | undefined,
    src: string
): Promise<ModeBadge[]> {
    if (!tool?.path) return [{ label, value: '未配置', tone: 'error' }]
    const file = path.resolve(tool.relativeTo === 'source' ? path.dirname(src) : problemDir(src), tool.path)
    const badges = [await fileBadge(label, file)]
    // An n-check checker (docs/n-check.md) does not use testlib, so there is no header to report.
    const source = /\.(?:c|cc|cpp|cxx)$/i.test(file) ? await fs.readFile(file, 'utf8').catch(() => '') : ''
    const protocol = inspectCheckerSource(source)
    if (label === '检查器')
        badges.push({
            label: '协议',
            value: protocol.label,
            ...(protocol.kind === 'invalid'
                ? { tone: 'error' as const }
                : protocol.kind === 'unknown'
                  ? { tone: 'warn' as const }
                  : {}),
            detail: protocol.message
        })
    if (protocol.usesTestlib) {
        const header = await fileBadge('头文件', path.join(path.dirname(file), 'testlib.h'))
        if (header.tone === 'error') {
            header.tone = 'warn'
            header.detail = '同目录未找到 testlib.h，编译时使用内置版本'
        }
        badges.push(header)
    }
    return badges
}
export function describeBase(
    id: string,
    name: string,
    problem: ModeProblem,
    src: string,
    files: ModeBadge[] = []
): JudgeModeInfo {
    return {
        modeId: id,
        modeName: name,
        badges: [
            { label: '模式', value: name },
            ...files,
            {
                label: '限制',
                value: `${problem.timeLimit / 1000} s · ${problem.memoryLimit} MB`,
                detail: problem.tests.some((test) => test.timeLimit !== undefined) ? '部分测试使用单独时限' : undefined
            },
            {
                label: '文件 IO',
                value:
                    problem.mode !== 'interactive' && problem.fileIO.enabled
                        ? `${problem.fileIO.input} → ${problem.fileIO.output}`
                        : '标准输入输出'
            },
            { label: '数据', value: problem.tests.length ? `缓存 ${problem.tests.length} 组` : '暂无测试' }
        ]
    }
}
