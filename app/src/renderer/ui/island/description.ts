import type { JudgeModeInfo, JudgeModeSummary } from '../../../shared/judgeMode'
import type { ProblemConfig } from '../../../shared/problem'
import { selectedCheckerKind } from '../../../shared/checkerSelection'

const NAMES: Record<string, string> = {
    standard: '普通运行',
    spj: '普通运行',
    interactive: '交互评测',
    grader: '普通运行'
}

/** Editable limits are already in memory; checking files must not delay or revert them. */
export function panelDescription(
    problem: ProblemConfig,
    modes: JudgeModeSummary[],
    description?: JudgeModeInfo | null
): JudgeModeInfo {
    const modeId =
        ['standard', 'spj'].includes(problem.mode) && problem.grader
            ? 'grader'
            : problem.mode === 'standard' && problem.checker.kind === 'custom'
              ? 'spj'
              : problem.mode
    const current = description?.modeId === modeId ? description : undefined
    const modeName = NAMES[modeId] ?? current?.modeName ?? modes.find((mode) => mode.id === modeId)?.name ?? modeId
    const checking =
        modeId === 'interactive'
            ? '由交互器判定'
            : ['standard', 'spj', 'grader'].includes(modeId)
              ? selectedCheckerKind(problem) === 'custom'
                  ? '自定义 checker'
                  : '内置比较'
              : undefined
    return {
        modeId,
        modeName,
        badges: [
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
            ...(checking ? [{ label: '结果检查', value: checking }] : []),
            ...(current?.badges.filter((badge) => !['模式', '限制', '文件 IO', '结果检查'].includes(badge.label)) ?? [])
        ]
    }
}
