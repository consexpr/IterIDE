import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import { moveFile } from '../actions/files'
import { playMotion } from './motion'

interface Drag {
    path: string
    tab: HTMLElement
    pointerId: number
    startX: number
    scrollLeft: number
    x: number
    y: number
    active: boolean
}
const tabs = (bar: HTMLElement): HTMLElement[] => [...bar.querySelectorAll<HTMLElement>('.nv-tab[data-path]')]

/** Pointer capture keeps sorting inside the tab strip, independent of OS file drag-and-drop. */
export function useTabReorder() {
    const ref = useRef<HTMLDivElement>(null)
    const drag = useRef<Drag | null>(null)
    const frame = useRef(0)
    const suppressClick = useRef(false)
    const positions = useRef<Map<string, number> | null>(null)
    const animations = useRef<Animation[]>([])
    const [dragging, setDragging] = useState<string | null>(null)
    const [marker, setMarker] = useState<number | null>(null)

    const destination = (current: Drag): { before: string | null; left: number } | null => {
        const bar = ref.current
        if (!bar) return null
        const box = bar.getBoundingClientRect()
        if (current.y < box.top || current.y > box.bottom || current.x < box.left || current.x > box.right) return null
        const candidates = tabs(bar).filter((tab) => tab.dataset.path !== current.path)
        const before = candidates.find((tab) => {
            const bounds = tab.getBoundingClientRect()
            return current.x < bounds.left + bounds.width / 2
        })
        const last = candidates.at(-1)
        return {
            before: before?.dataset.path ?? null,
            left: before ? before.offsetLeft : last ? last.offsetLeft + last.offsetWidth : 0
        }
    }
    const finish = (commit: boolean): void => {
        const current = drag.current,
            bar = ref.current
        drag.current = null
        cancelAnimationFrame(frame.current)
        frame.current = 0
        if (!current || !bar) return
        if (current.active) {
            const target = commit ? destination(current) : null
            positions.current = new Map(tabs(bar).map((tab) => [tab.dataset.path!, tab.getBoundingClientRect().left]))
            current.tab.style.removeProperty('transform')
            if (target) moveFile(current.path, target.before)
        }
        if (bar.hasPointerCapture(current.pointerId)) bar.releasePointerCapture(current.pointerId)
        setDragging(null)
        setMarker(null)
    }
    const tick = (): void => {
        const current = drag.current,
            bar = ref.current
        if (!current?.active || !bar) return
        const box = bar.getBoundingClientRect()
        const edge = Math.min(40, box.width / 4)
        const inside =
            current.y >= box.top && current.y <= box.bottom && current.x >= box.left && current.x <= box.right
        const speed = !inside
            ? 0
            : current.x < box.left + edge
              ? -Math.min(1, (box.left + edge - current.x) / edge)
              : current.x > box.right - edge
                ? Math.min(1, (current.x - box.right + edge) / edge)
                : 0
        bar.scrollLeft += speed * 9
        current.tab.style.transform = `translateX(${current.x - current.startX + bar.scrollLeft - current.scrollLeft}px)`
        setMarker(destination(current)?.left ?? null)
        frame.current = requestAnimationFrame(tick)
    }
    useLayoutEffect(() => {
        if (!positions.current || !ref.current) return
        for (const tab of tabs(ref.current)) {
            const previous = positions.current.get(tab.dataset.path!)
            if (previous === undefined) continue
            const offset = previous - tab.getBoundingClientRect().left
            if (Math.abs(offset) < 1) continue
            const animation = playMotion(tab, [{ transform: `translateX(${offset}px)` }, { transform: 'none' }], 180)
            if (animation) animations.current.push(animation)
        }
        positions.current = null
    })
    useEffect(() => {
        const cancel = (): void => finish(false)
        const escape = (event: KeyboardEvent): void => {
            if (event.key !== 'Escape' || !drag.current?.active) return
            event.preventDefault()
            event.stopPropagation()
            cancel()
        }
        window.addEventListener('blur', cancel)
        window.addEventListener('keydown', escape, true)
        return () => {
            window.removeEventListener('blur', cancel)
            window.removeEventListener('keydown', escape, true)
            cancelAnimationFrame(frame.current)
            drag.current?.tab.style.removeProperty('transform')
            animations.current.forEach((animation) => animation.cancel())
        }
    }, [])

    return {
        ref,
        dragging,
        marker,
        handlers: {
            onPointerDown(event: PointerEvent<HTMLDivElement>): void {
                suppressClick.current = false
                if (
                    event.button !== 0 ||
                    !event.isPrimary ||
                    !(event.target instanceof Element) ||
                    event.target.closest('button')
                )
                    return
                const tab = event.target.closest<HTMLElement>('.nv-tab[data-path]')
                if (!tab || !ref.current) return
                animations.current.forEach((animation) => animation.cancel())
                animations.current = []
                drag.current = {
                    path: tab.dataset.path!,
                    tab,
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    scrollLeft: ref.current.scrollLeft,
                    x: event.clientX,
                    y: event.clientY,
                    active: false
                }
            },
            onPointerMove(event: PointerEvent<HTMLDivElement>): void {
                const current = drag.current
                if (!current || current.pointerId !== event.pointerId) return
                current.x = event.clientX
                current.y = event.clientY
                if (!current.active && Math.abs(current.x - current.startX) >= 5) {
                    current.active = true
                    suppressClick.current = true
                    event.currentTarget.setPointerCapture(event.pointerId)
                    setDragging(current.path)
                    tick()
                }
                if (current.active) event.preventDefault()
            },
            onPointerUp(event: PointerEvent<HTMLDivElement>): void {
                if (event.pointerId !== drag.current?.pointerId) return
                drag.current.x = event.clientX
                drag.current.y = event.clientY
                finish(true)
            },
            onPointerLeave(): void {
                if (drag.current && !drag.current.active) finish(false)
            },
            onPointerCancel(): void {
                finish(false)
            },
            onLostPointerCapture(): void {
                finish(false)
            },
            onClickCapture(event: React.MouseEvent): void {
                if (!suppressClick.current) return
                suppressClick.current = false
                event.preventDefault()
                event.stopPropagation()
            }
        }
    }
}
