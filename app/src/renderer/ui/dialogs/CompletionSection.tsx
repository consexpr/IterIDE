import type { CompletionSettings, EditorSettings } from '../../../shared/settings'
import { updateSettings } from '../../actions/settings'
import { Slider } from '../controls/Slider'
import { Icon } from '../Icon'
import { Field, Switch } from './Modal'
import { aiCompletionSettings, type AiCompletionSettings } from '../../../shared/inlineAi'

const set = (p: Partial<CompletionSettings>): void =>
    void updateSettings({ editor: { completion: p } as unknown as EditorSettings })

/** Placeholders `$1`, `${1:x}` must be unique, or Monaco links them into several cursors. */
function hasRepeatedPlaceholder(body: string): boolean {
    const ids = [...body.matchAll(/\$\{?(\d+)/g)].map((m) => m[1]).filter((n) => n !== '0')
    return new Set(ids).size !== ids.length
}

export function CompletionSection({ c }: { c: CompletionSettings }) {
    const ai = aiCompletionSettings(c.ai)
    const setAi = (p: Partial<AiCompletionSettings>): void => set({ ai: { ...ai, ...p } })
    const snippets = c.snippets
    const edit = (i: number, patch: Partial<CompletionSettings['snippets'][number]>): void =>
        set({ snippets: snippets.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
    return (
        <>
            <div className="nv-switches">
                <Switch checked={c.model === true} onChange={(v) => set({ model: v })} label="Model" />
                <Switch checked={ai.enabled} onChange={(v) => setAi({ enabled: v })} label="FIM 单次补全" />
                <Switch
                    checked={c.showCompletionWhileInput}
                    onChange={(v) => set({ showCompletionWhileInput: v })}
                    label="输入时弹出"
                />
                <Switch checked={c.acceptOnEnter} onChange={(v) => set({ acceptOnEnter: v })} label="Enter 确认补全" />
                <Switch checked={c.sortByScope} onChange={(v) => set({ sortByScope: v })} label="按作用域排序" />
                <Switch checked={c.recordUsage} onChange={(v) => set({ recordUsage: v })} label="记住常用项" />
                <Switch checked={c.showKeywords} onChange={(v) => set({ showKeywords: v })} label="包含关键字" />
                <Switch checked={c.ignoreCase} onChange={(v) => set({ ignoreCase: v })} label="忽略大小写" />
                <Switch checked={c.appendFunc} onChange={(v) => set({ appendFunc: v })} label="函数自动加括号" />
                <Switch
                    checked={c.hideSymbolsStartsWithUnderLine}
                    onChange={(v) => set({ hideSymbolsStartsWithUnderLine: v })}
                    label="隐藏 _ 开头的符号"
                />
                <Switch
                    checked={c.hideSymbolsStartsWithTwoUnderLine}
                    onChange={(v) => set({ hideSymbolsStartsWithTwoUnderLine: v })}
                    label="隐藏 __ 开头的符号"
                />
            </div>
            <div className="nv-sliders">
                <Slider
                    label="最少字符"
                    value={c.minCharRequired}
                    min={0}
                    max={5}
                    step={1}
                    defaultValue={1}
                    onChange={(minCharRequired) => set({ minCharRequired })}
                />
            </div>

            {ai.enabled && (
                <>
                    <Field label="API Key">
                        <input
                            className="nv-mono-input"
                            spellCheck={false}
                            value={ai.apiKey}
                            onChange={(e) => setAi({ apiKey: e.target.value })}
                        />
                    </Field>
                    <Field label="模型">
                        <input
                            className="nv-mono-input"
                            spellCheck={false}
                            value={ai.model}
                            onChange={(e) => setAi({ model: e.target.value })}
                        />
                    </Field>
                    <Field label="Effort">
                        <input
                            className="nv-mono-input"
                            spellCheck={false}
                            value={ai.effort}
                            onChange={(e) => setAi({ effort: e.target.value })}
                        />
                    </Field>
                </>
            )}

            <Field label="代码片段">
                <div className="nv-snippets">
                    {snippets.map((s, i) => (
                        <div key={i} className="nv-snippet">
                            <input
                                className="nv-mono-input"
                                value={s.trigger}
                                placeholder="fori"
                                onChange={(e) => edit(i, { trigger: e.target.value.trim() })}
                            />
                            <textarea
                                className="nv-mono-input"
                                spellCheck={false}
                                value={s.body}
                                placeholder={'for (int i = 0; i < ${1:n}; i++) {\n\t$0\n}'}
                                onChange={(e) => edit(i, { body: e.target.value })}
                            />
                            {hasRepeatedPlaceholder(s.body) && (
                                <span className="v-text-wa nv-snippet-warn">占位符编号重复</span>
                            )}
                            <button
                                className="nv-icon-btn"
                                onClick={() => set({ snippets: snippets.filter((_, j) => j !== i) })}
                                title="删除"
                            >
                                <Icon name="trash" size={13} />
                            </button>
                        </div>
                    ))}
                    <button
                        className="nv-btn is-quiet"
                        onClick={() => set({ snippets: [...snippets, { trigger: '', body: '' }] })}
                    >
                        <Icon name="plus" size={13} /> 添加片段
                    </button>
                </div>
            </Field>
        </>
    )
}
