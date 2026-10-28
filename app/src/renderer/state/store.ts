import { useMemo, useSyncExternalStore } from 'react'

/** Minimal external store: immutable top-level state + selector hook. */
export class Store<S extends object> {
    private listeners = new Set<() => void>()
    constructor(private state: S) {}

    get = (): S => this.state

    set = (patch: Partial<S> | ((s: S) => Partial<S>)): void => {
        const p = typeof patch === 'function' ? patch(this.state) : patch
        this.state = { ...this.state, ...p }
        for (const l of this.listeners) l()
    }

    subscribe = (l: () => void): (() => void) => {
        this.listeners.add(l)
        return () => this.listeners.delete(l)
    }
}

export function useStore<S extends object, T>(
    store: Store<S>,
    selector: (s: S) => T,
    equal: (a: T, b: T) => boolean = Object.is
): T {
    const snapshot = useMemo(() => {
        let initialized = false
        let state: S
        let selected: T
        return (): T => {
            const nextState = store.get()
            if (initialized && state === nextState) return selected
            const next = selector(nextState)
            state = nextState
            if (!initialized || !equal(selected, next)) selected = next
            initialized = true
            return selected
        }
    }, [store, selector, equal])
    return useSyncExternalStore(store.subscribe, snapshot)
}
