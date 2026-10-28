import { useCallback, useEffect, useRef, useState, type DependencyList, type ReactNode } from 'react'
import { useContentMotion } from './motion'

/** Refreshes keep the last valid value; a different resource never displays its predecessor. */
export function useAsyncResource<T>(identity: unknown, load: () => Promise<T>, dependencies: DependencyList = []) {
    const request = useRef(load)
    request.current = load
    const [revision, setRevision] = useState(0)
    const [state, setState] = useState<{ identity: unknown; data?: T; pending: boolean; error?: string }>({
        identity,
        pending: true
    })
    useEffect(() => {
        let alive = true
        const run = request.current
        setState((previous) => ({
            identity,
            data: previous.identity === identity ? previous.data : undefined,
            pending: true
        }))
        void Promise.resolve()
            .then(run)
            .then(
                (data) => {
                    if (alive) setState({ identity, data, pending: false })
                },
                (error) => {
                    if (alive)
                        setState((previous) => ({
                            ...previous,
                            pending: false,
                            error: error instanceof Error ? error.message : String(error)
                        }))
                }
            )
        return () => {
            alive = false
        }
    }, [identity, revision, ...dependencies])
    const reload = useCallback(() => setRevision((value) => value + 1), [])
    return {
        data: state.identity === identity ? state.data : undefined,
        pending: state.identity !== identity || state.pending,
        error: state.identity === identity ? state.error : undefined,
        reload
    }
}

export function AsyncContent({
    pending,
    ready,
    error,
    label = '正在加载…',
    children,
    className = ''
}: {
    pending: boolean
    ready: boolean
    error?: string
    label?: string
    children: ReactNode
    className?: string
}) {
    const content = useContentMotion(ready)
    return (
        <div className={`nv-async ${className}`} aria-busy={pending}>
            {pending && !ready && (
                <div className="nv-loading" role="status">
                    <span className="nv-loading-dot" />
                    {label}
                </div>
            )}
            {pending && ready && <span className="nv-loading-mark" role="status" aria-label={label} title={label} />}
            {ready && (
                <div ref={content} className="nv-async-content">
                    {children}
                </div>
            )}
            {error && (
                <div className="nv-async-error" role="status">
                    {error}
                </div>
            )}
        </div>
    )
}
