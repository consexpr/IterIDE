import { useEffect, useRef } from 'react'
import { load, save } from '../../util/storage'

const KEY = 'iter.sideWidth'
const setWidth = (w: number): void => document.documentElement.style.setProperty('--side-width', `${w}px`)

/** Drag handle between editor and side panel; width persists per machine. */
export function Resizer() {
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        const w = load<number>(KEY, 0)
        if (w) setWidth(w)
    }, [])
    const onDown = (e: React.PointerEvent): void => {
        const el = ref.current!
        el.setPointerCapture(e.pointerId)
        const move = (ev: PointerEvent): void => {
            const w = Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, 320), window.innerWidth * 0.6))
            setWidth(w)
            save(KEY, w)
        }
        const up = (): void => {
            el.removeEventListener('pointermove', move)
            el.removeEventListener('pointerup', up)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
    }
    return <div ref={ref} className="nv-resizer" onPointerDown={onDown} />
}
