import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { addTest } from '../actions/tests'
import { store, toast, useApp, type FileState } from '../state/app'
import { TestCard } from './TestCard'
import { Icon } from './Icon'
import { visibleRows } from './testListModel'

function MeasuredRow({
    id,
    top,
    measure,
    children
}: {
    id: string
    top: number
    measure(id: string, height: number): void
    children: ReactNode
}) {
    const host = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
        const element = host.current!
        const report = (): void => measure(id, element.getBoundingClientRect().height)
        const observer = new ResizeObserver(report)
        observer.observe(element)
        report()
        return () => observer.disconnect()
    }, [id, measure])
    return (
        <div ref={host} className="nv-virtual-row" data-test-id={id} style={{ top }}>
            {children}
        </div>
    )
}

/** Cards outside the viewport are unmounted; the keyboard-focused editor remains mounted. */
export function TestList({ file }: { file: FileState }) {
    const host = useRef<HTMLDivElement>(null)
    const sizes = useRef(new Map<string, { height: number; expanded: boolean }>())
    const [sizeRevision, setSizeRevision] = useState(0)
    const scrollAdjustment = useRef(0)
    const [viewport, setViewport] = useState({ top: 0, height: 600 })
    const [pinned, setPinned] = useState<string | null>(null)
    const [jump, setJump] = useState<{ id: string } | null>(null)
    const expanded = useApp((s) => s.expanded)
    const rows = useMemo(() => file.tests.map((test, index) => ({ test, index })), [file.tests])
    const offsets = useMemo(() => {
        const values = [0]
        for (const { test } of rows) {
            const open = expanded[`${file.path}#${test.id}`] ?? false
            const measured = sizes.current.get(test.id)
            values.push(values[values.length - 1] + (measured?.expanded === open ? measured.height : open ? 330 : 44))
        }
        return values
    }, [rows, expanded, file.path, sizeRevision])
    const layout = useRef({ rows, offsets })
    layout.current = { rows, offsets }
    const measure = useCallback(
        (id: string, height: number) => {
            const open = expanded[`${file.path}#${id}`] ?? false
            const previous = sizes.current.get(id)
            if (!height || (previous?.expanded === open && Math.abs(previous.height - height) < 0.5)) return
            const { rows, offsets } = layout.current
            const index = rows.findIndex(({ test }) => test.id === id)
            if (host.current && index >= 0 && offsets[index + 1] <= host.current.scrollTop) {
                scrollAdjustment.current += height - (offsets[index + 1] - offsets[index])
            }
            sizes.current.set(id, { height, expanded: open })
            setSizeRevision((revision) => revision + 1)
        },
        [expanded, file.path]
    )
    useLayoutEffect(() => {
        if (host.current && scrollAdjustment.current) {
            host.current.scrollTop += scrollAdjustment.current
            scrollAdjustment.current = 0
            setViewport({ top: host.current.scrollTop, height: host.current.clientHeight })
        }
    }, [offsets])
    useEffect(() => {
        const ids = new Set(file.tests.map((test) => test.id))
        for (const id of sizes.current.keys()) if (!ids.has(id)) sizes.current.delete(id)
    }, [file.tests])
    useEffect(() => {
        const element = host.current!
        let frame = 0,
            width = element.clientWidth
        const update = (): void => {
            cancelAnimationFrame(frame)
            frame = requestAnimationFrame(() => setViewport({ top: element.scrollTop, height: element.clientHeight }))
        }
        const resize = new ResizeObserver(() => {
            if (width !== element.clientWidth) {
                width = element.clientWidth
                sizes.current.clear()
                setSizeRevision((revision) => revision + 1)
            }
            update()
        })
        resize.observe(element)
        element.addEventListener('scroll', update, { passive: true })
        update()
        return () => {
            cancelAnimationFrame(frame)
            resize.disconnect()
            element.removeEventListener('scroll', update)
        }
    }, [])
    useLayoutEffect(() => {
        if (!jump) return
        const index = rows.findIndex(({ test }) => test.id === jump.id)
        if (index < 0) {
            setJump(null)
            return
        }
        const element = host.current!
        element.scrollTop = offsets[index]
        setViewport({ top: element.scrollTop, height: element.clientHeight })
        const row = [...element.querySelectorAll<HTMLElement>('[data-test-id]')].find(
            (item) => item.dataset.testId === jump.id
        )
        if (row) {
            row.querySelector<HTMLElement>('[data-test-toggle]')?.focus({ preventScroll: true })
            setJump(null)
        }
    }, [jump, offsets, rows, viewport.top])
    const locate = (id: string): void => {
        store.set((s) => ({ focused: `${file.path}#${id}`, expanded: { ...s.expanded, [`${file.path}#${id}`]: true } }))
        setJump({ id })
    }
    const [start, end] = visibleRows(offsets, viewport.top, viewport.height)
    const indices = new Set(Array.from({ length: end - start }, (_, index) => start + index))
    const pinnedIndex = rows.findIndex(({ test }) => test.id === pinned)
    if (pinnedIndex >= 0) indices.add(pinnedIndex)
    return (
        <div
            className="nv-tests nv-tests-windowed"
            ref={host}
            onFocusCapture={(event) =>
                setPinned((event.target as HTMLElement).closest<HTMLElement>('[data-test-id]')?.dataset.testId ?? null)
            }
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) setPinned(null)
            }}
            onKeyDown={(event) => {
                const target = event.target as HTMLElement
                if (!target.hasAttribute('data-test-toggle') || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
                const id = target.closest<HTMLElement>('[data-test-id]')?.dataset.testId
                const index = rows.findIndex(({ test }) => test.id === id)
                const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
                if (next) {
                    event.preventDefault()
                    setJump({ id: next.test.id })
                }
            }}
        >
            {!rows.length && <p className="nv-test-empty">添加测试点，或拖入数据文件开始评测。</p>}
            <div className="nv-virtual-tests" style={{ height: offsets[offsets.length - 1] }}>
                {[...indices]
                    .sort((a, b) => a - b)
                    .map((index) => {
                        const { test, index: originalIndex } = rows[index]
                        return (
                            <MeasuredRow key={test.id} id={test.id} top={offsets[index]} measure={measure}>
                                <TestCard file={file} test={test} index={originalIndex} />
                            </MeasuredRow>
                        )
                    })}
            </div>
            <button
                className="nv-add-test"
                onClick={() =>
                    void (async () => {
                        const before = new Set(file.tests.map((test) => test.id))
                        await addTest()
                        const added = store
                            .get()
                            .files.find((row) => row.path === file.path)
                            ?.tests.find((test) => !before.has(test.id))
                        if (added) locate(added.id)
                    })().catch((error: Error) => toast(error.message, 'error'))
                }
            >
                <Icon name="plus" size={14} /> 添加测试点
            </button>
        </div>
    )
}
