import { useState } from 'react'
import { updateSettings } from '../../actions/settings'
import { fromEvent, pretty } from '../../commands/accelerator'
import { bindingOf, COMMANDS, conflicts, KEY_PRESETS, type CommandGroup } from '../../commands/registry'
import { store, useApp } from '../../state/app'

const GROUPS: CommandGroup[] = ['运行', '调试', '编辑', '文件']

export function KeybindingsPage() {
    const overrides = useApp((s) => s.settings.keybindings)
    const [recording, setRecording] = useState<string | null>(null)
    const [query, setQuery] = useState('')

    const set = (id: string, acc: string | null): void => {
        // stealing a shortcut unbinds it from whoever had it, so a key never runs two commands
        const patch: Record<string, string | null> = { [id]: acc }
        if (acc) for (const c of conflicts(acc, id)) patch[c.id] = ''
        void updateSettings({ keybindings: patch })
    }

    /** A preset replaces all overrides: commands not in it go back to their defaults. */
    const applyPreset = (keys: Record<string, string>): void => {
        const patch: Record<string, string | null> = {}
        for (const k of Object.keys(store.get().settings.keybindings)) patch[k] = null
        void updateSettings({ keybindings: { ...patch, ...keys } })
    }

    const resetAll = (): void => {
        const patch: Record<string, null> = {}
        for (const k of Object.keys(store.get().settings.keybindings)) patch[k] = null
        void updateSettings({ keybindings: patch })
    }

    const q = query.trim().toLowerCase()
    return (
        <div className="nv-form">
            <div className="nv-row is-tight">
                <input
                    className="nv-kb-search"
                    placeholder="搜索"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <button className="nv-btn is-quiet" onClick={resetAll}>
                    全部恢复默认
                </button>
            </div>
            <div className="nv-row is-tight">
                <span className="nv-faint nv-preset-label">预设</span>
                {KEY_PRESETS.filter((p) => p.id !== 'default').map((p) => (
                    <button key={p.id} className="nv-btn" onClick={() => applyPreset(p.keys)}>
                        {p.label}
                    </button>
                ))}
            </div>
            {GROUPS.map((g) => {
                const cmds = COMMANDS.filter(
                    (c) =>
                        c.group === g &&
                        (!q || c.label.includes(q) || bindingOf(c, overrides).toLowerCase().includes(q))
                )
                if (!cmds.length) return null
                return (
                    <div key={g} className="nv-kb-group">
                        <div className="nv-kb-title">{g}</div>
                        {cmds.map((c) => {
                            const acc = bindingOf(c, overrides)
                            const changed = acc !== bindingOf(c, {})
                            const clash = conflicts(acc, c.id)
                            return (
                                <div key={c.id} className="nv-kb-row">
                                    <span className="nv-kb-label">{c.label}</span>
                                    {clash.length > 0 && (
                                        <span className="nv-kb-clash">与「{clash[0].label}」相同</span>
                                    )}
                                    <button
                                        className={`nv-kb-key ${recording === c.id ? 'is-recording' : ''} ${acc ? '' : 'is-empty'}`}
                                        data-key-capture={recording === c.id ? '' : undefined}
                                        onClick={() => setRecording(c.id)}
                                        onBlur={() => recording === c.id && setRecording(null)}
                                        onKeyDown={(e) => {
                                            if (recording !== c.id) return
                                            e.preventDefault()
                                            e.stopPropagation()
                                            if (e.key === 'Escape') return setRecording(null)
                                            if (e.key === 'Backspace' || e.key === 'Delete') {
                                                set(c.id, '')
                                                return setRecording(null)
                                            }
                                            const next = fromEvent(e.nativeEvent)
                                            if (!next) return
                                            set(c.id, next)
                                            setRecording(null)
                                        }}
                                    >
                                        {recording === c.id ? (
                                            '按下新的快捷键'
                                        ) : acc ? (
                                            <kbd>{pretty(acc)}</kbd>
                                        ) : (
                                            '未绑定'
                                        )}
                                    </button>
                                    <button
                                        className={`nv-mini ${changed ? '' : 'is-hidden'}`}
                                        onClick={() => set(c.id, null)}
                                        title="恢复默认"
                                    >
                                        默认
                                    </button>
                                </div>
                            )
                        })}
                    </div>
                )
            })}
        </div>
    )
}
