import { useLayoutEffect, useRef } from 'react'

const EASE = 'cubic-bezier(.22, 1, .36, 1)'

/** Each animation owns its media listener; cancellation/unmount never leaves a callback behind. */
export function playMotion(
    element: HTMLElement,
    frames: Keyframe[],
    duration = 220,
    options: Pick<KeyframeAnimationOptions, 'easing' | 'fill'> = {}
): Animation | null {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches) return null
    const animation = element.animate(frames, { duration, easing: EASE, ...options })
    const reduce = (): void => {
        if (preference.matches) animation.finish()
    }
    const cleanup = (): void => {
        preference.removeEventListener('change', reduce)
        animation.removeEventListener('finish', cleanup)
        animation.removeEventListener('cancel', cleanup)
    }
    preference.addEventListener('change', reduce)
    animation.addEventListener('finish', cleanup)
    animation.addEventListener('cancel', cleanup)
    return animation
}

/** Animate the existing node, preserving its children, focus and in-flight effects. */
export function useContentMotion(key: unknown) {
    const ref = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        const animation =
            ref.current &&
            playMotion(ref.current, [
                { opacity: 0, transform: 'translateY(5px)' },
                { opacity: 1, transform: 'translateY(0)' }
            ])
        return () => animation?.cancel()
    }, [key])
    return ref
}

/** Observe natural inner content, never the viewport whose height we write. */
export function observeContentHeight(viewport: HTMLElement, content: HTMLElement, maxHeight: () => number): () => void {
    const original = viewport.style.height
    let target: number | undefined,
        animation: Animation | null = null
    const measure = (): void => {
        const style = getComputedStyle(viewport)
        const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
        // Layout sizes ignore the dialog's opening scale transform.
        const next = Math.max(0, Math.min(Math.ceil(content.offsetHeight + padding), maxHeight()))
        if (next === target) return
        const from = viewport.offsetHeight
        animation?.cancel()
        viewport.style.height = `${next}px`
        if (target !== undefined)
            animation = playMotion(viewport, [{ height: `${from}px` }, { height: `${next}px` }], 280)
        target = next
    }
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    window.addEventListener('resize', measure)
    measure()
    return () => {
        observer.disconnect()
        window.removeEventListener('resize', measure)
        animation?.cancel()
        viewport.style.height = original
    }
}
