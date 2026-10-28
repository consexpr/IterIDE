// The dynamic island: one persistent black capsule in the title bar. Its size follows the content
// through a spring (interruptible), and content crossfades with a blur, like the iPhone island.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Verdict } from '../../../shared/judge'
import { activeFile, isDebugging, useApp } from '../../state/app'
import { closeIsland, openIsland } from './state'
import { useSpringStyle } from './spring'
import {
    compilingView,
    debugView,
    emptyView,
    idleView,
    panelView,
    resultView,
    runningView,
    type IslandView
} from './views'

const PAD_X = 12
const RESULT_MS = 2200

export function DynamicIsland() {
    const view = useIslandView()
    const measure = useRef<HTMLDivElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const [compactWidth, setCompactWidth] = useState(120)
    const width = view.width ?? compactWidth
    // keep the outgoing content briefly so it can fade out while the new one fades in
    const last = useRef<{ view: IslandView; width: number; snapshot?: HTMLElement }>({ view, width })
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
    const [prev, setPrev] = useState<{ view: IslandView; width: number; snapshot?: HTMLElement } | null>(null)
    useLayoutEffect(() => {
        const old = last.current
        last.current = {
            view,
            width,
            snapshot: view.height === 'auto' && panelRef.current ? freezePanel(panelRef.current) : undefined
        }
        if (old.view.key === view.key) return
        // Retain only frozen DOM for a closing form; never remount its effects or IPC subscriptions.
        setPrev(old.view.height === 'auto' && !old.snapshot ? null : old)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setPrev(null), 260)
    })
    useEffect(() => () => clearTimeout(timer.current), [])
    const layers = { cur: view, prev: prev?.view ?? null }

    useLayoutEffect(() => {
        if (!view.width && measure.current)
            setCompactWidth(Math.max(120, Math.ceil(measure.current.offsetWidth) + PAD_X * 2))
    })

    // expanded panels size their height to the content (and follow it as it changes)
    const [autoH, setAutoH] = useState(30)
    useLayoutEffect(() => {
        if (view.height !== 'auto' || !panelRef.current) return
        const el = panelRef.current
        // scrollHeight includes animated descendants' overflow; offsetHeight is stable natural layout.
        const measureNow = (): void => setAutoH(Math.min(el.offsetHeight, window.innerHeight * 0.8))
        measureNow()
        const ro = new ResizeObserver(measureNow)
        ro.observe(el)
        window.addEventListener('resize', measureNow)
        return () => {
            ro.disconnect()
            window.removeEventListener('resize', measureNow)
        }
    }, [view.key, view.height])

    // click outside / Esc collapses an expanded island
    const open = view.height === 'auto'
    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent): void => {
            if (!(e.target as HTMLElement).closest('.nvi')) closeIsland()
        }
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') closeIsland()
        }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
            window.removeEventListener('mousedown', onDown)
            window.removeEventListener('keydown', onKey)
        }
    }, [open])

    const h = layers.cur.height === 'auto' ? autoH : layers.cur.height
    // capsules are fully round; the expanded panel keeps the soft rounded-rect of the iPhone island.
    // A theme may square it through --r-island: the stylesheet caps the sprung radius, so a theme
    // switch takes effect immediately instead of depending on when this component last rendered.
    const radius = open ? 28 : h / 2
    const ref = useSpringStyle<HTMLDivElement>({ w: width, h, r: radius }, (el, v) => {
        el.style.width = `${v.w}px`
        el.style.height = `${v.h}px`
        el.style.setProperty('--nvi-r', `${Math.max(v.r, 0)}px`)
    })

    return (
        <div className="nvi-slot">
            <div
                ref={ref}
                className={`nvi ${layers.cur.onClick ? 'is-clickable' : ''} ${open ? 'is-open' : ''}`}
                data-state={layers.cur.key.split(':')[0]}
                data-tone={layers.cur.tone}
                onClick={layers.cur.onClick}
            >
                {layers.prev && (
                    <div
                        key={`prev-${layers.prev.key}`}
                        className={`nvi-layer is-out ${layers.prev.height === 'auto' ? 'is-panel' : ''}`}
                        aria-hidden="true"
                        inert
                        style={{ '--nvi-layer-w': `${prev!.width}px` } as React.CSSProperties}
                    >
                        {prev?.snapshot ? <FrozenPanel snapshot={prev.snapshot} /> : layers.prev.node}
                    </div>
                )}
                {/* Content is laid out once at its final width and merely clipped while the shell springs open,
            so nothing reflows on every animation frame. */}
                <div
                    key={layers.cur.key}
                    className={`nvi-layer is-in ${open ? 'is-panel' : ''}`}
                    style={{ '--nvi-layer-w': `${width}px` } as React.CSSProperties}
                >
                    {open ? <div ref={panelRef}>{layers.cur.node}</div> : layers.cur.node}
                </div>
            </div>
            {/* invisible copy used to measure the natural width of the incoming content */}
            {!view.width && (
                <div className="nvi-measure" aria-hidden>
                    <div ref={measure}>{layers.cur.node}</div>
                </div>
            )}
        </div>
    )
}

