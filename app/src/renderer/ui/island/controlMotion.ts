import { useLayoutEffect, useRef } from 'react'
import { playMotion } from '../motion'

/** Animate flex width instead of scaling text. Retarget from the visible width on quick reversals. */
export function useControlMotion(mode: string | undefined) {
    const ref = useRef<HTMLDivElement>(null)
    const previous = useRef<{ element: HTMLElement; width: number; animation: Animation | null } | null>(null)
    useLayoutEffect(() => {
        const element = ref.current?.querySelector<HTMLElement>('.nvi-run-kind')
        if (!element) return
        const old = previous.current
        const from = old?.animation?.playState === 'running' ? element.offsetWidth : old?.width
        old?.animation?.cancel()
        const width = element.offsetWidth
        const animation =
            old?.element === element && from !== undefined && Math.abs(from - width) > 0.5
                ? playMotion(
                      element,
                      [
                          { flexBasis: from + 'px', flexGrow: 0, flexShrink: 0 },
                          { flexBasis: width + 'px', flexGrow: 0, flexShrink: 0 }
                      ],
                      260
                  )
                : null
        previous.current = { element, width, animation }
    }, [mode])
    useLayoutEffect(
        () => () => {
            previous.current?.animation?.cancel()
            previous.current = null
        },
        []
    )
    return ref
}
