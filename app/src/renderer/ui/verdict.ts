import type { Verdict } from '../../shared/judge'

const labels: Record<Verdict, { short: string; long: string }> = {
    PENDING: { short: '等待', long: '等待中' },
    RUNNING: { short: '运行', long: '运行中' },
    AC: { short: 'AC', long: '通过' },
    WA: { short: 'WA', long: '答案错误' },
    PE: { short: 'PE', long: '格式错误' },
    TLE: { short: 'TLE', long: '超时' },
    MLE: { short: 'MLE', long: '超内存' },
    RE: { short: 'RE', long: '运行错误' },
    OLE: { short: 'OLE', long: '输出超限' },
    CE: { short: 'CE', long: '编译错误' },
    SE: { short: 'SE', long: '评测器错误' },
    NA: { short: '—', long: '未比较输出' }
}

export const verdictLabel = (v: Verdict): { short: string; long: string } => labels[v]

/** CSS class suffix: groups similar verdicts onto the theme's verdict colors. */
export function verdictTone(v: Verdict): string {
    switch (v) {
        case 'AC':
            return 'ac'
        case 'WA':
        case 'PE':
            return 'wa'
        case 'TLE':
        case 'OLE':
            return 'tle'
        case 'MLE':
            return 'mle'
        case 'RE':
        case 'SE':
            return 're'
        case 'CE':
            return 'ce'
        default:
            return 'pending'
    }
}

export function fmtMem(kb?: number): string {
    if (kb === undefined) return ''
    return kb >= 1024 ? `${(kb / 1024).toFixed(kb >= 10240 ? 0 : 1)} MB` : `${kb} KB`
}
