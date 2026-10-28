import { useState } from 'react'
import type { AppSettings, EditorSettings } from '../../../shared/settings'
import { DEFAULT_TERMINAL_COLORS, minimapScale, terminalColors } from '../../../shared/settings'
import type { ToolchainSettings, ToolchainStatus, ToolName } from '../../../shared/judge'
import { exportConfig, importConfig, reloadThemes, updateSettings } from '../../actions/settings'
import { allThemes } from '../../themes/apply'
import type { IterTheme } from '../../themes/types'
import { toast, useApp } from '../../state/app'
import { AsyncContent, useAsyncResource } from '../AsyncContent'
import { useContentMotion } from '../motion'
import { CompletionSection } from './CompletionSection'
import { ApiPage } from './ApiPage'
import { FontsPage } from './FontsPage'
import { KeybindingsPage } from './KeybindingsPage'
import { EnvironmentHealthPage } from './EnvironmentHealthPage'
import { Field, Modal, Switch } from './Modal'
import { Slider } from '../controls/Slider'

type Tab =
    | 'look'
    | 'fonts'
    | 'editor'
    | 'completion'
    | 'api'
    | 'keys'
    | 'toolchain'
    | 'terminal'
    | 'health'
    | 'template'
    | 'plugins'
    | 'config'
const TABS: { id: Tab; label: string }[] = [
    { id: 'look', label: '外观' },
    { id: 'fonts', label: '字体' },
    { id: 'editor', label: '编辑器' },
    { id: 'completion', label: '补全' },
    { id: 'api', label: 'API' },
    { id: 'keys', label: '快捷键' },
    { id: 'toolchain', label: '编译与运行' },
    { id: 'terminal', label: '终端' },
    { id: 'health', label: '环境体检' },
    { id: 'template', label: '代码模板' },
    { id: 'plugins', label: '插件' },
    { id: 'config', label: '导入 / 导出' }
]

export function SettingsDialog() {
    const [tab, setTab] = useState<Tab>('look')
    const page = useContentMotion(tab)
    const s = useApp((x) => x.settings)
    return (
        <Modal title="设置" width={760} smoothSize>
            <div className="nv-settings">
                <nav>
                    {TABS.map((t) => (
                        <button key={t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => setTab(t.id)}>
                            {t.label}
                        </button>
                    ))}
                </nav>
                <div ref={page} className="nv-settings-page">
                    {tab === 'look' && <Look s={s} />}
                    {tab === 'fonts' && <FontsPage s={s} />}
                    {tab === 'editor' && <EditorPage e={s.editor} />}
                    {tab === 'completion' && (
                        <div className="nv-form">
                            <CompletionSection c={s.editor.completion} />
                        </div>
                    )}
                    {tab === 'api' && <ApiPage />}
                    {tab === 'keys' && <KeybindingsPage />}
                    {tab === 'toolchain' && <Toolchain t={s.toolchain} />}
                    {tab === 'terminal' && <TerminalPage colors={terminalColors(s.terminal?.colors)} />}
                    {tab === 'health' && <EnvironmentHealthPage onSettings={() => setTab('toolchain')} />}
                    {tab === 'template' && <Template s={s} />}
                    {tab === 'plugins' && <Plugins />}
                    {tab === 'config' && <ConfigPage />}
                </div>
            </div>
        </Modal>
    )
}

const setEditor = (p: Partial<EditorSettings>): void => void updateSettings({ editor: p as EditorSettings })
const setTool = (p: Partial<ToolchainSettings>): void => void updateSettings({ toolchain: p as ToolchainSettings })

function Look({ s }: { s: AppSettings }) {
    useApp((x) => x.themeVersion) // re-render after live reload
    return (
        <div className="nv-form">
            <Field label="主题">
                <div className="nv-theme-grid">
                    {allThemes().map((t) => (
                        <ThemeCard key={t.id} t={t} on={s.theme === t.id} />
                    ))}
                </div>
            </Field>
            <div className="nv-row is-tight">
                <button className="nv-btn" onClick={() => void window.iter.settings.openUserDir('themes')}>
                    打开主题目录
                </button>
                <button className="nv-btn is-quiet" onClick={() => void reloadThemes()}>
                    重新加载
                </button>
            </div>
        </div>
    )
}

