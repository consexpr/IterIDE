import { useEffect, useMemo, useRef, useState } from 'react'
import { AsyncContent, useAsyncResource } from '../AsyncContent'

/** First family of a CSS font-family list, without quotes. */
export const primaryFamily = (stack: string): string =>
    stack
        .split(',')[0]
        ?.trim()
        .replace(/^["']|["']$/g, '') ?? ''

/** Replace the first family of the stack with `family`, keeping the fallbacks. */
function withPrimary(stack: string, family: string): string {
    const unquote = (s: string): string => s.trim().replace(/^["']|["']$/g, '')
    const fallbacks = stack
        .split(',')
        .slice(1)
        .filter((s) => s.trim() && unquote(s) !== family)
        .map((s) => s.trim())
    return [`"${family}"`, ...fallbacks].join(', ')
}

/**
 * Font family editor: the raw CSS stack stays editable as text; below it a searchable list of
 * installed fonts, each rendered in its own face. Picking one makes it the first family.
 */
export function FontPicker(props: { value: string; onChange: (v: string) => void; monospaceFirst?: boolean }) {
    const resource = useInstalledFonts()
    const all = resource.data ?? []
    const [query, setQuery] = useState('')
    const current = primaryFamily(props.value)
    const list = useMemo(() => {
        const q = query.trim().toLowerCase()
        const hits = all.filter((f) => !q || f.toLowerCase().includes(q))
        if (!props.monospaceFirst) return hits
        const mono = /mono|code|consol|courier|menlo|hack|fira|iosevka|sarasa|maple|nerd/i
        return [...hits.filter((f) => mono.test(f)), ...hits.filter((f) => !mono.test(f))]
    }, [all, query, props.monospaceFirst])

    return (
        <div className="nv-fontpick">
            <input
                className="nv-mono-input"
                value={props.value}
                onChange={(e) => props.onChange(e.target.value)}
                spellCheck={false}
            />
            <input
                className="nv-fontpick-search"
                placeholder="搜索"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
            />
            <AsyncContent {...resource} ready={!!resource.data} label="正在读取字体…" className="nv-fontpick-results">
                <div className="nv-fontpick-list">
                    {list.map((f) => (
                        <FontRow
                            key={f}
                            family={f}
                            on={f === current}
                            onPick={() => props.onChange(withPrimary(props.value, f))}
                        />
                    ))}
                    {!list.length && <span className="nv-faint">{query ? '没有匹配的字体' : '暂无可选字体'}</span>}
                </div>
            </AsyncContent>
        </div>
    )
}

/**
 * One list row. The sample switches to its own face only once the row is scrolled into view,
 * so opening the page doesn't load every installed face at once.
 */
function FontRow(props: { family: string; on: boolean; onPick: () => void }) {
    const ref = useRef<HTMLButtonElement>(null)
    const [seen, setSeen] = useState(false)
    useEffect(() => {
        const el = ref.current
        if (!el || seen) return
        const io = new IntersectionObserver((es) => {
            if (es.some((e) => e.isIntersecting)) setSeen(true)
        })
        io.observe(el)
        return () => io.disconnect()
    }, [seen])
    return (
        <button ref={ref} className={props.on ? 'is-on' : ''} onClick={props.onPick}>
            <span className="nv-fontpick-name">{props.family}</span>
            {/* the sample, not the name, uses the face: symbol fonts would turn the name into glyphs */}
            <span
                className="nv-fontpick-sample"
                style={seen ? { fontFamily: `"${props.family}", var(--ui-font)` } : undefined}
            >
                Aa 0O1lI 永
            </span>
        </button>
    )
}

/** Installed families (Local Font Access API) + fonts dropped into the user fonts dir. */
function useInstalledFonts() {
    return useAsyncResource('installed-fonts', async () => {
        const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
        const [local, user] = await Promise.all([
            q ? q().catch(() => []) : Promise.resolve([]),
            window.iter.settings.listUserFonts()
        ])
        return [...new Set([...user.map((u) => u.family), ...local.map((f) => f.family)])].sort((a, b) =>
            a.localeCompare(b)
        )
    })
}
