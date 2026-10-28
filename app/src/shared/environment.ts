import { APP_NAME } from './brand'
import type { ToolchainSettings } from './judge'

export const HEALTH_CHECKS = [
    { id: 'compile', label: 'C++ 编译', hint: '请在“编译与运行”中检查编译器路径和评测编译选项。' },
    { id: 'run', label: '程序运行与输入输出', hint: '请查看退出信息，并检查程序运行权限。' },
    { id: 'debug', label: '断点调试与录制支持', hint: '请检查调试编译选项和 gdb 路径。' },
    { id: 'completion', label: '标准库语义补全', hint: '请检查 clangd 与编译器路径，确认标准库可用。' }
] as const
export type HealthCheckId = (typeof HEALTH_CHECKS)[number]['id']
export type HealthConfig = Pick<ToolchainSettings, 'compiler' | 'flags' | 'debugFlags' | 'gdb' | 'clangd'>
export type HealthCheckStatus = 'pending' | 'running' | 'passed' | 'warning' | 'failed' | 'skipped' | 'cancelled'
export interface HealthCheck {
    id: HealthCheckId
    status: HealthCheckStatus
    summary?: string
    detail?: string
    durationMs?: number
}
export interface EnvironmentHealth {
    revision: number
    status: 'idle' | 'running' | 'complete' | 'cancelled'
    version: string
    platform: string
    startedAt?: string
    finishedAt?: string
    config?: HealthConfig
    error?: string
    checks: HealthCheck[]
}
export const healthConfig = (tools: HealthConfig): HealthConfig => ({
    compiler: tools.compiler,
    flags: tools.flags,
    debugFlags: tools.debugFlags,
    gdb: tools.gdb,
    clangd: tools.clangd
})
export const emptyEnvironmentHealth = (): EnvironmentHealth => ({
    revision: 0,
    status: 'idle',
    version: '',
    platform: '',
    checks: HEALTH_CHECKS.map(({ id }) => ({ id, status: 'pending' }))
})
export const HEALTH_STATUS_LABEL: Record<HealthCheckStatus, string> = {
    pending: '待检查',
    running: '检查中',
    passed: '通过',
    warning: '部分可用',
    failed: '未通过',
    skipped: '未检查',
    cancelled: '已取消'
}
export function formatEnvironmentHealth(report: EnvironmentHealth): string {
    const lines = [
        `${APP_NAME} 环境体检`,
        `版本：${report.version} · ${report.platform}`,
        `开始：${report.startedAt ?? '尚未开始'}`,
        `结束：${report.finishedAt ?? '尚未结束'}`
    ]
    if (report.config) for (const [key, value] of Object.entries(report.config)) lines.push(`${key}: ${value}`)
    if (report.error) lines.push(report.error)
    for (const check of report.checks) {
        const definition = HEALTH_CHECKS.find((item) => item.id === check.id)!
        lines.push(
            '',
            `[${HEALTH_STATUS_LABEL[check.status]}] ${definition.label}${check.durationMs === undefined ? '' : ` (${check.durationMs} ms)`}`,
            check.summary ?? ''
        )
        if (check.status === 'failed') lines.push(definition.hint)
        if (check.detail) lines.push(check.detail)
    }
    return lines.join('\n')
}
