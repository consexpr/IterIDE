import { monaco } from './monaco'
import { Store } from '../state/store'

const MATCH_LIMIT = 20_000
export const searchState = new Store({
    open: false,
    query: '',
    replacement: '',
    matchCase: false,
    wholeWord: false,
    regex: false,
    count: 0,
    index: -1,
    limited: false,
    error: '',
    pending: false,
    readOnly: false,
    focus: 'find' as 'find' | 'replace',
    focusRequest: 0
})

type SearchEditor = monaco.editor.IStandaloneCodeEditor
let current: SearchSession | undefined

/** Keep matching and editor edits separate from the find form's DOM and focus handling. */
export class SearchSession {
    private matches: monaco.editor.FindMatch[] = []
    private model: monaco.editor.ITextModel | null = null
    private version = 0
    private timer: ReturnType<typeof setTimeout> | undefined
    private selecting = false
    private highlights: monaco.editor.IEditorDecorationsCollection
    private subscriptions: monaco.IDisposable[]

    constructor(private editor: SearchEditor) {
        this.highlights = editor.createDecorationsCollection()
        this.subscriptions = [
            editor.onDidChangeModel(() => {
                this.matches = []
                this.highlights.clear()
                if (!editor.getModel()) this.close(false)
                else this.refresh(false)
            }),
            editor.onDidChangeModelContent(() => this.refresh(false)),
            editor.onDidChangeCursorSelection(() => {
                if (!this.selecting && searchState.get().open) this.syncSelection()
            }),
            editor.onDidChangeConfiguration(() => this.refresh(false))
        ]
    }

    open(focus: 'find' | 'replace'): void {
        const model = this.editor.getModel()
        if (!model) return
        const state = searchState.get()
        const selection = this.editor.getSelection()
        const selected =
            !state.open &&
            selection &&
            !selection.isEmpty() &&
            selection.startLineNumber === selection.endLineNumber &&
            model.getValueLengthInRange(selection) <= 1000
                ? model.getValueInRange(selection)
                : ''
        searchState.set({ open: true, query: selected || state.query, focus, focusRequest: state.focusRequest + 1 })
        this.refresh(false)
    }

    close(focusEditor = true): void {
        clearTimeout(this.timer)
        this.matches = []
        this.highlights.clear()
        searchState.set({ open: false, pending: false, count: 0, index: -1, error: '' })
        if (focusEditor && this.editor.getModel()) this.editor.focus()
    }

    update(
        patch: Partial<
            Pick<ReturnType<typeof searchState.get>, 'query' | 'replacement' | 'matchCase' | 'wholeWord' | 'regex'>
        >,
        composing = false
    ): void {
        searchState.set(patch)
        if (Object.keys(patch).every((key) => key === 'replacement')) return
        clearTimeout(this.timer)
        this.matches = []
        this.highlights.clear()
        searchState.set({ pending: true, count: 0, index: -1, error: '' })
        if (!composing) this.timer = setTimeout(() => this.refresh(true), 100)
    }

    refresh(reveal: boolean): void {
        clearTimeout(this.timer)
        const state = searchState.get(),
            model = this.editor.getModel()
        if (!state.open || !model) return
        this.model = model
        this.version = model.getVersionId()
        let error = ''
        try {
            if (state.regex && state.query) new RegExp(state.query, 'u')
            this.matches = state.query
                ? model.findMatches(
                      state.query,
                      false,
                      state.regex,
                      state.matchCase,
                      state.wholeWord
                          ? (this.editor.getRawOptions().wordSeparators ?? '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?')
                          : null,
                      true,
                      MATCH_LIMIT + 1
                  )
                : []
        } catch {
            error = '正则表达式无效'
            this.matches = []
        }
        const limited = this.matches.length > MATCH_LIMIT
        if (limited) this.matches.length = MATCH_LIMIT
        searchState.set({
            error,
            pending: false,
            limited,
            count: this.matches.length,
            readOnly: !!this.editor.getRawOptions().readOnly,
            index: -1
        })
        this.syncSelection()
        if (reveal && this.matches.length) this.navigate(1, true)
    }