function freezePanel(element: HTMLElement): HTMLElement {
    const snapshot = element.cloneNode(true) as HTMLElement
    const inputs = element.querySelectorAll('input')
    snapshot.querySelectorAll('input').forEach((input, index) => {
        input.value = inputs[index].value
        input.checked = inputs[index].checked
    })
    return snapshot
}

/** Purely visual exit layer; inert at the parent, with no React controls or event handlers. */
function FrozenPanel({ snapshot }: { snapshot: HTMLElement }) {
    const ref = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        ref.current?.replaceChildren(snapshot)
    }, [snapshot])
    return <div ref={ref} />
}

/** Map app state → island view. The run result "pops" for a moment, then settles to idle. */
function useIslandView(): IslandView {
    const f = useApp((s) => activeFile(s))
    const debugging = useApp((s) => isDebugging(s))
    const islandOpen = useApp((s) => s.islandOpen)
    const dstate = useApp((s) => s.debug.state)
    const [flash, setFlash] = useState<string | null>(null) // path whose result is popping
    const prevRun = useRef<string | null>(null)

    // a run just finished → pop the result
    const runId = f?.runId ?? null
    useEffect(() => {
        const was = prevRun.current
        prevRun.current = runId
        if (was && !runId && f?.lastVerdict) setFlash(f.path)
    }, [runId, f?.lastVerdict, f?.path])
    useEffect(() => {
        if (!flash) return
        const t = setTimeout(() => setFlash(null), RESULT_MS)
        return () => clearTimeout(t)
    }, [flash])

    if (debugging) return debugView(dstate)
    if (!f?.problem) return emptyView()
    if (islandOpen) return panelView()
    const p = f.problem
    const enabled = p.tests.filter((t) => t.enabled)
    const results = enabled.map((t) => f.results[t.id]).filter(Boolean)
    const done = results.filter((r) => !['PENDING', 'RUNNING'].includes(r.verdict))
    if (f.runId && !f.compile) return compilingView()
    if (f.runId)
        return runningView(
            done.length,
            enabled.length,
            done.filter((r) => r.verdict !== 'AC' && r.verdict !== 'NA').length
        )
    if (flash === f.path && f.lastVerdict) {
        const judged = done.filter((r) => r.verdict !== 'NA')
        const passed = judged.filter((r) => r.verdict === 'AC').length
        const maxTime = done.reduce((m, r) => Math.max(m, r.timeMs), 0)
        const mems = done.map((r) => r.memoryKb).filter((m): m is number => m !== undefined)
        return resultView(
            f.lastVerdict as Verdict,
            passed,
            judged.length,
            maxTime,
            mems.length ? Math.max(...mems) : undefined
        )
    }
    return idleView(f.name.replace(/\.(cpp|cc|cxx)$/i, ''), p, f.lastVerdict, openIsland)
}
