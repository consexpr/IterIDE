import { useEffect, useMemo, useState } from 'react'
import type { CodeSnapshot, SnapshotContent } from '../../shared/snapshots'
import { deleteSnapshot, renameSnapshot, restoreSnapshot, saveSnapshot, snapshotState } from '../actions/snapshots'
import { withKey } from '../commands/registry'
import { activeFile, isDebugging, useApp, type FileState } from '../state/app'
import { useStore } from '../state/store'
import { Icon } from './Icon'
import { testTextPreview } from './testTextPreview'
import '../styles/snapshots.css'

const timestamp = (time: number): string => new Date(time).toLocaleString('zh-CN', { hour12: false })
const size = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)

export function SnapshotPanel() {
    const file = useApp(activeFile)
    const closing = useApp((s) => s.closing)
    useApp((s) => s.settings.keybindings)
    if (!file) return null
    return <FileSnapshots key={file.path} file={file} disabled={closing || !!file.transitioning} />
}

function FileSnapshots({ file, disabled }: { file: FileState; disabled: boolean }) {
    const { path } = file
    const revision = useStore(snapshotState, (s) => s.revision)
    const busy = useStore(snapshotState, (s) => s.busy.has(path))
    const [entries, setEntries] = useState<CodeSnapshot[]>([])
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [retry, setRetry] = useState(0)
    const [visible, setVisible] = useState(30)
    const selected = entries.find((entry) => entry.id === selectedId)

    useEffect(() => {
        let current = true
        setError('')
        void window.iter.snapshots
            .list(path)
            .then((items) => {
                if (!current) return
                setEntries(items)
                setSelectedId((id) => (items.some((item) => item.id === id) ? id : (items[0]?.id ?? null)))
            })
            .catch((e: Error) => {
                if (current) setError(e.message)
            })
            .finally(() => {
                if (current) setLoading(false)
            })
        return () => {
            current = false
        }
    }, [path, revision, retry])

    const locked = disabled || busy
    return (
        <section
            className="nv-snapshots"
            data-busy={busy}
            data-empty={!entries.length}
            aria-label={`${file.name} 的快照`}
        >
            <div className="nv-snapshots-toolbar">
                <button
                    className="nv-snapshot-save"
                    disabled={locked}
                    onClick={() => void saveSnapshot()}
                    title={withKey('保存当前代码', 'snapshot.save')}
                >
                    <Icon name="plus" size={14} /> 保存
                </button>
                <span className="nv-snapshots-count" aria-label={`${entries.length} 个快照`}>
                    {entries.length}
                </span>
            </div>
            {error && (
                <div className="nv-snapshots-error" role="alert">
                    {error}
                    <button className="nv-mini" onClick={() => setRetry((n) => n + 1)}>
                        重试
                    </button>
                </div>
            )}
            {loading ? (
                <p className="nv-snapshots-empty" role="status">
                    正在读取快照…
                </p>
            ) : entries.length > 0 ? (
                <>
                    <div className="nv-snapshots-list" aria-label="快照列表">
                        {entries.slice(0, visible).map((entry) => (
                            <button
                                key={entry.id}
                                className={`nv-snapshot-row ${entry.id === selectedId ? 'is-selected' : ''}`}
                                aria-pressed={entry.id === selectedId}
                                title={`${entry.name ? `${entry.name}\n` : ''}${timestamp(entry.createdAt)}\n${size(entry.bytes)}`}
                                onClick={() => setSelectedId(entry.id)}
                            >
                                <span className="nv-snapshot-name">{entry.name || timestamp(entry.createdAt)}</span>
                                <span className="nv-snapshot-size">{entry.lines} 行</span>
                            </button>
                        ))}
                        {entries.length > visible && (
                            <button className="nv-mini nv-snapshots-more" onClick={() => setVisible((n) => n + 30)}>
                                显示更多（剩余 {entries.length - visible} 个）
                            </button>
                        )}
                    </div>
                    {selected && <SnapshotPreview key={selected.id} path={path} entry={selected} disabled={locked} />}
                </>
            ) : null}
        </section>
    )
}

function SnapshotPreview({ path, entry, disabled }: { path: string; entry: CodeSnapshot; disabled: boolean }) {
    const debugging = useApp(isDebugging)
    const [content, setContent] = useState<SnapshotContent | null>(null)
    const [error, setError] = useState('')
    const [retry, setRetry] = useState(0)
    const [renaming, setRenaming] = useState(false)
    const [name, setName] = useState(entry.name)
    const [deleting, setDeleting] = useState(false)
    useEffect(() => {
        let current = true
        setError('')
        void window.iter.snapshots
            .read(path, entry.id)
            .then((value) => {
                if (current) setContent(value)
            })
            .catch((e: Error) => {
                if (current) setError(e.message)
            })
        return () => {
            current = false
        }
    }, [path, entry.id, retry])
    const preview = useMemo(() => (content ? testTextPreview(content.code) : null), [content])
    return (
        <div className="nv-snapshot-preview">
            <div className="nv-snapshot-actions">
                <button
                    className="nv-mini nv-snapshot-restore"
                    disabled={disabled || !content || debugging}
                    title={debugging ? '请结束调试后再恢复代码' : '恢复到当前编辑器'}
                    onClick={() => void restoreSnapshot(path, entry.id)}
                >
                    <Icon name="restart" size={13} /> 恢复
                </button>
                <button
                    className="nv-mini"
                    disabled={disabled}
                    onClick={() => {
                        setName(entry.name)
                        setRenaming(!renaming)
                        setDeleting(false)
                    }}
                >
                    重命名
                </button>
                <button
                    className="nv-mini"
                    disabled={disabled}
                    onClick={() => {
                        setDeleting(!deleting)
                        setRenaming(false)
                    }}
                >
                    删除
                </button>
            </div>
            {renaming && (
                <form
                    className="nv-snapshot-rename"
                    onSubmit={(e) => {
                        e.preventDefault()
                        void renameSnapshot(path, entry.id, name).then((ok) => {
                            if (ok) setRenaming(false)
                        })
                    }}
                >
                    <input
                        aria-label="快照名称"
                        value={name}
                        maxLength={80}
                        autoFocus
                        disabled={disabled}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') setRenaming(false)
                        }}
                    />
                    <button className="nv-mini" disabled={disabled}>
                        保存
                    </button>
                    <button className="nv-mini" type="button" onClick={() => setRenaming(false)}>
                        取消
                    </button>
                </form>
            )}
            {deleting && (
                <div className="nv-snapshot-delete" role="alert">
                    <span>删除这份快照？</span>
                    <button className="nv-mini" disabled={disabled} onClick={() => void deleteSnapshot(path, entry.id)}>
                        确认删除
                    </button>
                    <button className="nv-mini" onClick={() => setDeleting(false)}>
                        取消
                    </button>
                </div>
            )}
            {error ? (
                <div className="nv-snapshots-error" role="alert">
                    {error}
                    <button className="nv-mini" onClick={() => setRetry((n) => n + 1)}>
                        重试
                    </button>
                </div>
            ) : preview ? (
                <>
                    <pre className="nv-snapshot-code" tabIndex={0} aria-label="快照代码预览">
                        {preview.text}
                    </pre>
                    {preview.truncated && <p className="nv-snapshot-status">预览已截断</p>}
                </>
            ) : (
                <p className="nv-snapshots-empty" role="status">
                    正在读取代码…
                </p>
            )}
        </div>
    )
}
