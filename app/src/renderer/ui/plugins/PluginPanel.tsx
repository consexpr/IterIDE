// Renderer side of the plugin panel bridge (protocol: docs/plugin-api.md).
// A plugin page lives in a sandboxed iframe (no same-origin, no Node); it can only reach ITER
// through `iter:request` messages, which are answered here. State snapshots are pushed to it.
import { useEffect, useRef } from 'react'
import type { PanelInfo, PanelMethod, PanelState } from '../../../shared/plugin'
import { LEGACY_BRAND } from '../../../shared/legacyBrand'
import { runTests } from '../../actions/judge'
import { openFile } from '../../actions/files'
import { editorRef } from '../../editor/instance'
import { monaco } from '../../editor/monaco'
import { activeFile, isDebugging, store, toast, type AppState } from '../../state/app'

export const panelKey = (p: PanelInfo): string => `plugin:${p.pluginId}/${p.id}`

function themeVars(): Record<string, string> {
    const style = document.documentElement.style
    const out: Record<string, string> = {}
    for (let i = 0; i < style.length; i++) {
        const name = style.item(i)
        if (name.startsWith('--')) out[name] = style.getPropertyValue(name)
    }
    return out
}

function snapshot(s: AppState): PanelState {
    const f = activeFile(s)
    return {
        file: f ? { path: f.path, name: f.name } : null,
        problem: f?.problem ?? null,
        tests: f?.tests.map((t) => ({ id: t.id, name: t.name, enabled: t.enabled })) ?? [],
        results: Object.fromEntries(
            Object.entries(f?.results ?? {}).map(([id, r]) => [
                id,
                { verdict: r.verdict, timeMs: r.timeMs, memoryKb: r.memoryKb }
            ])
        ),
        debugging: isDebugging(s),
        theme: {
            id: s.settings.theme,
            kind: document.documentElement.dataset.kind === 'light' ? 'light' : 'dark',
            vars: themeVars()
        }
    }
}

async function handle(panel: PanelInfo, method: PanelMethod, args: unknown[]): Promise<unknown> {
    if (store.get().closing) throw new Error('正在保存并退出')
    switch (method) {
        case 'invoke':
            return window.iter.plugins.invoke(panel.pluginId, String(args[0]), args.slice(1))
        case 'getSource':
            return activeFile()?.model.getValue() ?? null
        case 'insertText': {
            const ed = editorRef.editor
            const sel = ed?.getSelection()
            if (!ed || !sel || ed.getOption(monaco.editor.EditorOption.readOnly)) throw new Error('编辑器不可写')
            ed.executeEdits(`plugin:${panel.pluginId}`, [
                { range: sel, text: String(args[0] ?? ''), forceMoveMarkers: true }
            ])
            return true
        }
        case 'openFile':
            return openFile(String(args[0]))
        case 'runTests':
            return runTests(Array.isArray(args[0]) ? (args[0] as string[]) : undefined)
        case 'toast': {
            const kind = args[1] === 'success' || args[1] === 'error' ? args[1] : 'info'
            toast(String(args[0] ?? ''), kind)
            return true
        }
        case 'setBadge':
            store.set((s) => ({
                pluginBadges: { ...s.pluginBadges, [panelKey(panel)]: args[0] ? String(args[0]) : null }
            }))
            return true
        default:
            throw new Error(`未知方法 ${String(method)}`)
    }
}

export function PluginPanel({ panel, visible }: { panel: PanelInfo; visible: boolean }) {
    const frame = useRef<HTMLIFrameElement>(null)

    useEffect(() => {
        const post = (msg: unknown): void => frame.current?.contentWindow?.postMessage(msg, '*')
        const pushState = (): void => {
            const state = snapshot(store.get())
            post({ type: 'iter:state', state })
            // Plugins may bundle the previous SDK instead of loading the current one.
            post({ type: `${LEGACY_BRAND}:state`, state })
        }

        const onMessage = (e: MessageEvent): void => {
            // only accept messages from this panel's own frame
            if (e.source !== frame.current?.contentWindow) return
            const m = e.data as { type?: string; id?: number; method?: PanelMethod; args?: unknown[] }
            if (
                (m?.type !== 'iter:request' && m?.type !== `${LEGACY_BRAND}:request`) ||
                typeof m.id !== 'number' ||
                !m.method
            )
                return
            const replyType = m.type === 'iter:request' ? 'iter:reply' : `${LEGACY_BRAND}:reply`
            handle(panel, m.method, Array.isArray(m.args) ? m.args : []).then(
                (value) => post({ type: replyType, id: m.id, ok: true, value }),
                (err: Error) =>
                    post({ type: replyType, id: m.id, ok: false, error: { message: err?.message ?? String(err) } })
            )
        }
        window.addEventListener('message', onMessage)

        // push a snapshot when something a panel may care about changes (cheap identity checks)
        let last: unknown[] = []
        const unsub = store.subscribe(() => {
            const s = store.get()
            const f = activeFile(s)
            const keys = [
                s.activePath,
                f?.problem,
                f?.tests,
                f?.results,
                s.debug.state.status,
                s.settings.theme,
                s.themeVersion
            ]
            if (keys.some((k, i) => k !== last[i])) {
                last = keys
                pushState()
            }
        })
        const el = frame.current
        el?.addEventListener('load', pushState)
        return () => {
            window.removeEventListener('message', onMessage)
            unsub()
            el?.removeEventListener('load', pushState)
        }
    }, [panel])

    return (
        <iframe
            ref={frame}
            className="nv-plugin-frame"
            style={{ display: visible ? 'block' : 'none' }}
            src={panel.url}
            title={panel.title}
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
        />
    )
}