function ThemeCard({ t, on }: { t: IterTheme; on: boolean }) {
    const tk = (k: string): string => (t.tokens[k] ?? t.editor.foreground).split(' ')[0]
    return (
        <button
            className={`nv-theme-card ${on ? 'is-on' : ''}`}
            onClick={() => void updateSettings({ theme: t.id })}
            style={{ background: t.editor.background, borderColor: on ? t.ui.accent : t.ui.border }}
        >
            <code style={{ color: t.editor.foreground }}>
                <span style={{ color: tk('keyword.control') }}>for</span> (
                <span style={{ color: tk('type.primitive') }}>int</span> i ={' '}
                <span style={{ color: tk('number') }}>0</span>; ...)
                <br />
                <span style={{ color: tk('function') }}>sort</span>(a, a + n);
                <span style={{ color: tk('comment') }}> // ok</span>
            </code>
            <span className="nv-theme-name" style={{ background: t.ui.panel, color: t.ui.text }}>
                <span className="nv-theme-accent" style={{ background: t.ui.accent }} />
                {t.name}
            </span>
        </button>
    )
}

function EditorPage({ e }: { e: EditorSettings }) {
    return (
        <div className="nv-form">
            <div className="nv-row">
                <Field label="缩进宽度">
                    <input
                        type="number"
                        min={1}
                        max={8}
                        value={e.tabSize}
                        onChange={(ev) => {
                            const tabSize = ev.target.valueAsNumber
                            if (Number.isInteger(tabSize) && tabSize >= 1 && tabSize <= 8) setEditor({ tabSize })
                        }}
                    />
                </Field>
            </div>
            <div className="nv-switches">
                <Switch checked={e.insertSpaces} onChange={(v) => setEditor({ insertSpaces: v })} label="用空格缩进" />
                <Switch checked={e.wordWrap} onChange={(v) => setEditor({ wordWrap: v })} label="自动换行" />
                <Switch checked={e.minimap} onChange={(v) => setEditor({ minimap: v })} label="缩略图" />
                <Switch
                    checked={e.semanticCompletion}
                    onChange={(v) => setEditor({ semanticCompletion: v })}
                    label="语义补全（clangd）"
                />
                <Switch
                    checked={e.liveDiagnostics}
                    onChange={(v) => setEditor({ liveDiagnostics: v })}
                    label="实时错误检查"
                />
                <Switch
                    checked={e.formatOnSave}
                    onChange={(v) => setEditor({ formatOnSave: v })}
                    label="保存时格式化"
                />
            </div>
            {e.minimap && (
                <Slider
                    label="缩略图大小"
                    value={minimapScale(e.minimapScale)}
                    min={1}
                    max={3}
                    unit="×"
                    defaultValue={2}
                    onChange={(minimapScale) => setEditor({ minimapScale })}
                />
            )}
        </div>
    )
}

const SOURCE: Record<string, string> = { bundled: '内置', configured: '自定义', path: '系统' }
const TOOL_LABEL: Record<ToolName, string> = {
    compiler: 'g++',
    gdb: 'gdb',
    clangd: 'clangd',
    clangFormat: 'clang-format'
}

function ToolStatusList() {
    const resource = useAsyncResource<ToolchainStatus>('toolchain', () => window.iter.toolchain.status())
    const st = resource.data
    return (
        <AsyncContent {...resource} ready={!!st} label="正在检查编译工具…" className="nv-tool-status">
            <div className="nv-tools">
                {st &&
                    (Object.keys(TOOL_LABEL) as ToolName[]).map((k) => {
                        const v = st[k]
                        return (
                            <div key={k} className="nv-tool" title={'command' in v ? v.command : v.error}>
                                <span className="nv-tool-name">{TOOL_LABEL[k]}</span>
                                {'command' in v ? (
                                    <>
                                        <span className="nv-chip">{SOURCE[v.source]}</span>
                                        <span className="nv-tool-ver">{v.version.split(/\r?\n/)[0]}</span>
                                    </>
                                ) : (
                                    <span className="nv-tool-ver v-text-wa">未找到</span>
                                )}
                            </div>
                        )
                    })}
            </div>
        </AsyncContent>
    )
}

