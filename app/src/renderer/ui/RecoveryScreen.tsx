import { Component, useEffect, useState, type ReactNode } from 'react'
import { preserveRecoverySession } from '../actions/recovery'

/** Uses only basic controls so a failed editor or panel cannot break the recovery screen. */
export function RecoveryScreen({ error }: { error: unknown }) {
    const [message, setMessage] = useState('正在保留编辑内容…')
    const [busy, setBusy] = useState(false)
    useEffect(() => {
        void window.iter?.app?.rendererStatus?.('failed')?.catch((error) => {
            console.error('[iter] could not report renderer failure', error)
        })
        void preserveRecoverySession().then(setMessage)
    }, [])
    const recover = async (action: 'restart' | 'exit'): Promise<void> => {
        if (busy) return
        setBusy(true)
        try {
            await preserveRecoverySession()
            await window.iter.app.recover(action)
        } catch (error) {
            setMessage(`无法完成操作：${error instanceof Error ? error.message : String(error)}。可使用窗口关闭按钮。`)
            setBusy(false)
        }
    }
    return (
        <main className="nv-recovery">
            <section aria-labelledby="recovery-title">
                <h1 id="recovery-title">编辑器无法继续运行</h1>
                <p role="status">{message}</p>
                <div className="nv-recovery-actions">
                    <button
                        className="nv-btn is-primary"
                        disabled={busy}
                        onClick={() => void recover('restart')}
                        autoFocus
                    >
                        重新启动
                    </button>
                    <button className="nv-btn" disabled={busy} onClick={() => void recover('exit')}>
                        退出
                    </button>
                </div>
                <details>
                    <summary>错误详情</summary>
                    <pre>{error instanceof Error ? error.message : String(error)}</pre>
                </details>
            </section>
        </main>
    )
}

export class RecoveryBoundary extends Component<{ children: ReactNode }, { failed: boolean; error?: unknown }> {
    state: { failed: boolean; error?: unknown } = { failed: false }
    static getDerivedStateFromError(error: unknown) {
        return { failed: true, error }
    }
    componentDidCatch(error: Error): void {
        console.error('[iter] interface failed', error)
    }
    render() {
        return this.state.failed ? <RecoveryScreen error={this.state.error} /> : this.props.children
    }
}
