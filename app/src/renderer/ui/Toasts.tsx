import { useApp } from '../state/app'

export function Toasts() {
    const toasts = useApp((s) => s.toasts)
    return (
        <div className="nv-toasts">
            {toasts.map((t) => (
                <div key={t.id} className={`nv-toast is-${t.kind}`}>
                    {t.text}
                </div>
            ))}
        </div>
    )
}