function Toolchain({ t }: { t: ToolchainSettings }) {
    return (
        <div className="nv-form">
            <ToolStatusList />
            <Field label="编译器">
                <input value={t.compiler} onChange={(e) => setTool({ compiler: e.target.value })} />
            </Field>
            <Field label="评测编译选项">
                <input value={t.flags} onChange={(e) => setTool({ flags: e.target.value })} />
            </Field>
            <Field label="调试编译选项">
                <input value={t.debugFlags} onChange={(e) => setTool({ debugFlags: e.target.value })} />
            </Field>
            <div className="nv-row">
                <Field label="gdb">
                    <input value={t.gdb} onChange={(e) => setTool({ gdb: e.target.value })} />
                </Field>
                <Field label="clangd">
                    <input value={t.clangd} onChange={(e) => setTool({ clangd: e.target.value })} />
                </Field>
                <Field label="clang-format">
                    <input value={t.clangFormat} onChange={(e) => setTool({ clangFormat: e.target.value })} />
                </Field>
            </div>
            <div className="nv-row">
                <Field label="并行测试数">
                    <input
                        type="number"
                        min={1}
                        max={32}
                        value={t.parallel}
                        onChange={(e) => setTool({ parallel: +e.target.value })}
                    />
                </Field>
                <Field label="输出上限" hint="MB">
                    <input
                        type="number"
                        min={1}
                        value={Math.round(t.outputLimitBytes / 1048576)}
                        onChange={(e) => setTool({ outputLimitBytes: +e.target.value * 1048576 })}
                    />
                </Field>
            </div>
        </div>
    )
}

const SWEEP_LABELS = ['扫光颜色 1', '扫光颜色 2', '扫光颜色 3']

function TerminalPage({ colors }: { colors: string[] }) {
    const setColors = (next: string[]): void => void updateSettings({ terminal: { colors: next } })
    return (
        <div className="nv-form">
            <div className="nv-row">
                {SWEEP_LABELS.map((label, i) => (
                    <Field key={label} label={label}>
                        <input
                            type="color"
                            value={colors[i]}
                            onChange={(e) => setColors(colors.map((c, j) => (j === i ? e.target.value : c)))}
                        />
                    </Field>
                ))}
            </div>
            <div className="nv-row is-tight">
                <button className="nv-btn is-quiet" onClick={() => setColors([...DEFAULT_TERMINAL_COLORS])}>
                    恢复默认
                </button>
            </div>
        </div>
    )
}

function Template({ s }: { s: AppSettings }) {
    return (
        <div className="nv-form">
            <Field label="代码模板">
                <textarea
                    className="nv-template"
                    spellCheck={false}
                    value={s.template}
                    onChange={(e) => void updateSettings({ template: e.target.value })}
                />
            </Field>
        </div>
    )
}

function Plugins() {
    const resource = useAsyncResource('plugins', () => window.iter.plugins.list())
    const configured = useApp((state) => state.settings.pluginEnabled)
    const list = (resource.data ?? []).map((plugin) => ({
        ...plugin,
        enabled: configured[plugin.id] ?? plugin.enabled
    }))
    const toggle = async (id: string, on: boolean): Promise<void> => {
        await updateSettings({ pluginEnabled: { [id]: on } })
        try {
            await window.iter.plugins.reload()
            resource.reload()
        } catch (error) {
            toast(`插件重新加载失败：${(error as Error).message}`, 'error')
        }
    }
    return (
        <div className="nv-form">
            <AsyncContent {...resource} ready={!!resource.data} label="正在加载插件…">
                <div className="nv-list">
                    {list.map((p) => (
                        <div key={p.id} className={`nv-list-item is-static nv-plugin-row ${p.enabled ? '' : 'is-off'}`}>
                            <Switch checked={p.enabled} onChange={(on) => void toggle(p.id, on)} label={p.name} />
                            <span className="nv-faint">v{p.version}</span>
                            <span className="nv-flex" />
                            {p.error && p.enabled ? (
                                <span className="v-text-wa">{p.error}</span>
                            ) : (
                                <span className="nv-faint">{p.id}</span>
                            )}
                        </div>
                    ))}
                    {!list.length && <div className="nv-faint">暂无插件</div>}
                </div>
            </AsyncContent>
            <div className="nv-row is-tight">
                <button className="nv-btn" onClick={() => void window.iter.settings.openUserDir('plugins')}>
                    打开插件目录
                </button>
            </div>
        </div>
    )
}

function ConfigPage() {
    return (
        <div className="nv-form">
            <Field label="配置文件">
                <div className="nv-row is-tight">
                    <button className="nv-btn is-primary" onClick={() => void exportConfig()}>
                        导出…
                    </button>
                    <button className="nv-btn" onClick={() => void importConfig()}>
                        导入…
                    </button>
                </div>
            </Field>
        </div>
    )
}
