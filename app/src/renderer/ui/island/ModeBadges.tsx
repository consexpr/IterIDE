import type { JudgeModeInfo } from '../../../shared/judgeMode'

/** The judge-mode badges (mode, checker/interactor/grader files, limits, IO, data source). */
export function ModeBadges({
    info,
    dark = false,
    onClick
}: {
    info: JudgeModeInfo
    dark?: boolean
    onClick?: () => void
}) {
    return (
        <div
            className={`nv-badges ${dark ? 'is-dark' : ''} ${onClick ? 'is-clickable' : ''}`}
            onClick={onClick}
            data-mode={info.modeId}
        >
            <span className="nv-badge is-mode">{info.modeName}</span>
            {info.badges
                .filter((b) => b.value !== info.modeName) // the mode itself is already the first badge
                .map((b, i) => (
                    <span key={i} className={`nv-badge tone-${b.tone ?? 'normal'}`} title={b.detail ?? b.file}>
                        <span className="nv-badge-label">{b.label}</span>
                        {b.value && <span className="nv-badge-value">{b.value}</span>}
                    </span>
                ))}
        </div>
    )
}
