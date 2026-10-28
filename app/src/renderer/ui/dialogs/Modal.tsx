import { useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { store } from '../../state/app'
import { Icon } from '../Icon'
import { observeContentHeight, playMotion } from '../motion'

export function close(): void {
    store.set({ dialog: null })
}

export function Modal(props: {
    title: string
    width?: number
    children: React.ReactNode
    footer?: React.ReactNode
    smoothSize?: boolean
    className?: string
}) {
    const shell = useRef<HTMLDivElement>(null),
        body = useRef<HTMLDivElement>(null)
    const header = useRef<HTMLDivElement>(null),
        footer = useRef<HTMLDivElement>(null)
    const leaving = useRef<Animation | null>(null)
    const dismiss = useCallback(() => {
        if (leaving.current) return
        if (!props.smoothSize || !shell.current) return close()
        const owner = store.get().dialog
        const current = getComputedStyle(shell.current)
        const animation = playMotion(
            shell.current,
            [
                { opacity: current.opacity, transform: current.transform },
                { opacity: 0, transform: 'scale(.96)' }
            ],
            150
        )
        if (!animation) return close()
        leaving.current = animation
        void animation.finished
            .then(() => {
                leaving.current = null
                if (store.get().dialog === owner) close()
            })
            .catch(() => {
                if (leaving.current === animation) leaving.current = null
            })
    }, [props.smoothSize])
    useEffect(() => () => leaving.current?.cancel(), [])
    useLayoutEffect(() => {
        if (!props.smoothSize || !body.current) return
        const content = body.current.firstElementChild
        if (!(content instanceof HTMLElement) || body.current.childElementCount !== 1) return
        return observeContentHeight(body.current, content, () =>
            Math.max(
                0,
                window.innerHeight * 0.8 - (header.current?.offsetHeight ?? 0) - (footer.current?.offsetHeight ?? 0) - 2
            )
        )
    }, [props.smoothSize])
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') dismiss()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [dismiss])
    return (
        <div className="nv-backdrop" onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
            <div
                ref={shell}
                className={`nv-modal ${props.smoothSize ? 'is-smooth' : ''} ${props.className ?? ''}`}
                style={{ width: props.width ?? 520 }}
                role="dialog"
                aria-label={props.title}
            >
                <div ref={header} className="nv-modal-head">
                    <h3>{props.title}</h3>
                    <button className="nv-icon-btn" onClick={dismiss} aria-label="关闭">
                        <Icon name="x" size={14} />
                    </button>
                </div>
                <div ref={body} className="nv-modal-body">
                    {props.children}
                </div>
                {props.footer && (
                    <div ref={footer} className="nv-modal-foot">
                        {props.footer}
                    </div>
                )}
            </div>
        </div>
    )
}

export function Field(props: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <label className="nv-field">
            <span className="nv-field-label">
                {props.label}
                {props.hint && <span className="nv-faint"> · {props.hint}</span>}
            </span>
            {props.children}
        </label>
    )
}

export function Segmented<T extends string>(props: {
    value: T
    options: { value: T; label: string }[]
    onChange: (v: T) => void
}) {
    return (
        <div className="nv-seg">
            {props.options.map((o) => (
                <button
                    key={o.value}
                    className={o.value === props.value ? 'is-on' : ''}
                    onClick={() => props.onChange(o.value)}
                    type="button"
                >
                    {o.label}
                </button>
            ))}
        </div>
    )
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <label className="nv-switch">
            <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
            <span className="nv-switch-track" />
            <span>{props.label}</span>
        </label>
    )
}
