import { useMemo, useRef, useState } from 'react'
import type { CheckerRef } from '../../shared/problem'
import { outputDiff, showWhitespace } from './outputDiff'

export function OutputComparison({
    actual,
    expected,
    checker,
    truncated,
    whitespace,
    onWhitespace
}: {
    actual: string
    expected: string
    checker?: CheckerRef
    truncated?: boolean
    whitespace: boolean
    onWhitespace(value: boolean): void
}) {
    const diff = useMemo(() => outputDiff(actual, expected, checker), [actual, expected, checker])
    const [selected, setSelected] = useState(0)
    const section = useRef<HTMLDetailsElement>(null)
    const current = Math.min(selected, Math.max(0, diff.differences.length - 1))
    const center = diff.differences[current] ?? 0
    const start = Math.max(0, center - 3),
        end = Math.min(diff.rows.length, start + 18)
    const text = (value: string | undefined): string => {
        if (value === undefined) return '（无）'
        if (!value) return '（空行）'
        const short = value.length > 1000 ? value.slice(0, 1000) + '…' : value
        return whitespace ? showWhitespace(short) : short
    }
    const layout = {
        tokens: '忽略空白，按词元比较',
        lines: '按行比较，忽略行尾空白及末尾空行',
        exact: '精确比较，统一换行符'
    }[diff.rule.layout]
    const value =
        diff.rule.value === 'text'
            ? ''
            : diff.rule.value === 'yesno'
              ? '；忽略大小写'
              : `；浮点容差 1e-${diff.rule.value.slice(5)}`
    return (
        <div className="nv-output-comparison">
            <div className="nv-diff-actions">
                <button
                    className="nv-mini"
                    disabled={!diff.differences.length}
                    onClick={() => {
                        setSelected(0)
                        if (section.current) {
                            section.current.open = true
                            section.current.scrollIntoView({ block: 'nearest' })
                        }
                    }}
                >
                    首个差异
                </button>
                <label>
                    <input
                        type="checkbox"
                        checked={whitespace}
                        onChange={(event) => onWhitespace(event.target.checked)}
                    />
                    显示空白
                </label>
            </div>
            <details ref={section}>
                <summary>查看差异（{diff.differences.length} 处）</summary>
                <p className="nv-diff-rule">
                    {diff.authoritative ? '当前规则：' + layout + value : '文本对比仅辅助定位，判定以检查器结果为准。'}
                </p>
                {(truncated || diff.limited) && (
                    <p className="nv-diff-rule">仅对比当前预览的前 100,000 字符、2,000 项，完整结论以评测结果为准。</p>
                )}
                {diff.simplified && <p className="nv-diff-rule">差异较多，使用局部对齐。</p>}
                {!diff.differences.length ? (
                    <p className="nv-diff-rule">当前预览按上述规则没有差异。</p>
                ) : (
                    <>
                        <nav className="nv-diff-actions" aria-label="差异定位">
                            <button className="nv-mini" disabled={!current} onClick={() => setSelected(current - 1)}>
                                上一处
                            </button>
                            <span role="status">
                                {current + 1} / {diff.differences.length}
                            </span>
                            <button
                                className="nv-mini"
                                disabled={current + 1 >= diff.differences.length}
                                onClick={() => setSelected(current + 1)}
                            >
                                下一处
                            </button>
                        </nav>
                        <div className="nv-diff-rows">
                            {diff.rows.slice(start, end).map((row, index) => (
                                <div
                                    key={start + index}
                                    className={`nv-diff-row is-${row.kind}`}
                                    data-current={start + index === center || undefined}
                                >
                                    <span className="nv-diff-kind">
                                        {
                                            { same: '相同', changed: '不同', missing: '缺少输出', extra: '多余输出' }[
                                                row.kind
                                            ]
                                        }
                                    </span>
                                    <div>
                                        <span>
                                            期望 {row.expected ? `${row.expected.line}:${row.expected.column}` : ''}
                                        </span>
                                        <pre>{text(row.expected?.text)}</pre>
                                    </div>
                                    <div>
                                        <span>实际 {row.actual ? `${row.actual.line}:${row.actual.column}` : ''}</span>
                                        <pre>{text(row.actual?.text)}</pre>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <p className="nv-diff-rule">
                            显示对齐后的第 {start + 1}–{end} 项，共 {diff.rows.length} 项。
                        </p>
                    </>
                )}
            </details>
        </div>
    )
}