    private syncSelection(): void {
        const selection = this.editor.getSelection()
        const index = selection ? this.matches.findIndex((match) => match.range.equalsRange(selection)) : -1
        if (index !== searchState.get().index) searchState.set({ index })
        this.highlights.set(
            this.matches.map((match, at) => ({
                range: match.range,
                options: {
                    className: at === index ? 'nv-search-match is-current' : 'nv-search-match',
                    stickiness: 1 // NeverGrowsWhenTypingAtEdges
                }
            }))
        )
    }

    navigate(direction: 1 | -1, inclusive = false): void {
        if (!searchState.get().open) return
        if (
            searchState.get().pending ||
            this.model !== this.editor.getModel() ||
            this.version !== this.model?.getVersionId()
        )
            this.refresh(false)
        if (!this.matches.length) return
        const selection = this.editor.getSelection()
        const selected = selection ? this.matches.findIndex((match) => match.range.equalsRange(selection)) : -1
        let index: number
        if (selected >= 0)
            index = inclusive ? selected : (selected + direction + this.matches.length) % this.matches.length
        else {
            const position = this.editor.getPosition()!
            const after = (match: monaco.editor.FindMatch): boolean =>
                match.range.getStartPosition().isBefore(position) === false
            index = this.matches.findIndex(after)
            if (direction === -1) index = (index < 0 ? this.matches.length : index) - 1
            if (index < 0) index = direction === 1 ? 0 : this.matches.length - 1
        }
        const range = this.matches[index].range
        this.selecting = true
        this.editor.setSelection(range)
        this.editor.revealRangeInCenterIfOutsideViewport(range)
        this.selecting = false
        this.syncSelection()
    }

    replace(all: boolean): void {
        if (!searchState.get().open || this.editor.getRawOptions().readOnly) return
        this.refresh(false)
        const state = searchState.get(),
            model = this.editor.getModel()
        if (!model || !this.matches.length || state.error || (all && state.limited)) return
        // Never replace an arbitrary editor selection: only a verified match in this exact revision.
        if (!all && state.index < 0) this.navigate(1, true)
        const targets = all ? this.matches : [this.matches[searchState.get().index]]
        const edits = targets.map((match) => ({
            range: match.range,
            text: replacementText(state.replacement, match.matches ?? [model.getValueInRange(match.range)], state.regex)
        }))
        this.editor.pushUndoStop()
        this.editor.executeEdits('iter.search', edits)
        this.editor.pushUndoStop()
        this.refresh(false)
        if (!all) this.navigate(1, true)
    }

    dispose(): void {
        clearTimeout(this.timer)
        this.highlights.clear()
        this.subscriptions.forEach((subscription) => subscription.dispose())
    }
}

/** Regex replacement tokens; ordinary text is inserted literally. */
export function replacementText(value: string, matches: string[], regex: boolean): string {
    if (!regex) return value
    return value.replace(/\\([\\nrt])|\$(\$|&|0|[1-9]\d?)/g, (token, escaped: string, group: string) => {
        if (escaped) return ({ n: '\n', r: '\r', t: '\t', '\\': '\\' } as Record<string, string>)[escaped]
        if (group === '$') return '$'
        if (group === '&' || group === '0') return matches[0] ?? ''
        const index = Number(group)
        if (index < matches.length) return matches[index] ?? ''
        if (group.length === 2 && Number(group[0]) < matches.length) return (matches[Number(group[0])] ?? '') + group[1]
        return token
    })
}

export function installSearch(editor: SearchEditor): () => void {
    const session = new SearchSession(editor)
    current = session
    const commands = [
        monaco.editor.registerCommand('actions.find', () => session.open('find')),
        monaco.editor.registerCommand('editor.action.startFindReplaceAction', () => session.open('replace')),
        monaco.editor.registerCommand('editor.action.nextMatchFindAction', () => session.navigate(1)),
        monaco.editor.registerCommand('editor.action.previousMatchFindAction', () => session.navigate(-1))
    ]
    return () => {
        commands.forEach((command) => command.dispose())
        session.close(false)
        session.dispose()
        if (current === session) current = undefined
    }
}
export const openSearch = (focus: 'find' | 'replace' = 'find'): void => current?.open(focus)
export const closeSearch = (): void => current?.close()
export const updateSearch = (patch: Parameters<SearchSession['update']>[0], composing = false): void =>
    current?.update(patch, composing)
export const nextSearchMatch = (direction: 1 | -1): void => current?.navigate(direction)
export const replaceSearchMatch = (all = false): void => current?.replace(all)
