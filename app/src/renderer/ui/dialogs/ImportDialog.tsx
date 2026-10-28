import { useState } from 'react'
import type { ImportPreview } from '../../../shared/importer'
import { reloadProblem } from '../../actions/files'
import { store, toast } from '../../state/app'
import { withProblemMutation, withTestReplacement } from '../../actions/problemWrites'
import { Modal, Switch, close } from './Modal'

const ROLE: Record<string, string> = {
    checker: '自定义 checker',
    interactor: '交互库',
    testlib: 'testlib.h',
    validator: 'Validator',
    generator: '生成器',
    solution: '标程'
}

export function ImportDialog({ preview, sourcePath }: { preview: ImportPreview; sourcePath: string }) {
    const f = store.get().files.find((file) => file.path === sourcePath)
    const hasExisting = (f?.tests.length ?? 0) > 0
    const [replace, setReplace] = useState(false)
    const attachable = preview.extras.some((e) => e.role === 'checker' || e.role === 'interactor')
    const [attachExtras, setAttach] = useState(attachable)
    const [busy, setBusy] = useState(false)
    const withAnswer = preview.pairs.filter((p) => p.answer).length

    const apply = async (): Promise<void> => {
        if (!f) return
        setBusy(true)
        try {
            const r = await withProblemMutation(f.path, async (flush) => {
                const apply = () => window.iter.importer.apply({ sourcePath: f.path, preview, replace, attachExtras })
                if (replace) return withTestReplacement(f.path, apply, () => reloadProblem(f.path))
                await flush()
                const result = await apply()
                await reloadProblem(f.path)
                return result
            })
            toast(`已导入 ${r.added} 个测试点`, 'success')
            close()
        } catch (e) {
            toast(`导入失败：${(e as Error).message}`, 'error', 6000)
            setBusy(false)
        }
    }

    return (
        <Modal
            title="导入测试数据"
            width={620}
            footer={
                <>
                    <span className="nv-faint nv-flex">
                        {preview.pairs.length} 组 · {withAnswer} 组有答案
                    </span>
                    <button className="nv-btn is-quiet" onClick={close}>
                        取消
                    </button>
                    <button
                        className="nv-btn is-primary"
                        disabled={busy || (!preview.pairs.length && !attachExtras)}
                        onClick={() => void apply()}
                    >
                        {busy ? '导入中…' : '导入'}
                    </button>
                </>
            }
        >
            <div className="nv-import-src" title={preview.source}>
                {preview.source}
            </div>
            {preview.notes.length > 0 && (
                <ul className="nv-import-notes">
                    {preview.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                    ))}
                </ul>
            )}
            <div className="nv-import-table">
                <div className="nv-import-row is-head">
                    <span>测试点</span>
                    <span>输入</span>
                    <span>答案</span>
                </div>
                {preview.pairs.map((p) => (
                    <div key={p.input} className="nv-import-row">
                        <span>{p.name}</span>
                        <span title={p.input}>{short(p.input)}</span>
                        <span title={p.answer} className={p.answer ? '' : 'nv-faint'}>
                            {p.answer ? short(p.answer) : '无'}
                        </span>
                    </div>
                ))}
            </div>
            {preview.unmatched.length > 0 && (
                <details className="nv-import-unmatched">
                    <summary>{preview.unmatched.length} 个文件未能配对</summary>
                    {preview.unmatched.map((u) => (
                        <div key={u}>{u}</div>
                    ))}
                </details>
            )}
            {preview.extras.length > 0 && (
                <div className="nv-import-extras">
                    {preview.extras.map((e) => (
                        <span key={e.path} className="nv-chip" title={e.path}>
                            {ROLE[e.role]} · {short(e.path)}
                        </span>
                    ))}
                </div>
            )}
            <div className="nv-import-opts">
                {hasExisting && (
                    <Switch checked={replace} onChange={setReplace} label={`替换现有的 ${f?.tests.length} 个测试点`} />
                )}
                {attachable && (
                    <Switch checked={attachExtras} onChange={setAttach} label="同时设置识别到的 Checker / 交互库" />
                )}
            </div>
        </Modal>
    )
}

const short = (p: string): string => p.split(/[\\/]/).slice(-2).join('/')
