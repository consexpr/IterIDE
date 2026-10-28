import { checkerSettingsPatch, selectedCheckerKind } from '../../../shared/checkerSelection'
import { resolveBuiltin, type CheckerLayout, type CheckerValue, type ProblemConfig } from '../../../shared/problem'
import { editProblemSettings } from '../../actions/tests'
import { store } from '../../state/app'
import type { ModeBadge } from '../../../shared/judgeMode'

const LAYOUTS: { value: CheckerLayout; label: string }[] = [
    { value: 'tokens', label: '忽略空白' },
    { value: 'lines', label: '逐行' },
    { value: 'exact', label: '完全一致' }
]
const VALUES: { value: CheckerValue; label: string }[] = [
    { value: 'text', label: '正常匹配' },
    { value: 'float4', label: '浮点 1e-4' },
    { value: 'float6', label: '浮点 1e-6' },
    { value: 'float9', label: '浮点 1e-9' },
    { value: 'yesno', label: 'YES / NO' }
]
function selectBuiltin(
    sourcePath: string,
    problem: ProblemConfig,
    change: Partial<{ layout: CheckerLayout; value: CheckerValue }> = {}
): void {
    const next = { ...resolveBuiltin(problem.checker.builtin, problem.checker.value), ...change }
    editProblemSettings(
        sourcePath,
        checkerSettingsPatch(problem, {
            kind: 'builtin',
            builtin: next.layout,
            value: next.value
        })
    )
}

/** Comparison rules reveal inside the same capsule, without a native popup. */
export function BuiltinComparison({ sourcePath, problem }: { sourcePath: string; problem: ProblemConfig }) {
    const checker = resolveBuiltin(problem.checker.builtin, problem.checker.value)
    return (
        <div className="nvi-checker">
            <div className="nvi-chips" role="group" aria-label="空白处理">
                {LAYOUTS.map((c) => (
                    <button
                        key={c.value}
                        className={checker.layout === c.value ? 'is-on' : ''}
                        aria-pressed={checker.layout === c.value}
                        onClick={() => selectBuiltin(sourcePath, problem, { layout: c.value })}
                    >
                        {c.label}
                    </button>
                ))}
            </div>
            <div className="nvi-chips" role="group" aria-label="内容比较">
                {VALUES.map((c) => (
                    <button
                        key={c.value}
                        className={checker.value === c.value ? 'is-on' : ''}
                        aria-pressed={checker.value === c.value}
                        onClick={() => selectBuiltin(sourcePath, problem, { value: c.value })}
                    >
                        {c.label}
                    </button>
                ))}
            </div>
        </div>
    )
}

export function CheckerKindButtons({ sourcePath, problem }: { sourcePath: string; problem: ProblemConfig }) {
    const kind = selectedCheckerKind(problem)
    return (
        <div className="nvi-seg nvi-checker-kind" role="group" aria-label="结果检查">
            <button
                className={kind === 'builtin' ? 'is-on' : ''}
                aria-pressed={kind === 'builtin'}
                onClick={() => selectBuiltin(sourcePath, problem)}
            >
                内置比较
            </button>
            <button
                className={kind === 'custom' ? 'is-on' : ''}
                aria-pressed={kind === 'custom'}
                onClick={() => {
                    if (kind !== 'custom')
                        editProblemSettings(sourcePath, checkerSettingsPatch(problem, { kind: 'custom' }))
                }}
            >
                checker
            </button>
        </div>
    )
}

/** Only active controls are shown; switching does not discard the other checker's settings. */
export function CheckerSettings({
    sourcePath,
    problem,
    protocol
}: {
    sourcePath: string
    problem: ProblemConfig
    protocol?: ModeBadge
}) {
    return selectedCheckerKind(problem) === 'builtin' ? (
        <BuiltinComparison sourcePath={sourcePath} problem={problem} />
    ) : (
        <div className="nvi-file">
            <code title={problem.checker.path} className={!problem.checker.path ? 'nvi-description-error' : ''}>
                {problem.checker.path?.split(/[\\/]/).pop() || '未设置 checker'}
            </code>
            {protocol && problem.checker.path && (
                <span className="nvi-tag" title={protocol.detail}>
                    {protocol.value}
                </span>
            )}
            <button onClick={() => store.set({ dialog: { kind: 'checkerCode', sourcePath } })}>
                {problem.checker.path ? '编辑' : '设置'}
            </button>
        </div>
    )
}
