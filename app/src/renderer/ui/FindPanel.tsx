import { useEffect, useLayoutEffect, useRef } from 'react'
import { closeSearch, nextSearchMatch, replaceSearchMatch, searchState, updateSearch } from '../editor/search'
import { editorRef } from '../editor/instance'
import { useStore } from '../state/store'
import { store } from '../state/app'
import { Icon } from './Icon'
import '../styles/find.css'
import { useFindMotion } from './findMotion'

/** An independent find/replace form: its inputs never pass through Monaco's widget event handlers. */
export function FindPanel() {
    const state = useStore(searchState, (s) => s)
    const motion = useFindMotion(state.open)
    const find = useRef<HTMLInputElement>(null),
        replacement = useRef<HTMLInputElement>(null)
    const composing = useRef(false)
    useLayoutEffect(() => {
        if (!state.open) {
            composing.current = false
            return
        }
        const input = state.focus === 'replace' ? replacement.current : find.current
        input?.focus()
        input?.select()
    }, [state.open, state.focusRequest])
    useEffect(() => {
        if (!state.open) return
        const escape = (event: KeyboardEvent): void => {
            if (
                event.defaultPrevented ||
                event.isComposing ||
                event.keyCode === 229 ||
                event.key !== 'Escape' ||
                store.get().dialog ||
                store.get().accountOpen ||
                !editorRef.editor?.hasTextFocus()
            )
                return
            event.preventDefault()
            event.stopPropagation()
            closeSearch()
        }
        window.addEventListener('keydown', escape)
        return () => window.removeEventListener('keydown', escape)
    }, [state.open])
    if (!motion.present) return null
    const disabled = state.pending || !state.count || !!state.error
    return (
        <section
            ref={motion.ref}
            className="nv-find"
            data-state={state.open ? 'open' : 'closing'}
            data-regex={state.regex}
            data-error={!!state.error}
            inert={!state.open}
            aria-hidden={!state.open}
            role="search"
            aria-label="查找与替换"
            onKeyDown={(event) => {
                if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    closeSearch()
                } else if (
                    event.key === 'Enter' &&
                    event.target instanceof HTMLInputElement &&
                    event.target.type !== 'checkbox'
                ) {
                    event.preventDefault()
                    event.stopPropagation()
                    if (event.target === replacement.current) replaceSearchMatch(event.ctrlKey || event.metaKey)
                    else nextSearchMatch(event.shiftKey ? -1 : 1)
                }
            }}
        >
            <div className="nv-find-row">
                <input
                    ref={find}
                    aria-label="查找内容"
                    placeholder="查找"
                    value={state.query}
                    spellCheck={false}
                    onCompositionStart={() => {
                        composing.current = true
                    }}
                    onCompositionEnd={(e) => {
                        composing.current = false
                        updateSearch({ query: e.currentTarget.value })
                    }}
                    onChange={(e) => updateSearch({ query: e.target.value }, composing.current)}
                />
                <span className="nv-find-count" role="status">
                    {state.pending ? '…' : `${state.index + 1}/${state.count}${state.limited ? '+' : ''}`}
                </span>
                <button
                    className="nv-icon-btn"
                    disabled={disabled}
                    aria-label="上一个"
                    title="上一个（Shift Enter）"
                    onClick={() => nextSearchMatch(-1)}
                >
                    <Icon name="chevronDown" size={14} />
                </button>
                <button
                    className="nv-icon-btn"
                    disabled={disabled}
                    aria-label="下一个"
                    title="下一个（Enter）"
                    onClick={() => nextSearchMatch(1)}
                >
                    <Icon name="chevronDown" size={14} />
                </button>
                <button className="nv-icon-btn" aria-label="关闭查找" title="关闭（Esc）" onClick={closeSearch}>
                    <Icon name="x" size={14} />
                </button>
            </div>
            <div className="nv-find-row">
                <input
                    ref={replacement}
                    aria-label="替换内容"
                    placeholder="替换为"
                    value={state.replacement}
                    spellCheck={false}
                    onCompositionStart={() => {
                        composing.current = true
                    }}
                    onCompositionEnd={() => {
                        composing.current = false
                    }}
                    onChange={(e) => updateSearch({ replacement: e.target.value })}
                />
                <button className="nv-mini" disabled={disabled || state.readOnly} onClick={() => replaceSearchMatch()}>
                    替换
                </button>
                <button
                    className="nv-mini"
                    disabled={disabled || state.readOnly || state.limited}
                    onClick={() => replaceSearchMatch(true)}
                >
                    全部替换
                </button>
            </div>
            <div className="nv-find-options">
                <label>
                    <input
                        type="checkbox"
                        checked={state.matchCase}
                        onChange={(e) => updateSearch({ matchCase: e.target.checked })}
                    />
                    区分大小写
                </label>
                <label>
                    <input
                        type="checkbox"
                        checked={state.wholeWord}
                        onChange={(e) => updateSearch({ wholeWord: e.target.checked })}
                    />
                    全词
                </label>
                <label>
                    <input
                        type="checkbox"
                        checked={state.regex}
                        onChange={(e) => updateSearch({ regex: e.target.checked })}
                    />
                    正则
                </label>
                {state.error && (
                    <span className="nv-find-error" role="alert">
                        {state.error}
                    </span>
                )}
            </div>
        </section>
    )
}
