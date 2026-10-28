import { useEffect, useState } from 'react'
import type { ApiCallStatus, ApiHistoryState } from '../../../shared/apiHistory'
import { toast } from '../../state/app'
import './apiHistory.css'

const labels: Record<ApiCallStatus, string> = {
    pending: '请求中',
    success: '成功',
    error: '失败',
    cancelled: '已取消',
    timeout: '超时'
}

export function ApiPage() {
    const [state, setState] = useState<ApiHistoryState>({ revision: -1, records: [] })
    const [error, setError] = useState('')
    useEffect(() => {
        let alive = true
        const refresh = (): void => {
            void window.iter.apiHistory
                .list()
                .then((next) => {
                    if (alive) {
                        setState((previous) => (next.revision >= previous.revision ? next : previous))
                        setError('')
                    }
                })
                .catch(() => {
                    if (alive) setError('无法读取调用记录，请重新打开此页面重试。')
                })
        }
        const off = window.iter.apiHistory.onChanged(refresh)
        refresh()
        return () => {
            alive = false
            off()
        }
    }, [])
    const remove = async (id?: string): Promise<void> => {
        try {
            if (id) await window.iter.apiHistory.delete(id)
            else await window.iter.apiHistory.clear()
        } catch {
            toast('删除调用记录失败', 'error')
        }
    }
    const records = state.records
    return (
        <div className="nv-form nv-api-history">
            <div className="nv-api-toolbar">
                <span>调用记录</span>
                <button className="nv-btn is-quiet" disabled={!records.length} onClick={() => void remove()}>
                    清空
                </button>
            </div>
            {error && <p role="alert">{error}</p>}
            {state.revision < 0 && !error && <p>正在加载…</p>}
            {state.revision >= 0 && !records.length && <p className="nv-faint">暂无记录</p>}
            {records.map((record) => (
                <article key={record.id} className="nv-api-call">
                    <div className="nv-api-row">
                        <time>{new Date(record.startedAt).toLocaleTimeString()}</time>
                        <span
                            className={record.status === 'error' || record.status === 'timeout' ? 'nv-api-error' : ''}
                        >
                            {labels[record.status]}
                        </span>
                        <span className="nv-api-model">{record.model}</span>
                        <span>{record.status === 'pending' ? '进行中' : record.durationMs + ' ms'}</span>
                        <button
                            className="nv-btn is-quiet"
                            aria-label={'删除记录 ' + record.id}
                            onClick={() => void remove(record.id)}
                        >
                            删除
                        </button>
                    </div>
                    <details>
                        <summary>详情</summary>
                        <p className="nv-api-meta">
                            {new Date(record.startedAt).toLocaleString()}
                            {record.httpStatus ? ' · HTTP ' + record.httpStatus : ''}
                            <br />
                            POST {record.endpoint}
                            <br />
                            max_tokens: 128 · temperature: 0 · reasoning_effort: {record.effort || '默认'}
                        </p>
                        {(
                            [
                                ['前缀 / prompt', record.prefix],
                                ['后缀 / suffix', record.suffix],
                                ['返回补全', record.output],
                                ['错误', record.error]
                            ] as const
                        ).map(([label, value]) => (
                            <section key={label}>
                                <strong>{label}</strong>
                                <pre>{value || '（空）'}</pre>
                            </section>
                        ))}
                    </details>
                </article>
            ))}
        </div>
    )
}
