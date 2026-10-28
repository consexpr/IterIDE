import { useEffect, useState } from 'react'
import {
    emptyEnvironmentHealth,
    formatEnvironmentHealth,
    healthConfig,
    HEALTH_CHECKS,
    HEALTH_STATUS_LABEL,
    type EnvironmentHealth
} from '../../../shared/environment'
import { toast, useApp } from '../../state/app'

export function EnvironmentHealthPage({ onSettings }: { onSettings(): void }) {
    const [report, setReport] = useState(emptyEnvironmentHealth)
    const [requesting, setRequesting] = useState(false)
    const [cancelling, setCancelling] = useState(false)
    const tools = useApp((state) => state.settings.toolchain)
    useEffect(() => {
        let alive = true
        const update = (next: EnvironmentHealth): void => {
            if (alive) setReport((previous) => (next.revision >= previous.revision ? next : previous))
        }
        const off = window.iter.toolchain.onHealth(update)
        void window.iter.toolchain
            .healthState()
            .then(update)
            .catch((error: Error) => alive && toast(error.message, 'error'))
        return () => {
            alive = false
            off()
        }
    }, [])
    const running = report.status === 'running',
        busy = requesting || running || cancelling
    const stale = report.config && JSON.stringify(report.config) !== JSON.stringify(healthConfig(tools))
    const start = async (): Promise<void> => {
        if (busy) return
        setRequesting(true)
        try {
            const next = await window.iter.toolchain.check()
            setReport((previous) => (next.revision >= previous.revision ? next : previous))
        } catch (error) {
            toast(`无法开始体检：${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
            setRequesting(false)
        }
    }
    const cancel = async (): Promise<void> => {
        setCancelling(true)
        try {
            await window.iter.toolchain.cancelCheck()
        } catch (error) {
            toast(`停止体检失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        } finally {
            setCancelling(false)
        }
    }
    const copy = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(formatEnvironmentHealth(report))
            toast('诊断信息已复制', 'success')
        } catch (error) {
            toast(`复制失败：${error instanceof Error ? error.message : String(error)}`, 'error')
        }
    }
    const failed = report.checks.some((check) => check.status === 'failed') || !!report.error
    const warning = report.checks.some((check) => check.status === 'warning')
    const current = report.checks.find((check) => check.status === 'running')
    const title = running
        ? `正在检查：${HEALTH_CHECKS.find((item) => item.id === current?.id)?.label ?? '准备样例'}`
        : report.status === 'idle'
          ? '环境体检'
          : report.status === 'cancelled'
            ? '体检已取消'
            : failed
              ? '发现问题'
              : warning
                ? '部分可用'
                : '体检通过'
    return (
        <div className="nv-form nv-health">
            <h3 className="nv-health-title" role="status" aria-live="polite">
                {title}
            </h3>
            <div className="nv-row is-tight">
                <button className="nv-btn is-primary" disabled={busy} onClick={() => void start()}>
                    {report.status === 'idle' ? '开始体检' : '重新体检'}
                </button>
                {running && (
                    <button className="nv-btn" disabled={cancelling} onClick={() => void cancel()}>
                        {cancelling ? '正在停止…' : '取消体检'}
                    </button>
                )}
                <button className="nv-btn" disabled={report.status === 'idle'} onClick={() => void copy()}>
                    复制诊断信息
                </button>
            </div>
            {stale && <div className="nv-health-notice">配置已更改，请重新体检。</div>}
            {report.startedAt && (
                <div className="nv-faint">开始时间：{new Date(report.startedAt).toLocaleString()}</div>
            )}
            {report.error && (
                <div className="nv-health-notice" role="alert">
                    {report.error}
                </div>
            )}
            <div className="nv-health-checks" aria-label="环境体检结果" aria-busy={running}>
                {report.checks.map((check) => {
                    const definition = HEALTH_CHECKS.find((item) => item.id === check.id)!
                    const detail = [
                        check.summary,
                        check.status === 'failed' ? definition.hint : undefined,
                        check.detail
                    ]
                        .filter(Boolean)
                        .join('\n\n')
                    return (
                        <section
                            key={check.id}
                            className={`nv-health-check is-${check.status}`}
                            data-check={check.id}
                            data-status={check.status}
                        >
                            <div className="nv-row is-tight">
                                <b>{definition.label}</b>
                                <span className="nv-flex" />
                                <span>{HEALTH_STATUS_LABEL[check.status]}</span>
                                {check.durationMs !== undefined && (
                                    <span className="nv-faint">{check.durationMs} ms</span>
                                )}
                            </div>
                            {detail && (
                                <details>
                                    <summary>详情</summary>
                                    <pre>{detail}</pre>
                                </details>
                            )}
                        </section>
                    )
                })}
            </div>
            <button className="nv-btn" onClick={onSettings}>
                编译与运行设置
            </button>
        </div>
    )
}
