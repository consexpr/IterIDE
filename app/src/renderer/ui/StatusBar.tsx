import { useEffect, useState, useSyncExternalStore } from 'react'
import { updateSettings } from '../actions/settings'
import { getModelStats, subscribeModelStats } from '../lang/modelStats'
import { aiCompletionSettings } from '../../shared/inlineAi'
import { getInlinePending, subscribeInlineStatus } from '../lang/inlineStatus'
import { countTokens } from '../lang/tokenCount'
import { allThemes, findTheme } from '../themes/apply'
import { activeFile, useApp } from '../state/app'
import { useCursor } from '../state/cursor'
import { useSessionError } from '../state/sessionHealth'
import { saveSessionNow } from '../actions/session'

const MAX_COUNTED_CHARS = 2_000_000

/** Lexical tokens in the active file, recounted shortly after the text stops changing. */
function useTokenCount(): number | null {
    const model = useApp((s) => activeFile(s)?.model)
    const [count, setCount] = useState<number | null>(null)
    useEffect(() => {
        if (!model) {
            setCount(null)
            return
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const update = (): void =>
            setCount(model.getValueLength() > MAX_COUNTED_CHARS ? null : countTokens(model.getValue()))
        update()
        const subscription = model.onDidChangeContent(() => {
            clearTimeout(timer)
            timer = setTimeout(update, 200)
        })
        return () => {
            clearTimeout(timer)
            subscription.dispose()
        }
    }, [model])
    return count
}

export function StatusBar() {
    const lsp = useApp((s) => s.lspStatus)
    const cursor = useCursor()
    const sessionError = useSessionError()
    const hasFile = useApp((s) => s.activePath !== null)
    const std = useApp((s) => /-std=(\S+)/.exec(s.settings.toolchain.flags)?.[1] ?? 'c++')
    const themeId = useApp((s) => s.settings.theme)
    const tokens = useTokenCount()
    const modelOn = useApp((s) => s.settings.editor.completion.model === true && s.settings.editor.semanticCompletion)
    const fim = aiCompletionSettings(useApp((s) => s.settings.editor.completion.ai))
    const fimEnabled = fim.enabled && !!fim.apiKey
    const fimPending = useSyncExternalStore(subscribeInlineStatus, getInlinePending)
    const fimLabel = fimEnabled ? 'FIM Manual' : 'FIM Off'
    const model = useSyncExternalStore(subscribeModelStats, getModelStats)
    const cycleTheme = (): void => {
        const list = allThemes()
        const i = list.findIndex((t) => t.id === themeId)
        void updateSettings({ theme: list[(i + 1) % list.length].id })
    }
    return (
        <footer className="nv-status">
            {sessionError && (
                <button
                    className="nv-session-error"
                    title={`${sessionError}；点击重试`}
                    onClick={() => void saveSessionNow().catch(() => {})}
                >
                    会话备份失败，重试
                </button>
            )}
            <span
                className={`nv-status-item lsp-${lsp}`}
                title={
                    lsp === 'clangd'
                        ? 'clangd 提供补全与实时诊断'
                        : lsp === 'fallback'
                          ? 'clangd 不可用：使用本地补全 + g++ 语法检查'
                          : ''
                }
            >
                <span className="nv-dot" />
                {lsp === 'clangd' ? 'clangd' : lsp === 'fallback' ? 'g++ 语法检查' : '语言服务启动中'}
            </span>
            {tokens !== null && <span className="nv-status-item">Token {tokens.toLocaleString()}</span>}
            <span
                className={`nv-status-item ${modelOn ? '' : 'is-off'}`}
                title={
                    modelOn
                        ? `调用 ${model.calls} · 复用 ${model.reused} · 未返回 ${model.failed}` +
                          (model.calls ? ` · 平均 ${Math.round(model.totalMs / model.calls)}ms` : '')
                        : ''
                }
            >
                <span>Model</span>
                {modelOn ? (
                    <>
                        <span>{model.lastMs === null ? '—' : Math.round(model.lastMs) + ' ms'}</span>
                    </>
                ) : (
                    <span>Off</span>
                )}
            </span>
            <span className={`nv-status-item ${fimEnabled ? '' : 'is-off'}`}>
                {fimLabel}
                {fimEnabled && fimPending ? ' - Requesting' : ''}
            </span>
            <span className="nv-flex" />
            {hasFile && (
                <>
                    <span className="nv-status-item">
                        行 {cursor.line}，列 {cursor.col}
                    </span>
                    <span className="nv-status-item">
                        {std.toUpperCase().replace('C++', 'C++ ').replace('GNU++', 'GNU++ ')}
                    </span>
                    <span className="nv-status-item">UTF-8 · LF</span>
                </>
            )}
            <button className="nv-status-item is-button" onClick={cycleTheme} title="切换主题">
                {findTheme(themeId).name}
            </button>
        </footer>
    )
}
