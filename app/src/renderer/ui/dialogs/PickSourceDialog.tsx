import { useState } from 'react'
import type { ProblemFolderPreview } from '../../../shared/importer'
import { applyProblemFolder } from '../../actions/folders'
import { toast } from '../../state/app'
import { Modal, close } from './Modal'

const NEW = '__new__'
const base = (p: string): string => p.split(/[\\/]/).pop() ?? p

/** The folder holds several .cpp files: which one is the solution for this problem? */
export function PickSourceDialog({ problem }: { problem: ProblemFolderPreview }) {
    const [pick, setPick] = useState(problem.sources[0] ?? NEW)
    const [busy, setBusy] = useState(false)
    const newPath = `${problem.dir}${problem.dir.includes('\\') ? '\\' : '/'}${problem.name}.cpp`

    const apply = async (): Promise<void> => {
        setBusy(true)
        try {
            const added = await applyProblemFolder(problem, pick === NEW ? newPath : pick)
            toast(`${problem.name}：${added} 个测试点`, 'success')
            close()
        } catch (e) {
            toast(`导入失败：${(e as Error).message}`, 'error', 6000)
            setBusy(false)
        }
    }

    return (
        <Modal
            title={problem.name}
            width={420}
            footer={
                <>
                    <button className="nv-btn is-quiet" onClick={close}>
                        取消
                    </button>
                    <button className="nv-btn is-primary" disabled={busy} onClick={() => void apply()}>
                        确定
                    </button>
                </>
            }
        >
            <div className="nv-list">
                {problem.sources.map((s) => (
                    <label key={s} className={`nv-list-item nv-pick ${pick === s ? 'is-on' : ''}`}>
                        <input type="radio" name="src" checked={pick === s} onChange={() => setPick(s)} />
                        <span className="nv-flex">{base(s)}</span>
                    </label>
                ))}
                <label className={`nv-list-item nv-pick ${pick === NEW ? 'is-on' : ''}`}>
                    <input type="radio" name="src" checked={pick === NEW} onChange={() => setPick(NEW)} />
                    <span className="nv-flex">新建 {problem.name}.cpp</span>
                    {problem.template && <span className="nv-faint">{base(problem.template)}</span>}
                </label>
            </div>
        </Modal>
    )
}
