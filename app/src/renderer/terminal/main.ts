import { APP_NAME } from '../../shared/brand'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'
import { terminalColors } from '../../shared/settings'
import { SPINNER_VERBS } from '../../shared/terminalVerbs'
import type { TerminalBridge } from '../../preload/terminal'
import { bandCenter, charColor, css, hexToRgb } from './shimmer'
import { storedValue } from '../util/storage'

declare global {
    interface Window {
        terminalHost: TerminalBridge
    }
}

const host = window.terminalHost
const stops = terminalColors(
    (new URLSearchParams(location.search).get('colors') ?? '').split(',').map((c) => `#${c}`)
).map(hexToRgb)

/** Text as one span per character, so a travelling band can colour neighbours independently. */
class Shimmer {
    private spans: HTMLSpanElement[] = []
    private applied: string[] = []
    private text = ''
    private frozen = false
    constructor(
        private readonly element: HTMLElement,
        private readonly offsetMs = 0
    ) {}

    set(text: string): void {
        if (text === this.text && this.spans.length) return
        this.text = text
        this.element.replaceChildren(
            ...(this.spans = [...text].map((char) =>
                Object.assign(document.createElement('span'), { textContent: char })
            ))
        )
        this.applied = []
        this.paint(performance.now())
    }

    /** Static text in the resting colour, used once the program has finished. */
    freeze(text: string): void {
        this.set(text)
        this.frozen = true
        for (const span of this.spans) span.style.color = css(stops[0])
    }

    paint(now: number): void {
        if (this.frozen) return
        const center = bandCenter(now, this.spans.length, this.offsetMs)
        this.spans.forEach((span, i) => {
            const color = css(charColor(i, center, stops))
            if (this.applied[i] !== color) span.style.color = this.applied[i] = color
        })
    }
}

const title = document.getElementById('title')!
title.textContent = `${APP_NAME} - Terminal`
title.style.color = '#ffffff'
const spinner = new Shimmer(document.getElementById('spinner')!)

// One verb per terminal window; the next window picks a different one.
const pickVerb = (): (typeof SPINNER_VERBS)[number] => {
    let previous: string | null = null
    try {
        previous = storedValue('iter.terminal.verb')
    } catch {
        /* Storage can be unavailable; a repeat is harmless. */
    }
    let next = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]
    while (SPINNER_VERBS.length > 1 && next.present === previous)
        next = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]
    try {
        localStorage.setItem('iter.terminal.verb', next.present)
    } catch {
        /* Same as above. */
    }
    return next
}
const verb = pickVerb()
spinner.set(`✻ ${verb.present}...`)

let last = 0
function frame(now: number): void {
    if (now - last >= 33) {
        last = now
        spinner.paint(now)
    }
    requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

const term = new Terminal({
    fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace',
    fontSize: 15,
    scrollback: 100000,
    cursorBlink: true,
    windowsPty: { backend: 'conpty' },
    theme: { background: '#0c0c0c', foreground: '#cccccc', cursor: '#cccccc', selectionBackground: '#264f78' }
})
const fit = new FitAddon()
term.loadAddon(fit)
term.open(document.getElementById('screen')!)
fit.fit()

term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || event.altKey) return true
    const key = event.key.toLowerCase()
    if (key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
        return false
    }
    // The browser pastes through xterm's paste handler; Ctrl+V itself must not reach the program.
    return key !== 'v'
})

let exited = false
term.onData((data) => {
    if (!exited) host.input(data)
    else if (data.includes('\r')) host.close()
})
term.onResize(({ cols, rows }) => host.resize({ cols, rows }))
new ResizeObserver(() => fit.fit()).observe(document.getElementById('screen')!)

host.onData((data, sequence) => term.write(data, () => host.acknowledge(sequence)))
host.onExit((code) => {
    exited = true
    spinner.freeze(`✻ ${verb.past}`)
    const hex = code.toString(16).toUpperCase().padStart(8, '0')
    term.write(`\r\n\r\nExited with code ${code} (0x${hex}).\r\nPause...`)
})
host.ready({ cols: term.cols, rows: term.rows })
