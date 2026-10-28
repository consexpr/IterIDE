import { useLayoutEffect, useRef, useState } from 'react'
import { playMotion } from './motion'

/** Retain the same form through close/reopen; animation never remounts inputs or steals focus. */
export function useFindMotion(open: boolean) {
    const ref = useRef<HTMLElement>(null)
    const animation = useRef<Animation | null>(null)
    const [present, setPresent] = useState(open)
    useLayoutEffect(() => {
        const node = ref.current
        if (!node) return
        const css = getComputedStyle(node)
        const interrupted = animation.current?.playState === 'running'
        const opacity = css.opacity,
            transform = css.transform
        animation.current?.cancel()
        node.style.visibility = ''
        if (open) setPresent(true)
        const amount = css.getPropertyValue('--search-offset').trim() || '5px'
        const scale = css.getPropertyValue('--search-scale').trim() || '.98'
        const requested = `translateY(calc(-1 * ${amount})) scale(${scale})`
        const small = CSS.supports('transform', requested) ? requested : 'translateY(-5px) scale(.98)'
        const durationText = css.getPropertyValue(open ? '--search-open-duration' : '--search-close-duration').trim()
        const milliseconds = parseFloat(durationText) * (durationText.endsWith('ms') ? 1 : 1000)
        const duration = Number.isFinite(milliseconds) ? Math.max(0, Math.min(2000, milliseconds)) : open ? 220 : 150
        const easing = css.getPropertyValue('--search-easing').trim()
        const current = playMotion(
            node,
            [
                {
                    opacity: interrupted ? opacity : open ? 0 : 1,
                    transform: interrupted ? transform : open ? small : 'none'
                },
                { opacity: open ? 1 : 0, transform: open ? 'none' : small }
            ],
            duration,
            {
                easing: CSS.supports('animation-timing-function', easing) ? easing : 'cubic-bezier(.2,.8,.2,1)',
                fill: 'both'
            }
        )
        animation.current = current
        if (!current) {
            setPresent(open)
            return
        }
        void current.finished
            .then(() => {
                if (animation.current !== current) return
                if (!open) {
                    node.style.visibility = 'hidden'
                    setPresent(false)
                }
                current.cancel()
                animation.current = null
            })
            .catch(() => {})
    }, [open])
    useLayoutEffect(() => () => animation.current?.cancel(), [])
    return { ref, present: open || present }
}
