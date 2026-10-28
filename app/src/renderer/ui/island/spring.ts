// Tiny interruptible spring animator for the dynamic island. Animates numeric CSS properties on one
// element; retargeting mid-flight keeps the current velocity (no restart jerk, unlike CSS transitions).
import { useLayoutEffect, useRef } from 'react'

export interface SpringConfig {
    stiffness: number
    damping: number
    mass: number
}

/** Close to critically damped (ratio 0.9): it glides and settles with barely a trace of overshoot. */
export const ISLAND_SPRING: SpringConfig = { stiffness: 300, damping: 31, mass: 1 }

type Values = Record<string, number>

export function useSpringStyle<T extends HTMLElement>(
    target: Values,
    apply: (el: T, v: Values) => void,
    cfg = ISLAND_SPRING
) {
    const ref = useRef<T>(null)
    const state = useRef<{ pos: Values; vel: Values; raf: number; last: number } | null>(null)

    useLayoutEffect(() => {
        const el = ref.current
        if (!el) return
        if (!state.current) {
            // first paint: jump to the target, no animation
            state.current = {
                pos: { ...target },
                vel: Object.fromEntries(Object.keys(target).map((k) => [k, 0])),
                raf: 0,
                last: 0
            }
            apply(el, target)
            return
        }
        const s = state.current
        const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
        cancelAnimationFrame(s.raf)
        if (preference.matches) {
            s.pos = { ...target }
            s.vel = Object.fromEntries(Object.keys(target).map((k) => [k, 0]))
            s.raf = 0
            apply(el, target)
            return
        }
        s.last = performance.now()
        const step = (now: number): void => {
            if (preference.matches) {
                s.pos = { ...target }
                s.vel = Object.fromEntries(Object.keys(target).map((k) => [k, 0]))
                s.raf = 0
                apply(el, target)
                return
            }
            const dt = Math.min((now - s.last) / 1000, 1 / 30)
            s.last = now
            let moving = false
            for (const k of Object.keys(target)) {
                const x = s.pos[k] ?? target[k]
                const v = s.vel[k] ?? 0
                const force = -cfg.stiffness * (x - target[k]) - cfg.damping * v
                const nv = v + (force / cfg.mass) * dt
                const nx = x + nv * dt
                s.vel[k] = nv
                s.pos[k] = nx
                if (Math.abs(nx - target[k]) > 0.05 || Math.abs(nv) > 0.05) moving = true
            }
            if (!moving) s.pos = { ...target }
            apply(el, s.pos)
            if (moving) s.raf = requestAnimationFrame(step)
        }
        s.raf = requestAnimationFrame(step)
        return () => cancelAnimationFrame(s.raf)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(target)])

    return ref
}
