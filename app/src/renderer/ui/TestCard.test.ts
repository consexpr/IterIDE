import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { TestCaseData } from '../../shared/problem'
import type { FileState } from '../state/app'
import { TestCard } from './TestCard'

vi.mock('../actions/debug', () => ({ startDebug: vi.fn() }))
vi.mock('../actions/judge', () => ({ runTests: vi.fn() }))
vi.mock('../actions/tests', () => ({
    acceptOutput: vi.fn(),
    deleteTests: vi.fn(),
    editTest: vi.fn(),
    loadIntoTest: vi.fn(),
    toggleTest: vi.fn(),
    setCompareOutput: vi.fn()
}))
vi.mock('./shell/drop', () => ({ droppedPaths: vi.fn(), endDrag: vi.fn(), hasFiles: vi.fn() }))
vi.mock('../state/app', () => ({
    store: {},
    toast: vi.fn(),
    isDebugging: () => false,
    useApp: (select: (state: unknown) => unknown) => select({ expanded: { '/sample.cpp#sample': true } })
}))

const cases = [
    { name: 'LF mismatch', output: '1\n2', expected: '2\n2', verdict: 'WA' },
    { name: 'CRLF mismatch', output: '1\r\n2\r\n', expected: '2\r\n2\r\n', verdict: 'WA' },
    { name: 'matching then mismatching', output: '1\n2', expected: '1\n3', verdict: 'WA' },
    { name: 'two mismatching lines', output: '1\n2', expected: '3\n4', verdict: 'WA' },
    { name: 'blank line', output: '1\n\n2\n', expected: '3\n\n2\n', verdict: 'WA' },
    { name: 'accepted output', output: '1\n2\n', expected: '1\n2\n', verdict: 'AC' }
]

function card(output: string, expected: string, verdict: string, compareOutput?: boolean, runId?: string): string {
    const test = { id: 'sample', name: '1', input: '', answer: expected, enabled: true, compareOutput } as TestCaseData
    const file = {
        path: '/sample.cpp',
        runId,
        results: { sample: { output, verdict, timeMs: 0, exitCode: 0 } }
    } as unknown as FileState
    return renderToStaticMarkup(createElement(TestCard, { file, test, index: 0 }))
}

function outputMarkup(output: string, expected: string): string {
    return card(output, expected, 'WA').match(/<pre class="nv-io-text">([\s\S]*?)<\/pre>/)![1]
}

describe('test output line rendering', () => {
    it('defaults comparison on and keeps the per-case toggle beside the saved answer', () => {
        const markup = card('actual', 'saved answer', 'WA')
        expect(markup).toMatch(/期望输出[\s\S]*aria-label="测试点 1 比较输出"[^>]*checked=""/)
        expect(markup).toContain('saved answer')
    })

    it('shows an unchecked comparison switch without discarding the answer or highlighting differences', () => {
        const markup = card('actual', 'saved answer', 'NA', false)
        expect(markup).toContain('aria-label="测试点 1 比较输出"')
        expect(markup.match(/<input[^>]*aria-label="测试点 1 比较输出"[^>]*>/)?.[0]).not.toContain('checked=')
        expect(markup).toContain('saved answer')
        expect(markup).not.toContain('class="nv-diff"')
    })

    it('disables metadata changes while the problem is running', () => {
        expect(card('', 'answer', 'RUNNING', true, 'active-run')).toMatch(
            /<input[^>]*disabled=""[^>]*aria-label="测试点 1 比较输出"/
        )
    })
    it('does not append a newline absent from the program output', () => {
        expect(outputMarkup('1\n2', '2\n2').replace(/<\/?span\b[^>]*>/g, '')).toBe('1\n2')
    })

    it('keeps blank and trailing lines while normalizing CRLF for display only', () => {
        expect(outputMarkup('1\r\n\r\n2\r\n', '3\n\n2\n').replace(/<\/?span\b[^>]*>/g, '')).toBe('1\n\n2\n')
    })

    it('escapes output markup and preserves tabs and trailing spaces', () => {
        expect(outputMarkup('<1>\t  \n2', '').replace(/<\/?span\b[^>]*>/g, '')).toBe('&lt;1&gt;\t  \n2')
    })

    it('bounds long text and many lines before rendering and makes clipped text read-only', () => {
        const text = 'x'.repeat(100_001) + 'end-of-sample'
        const markup = card(text, text, 'AC')
        const answer = markup.match(/<textarea[^>]*readonly=""[^>]*>([\s\S]*?)<\/textarea>/i)![1]
        const output = markup.match(/<pre class="nv-io-text">([\s\S]*?)<\/pre>/)![1]
        expect(answer.length).toBe(100_000)
        expect(output).toBe(answer)
        expect(markup).not.toContain('end-of-sample')
        expect(outputMarkup('line\n'.repeat(10_000), '').split('\n')).toHaveLength(2000)
    })
})

// Opt in when an Electron runtime is available; it checks the real CSS layout,
// which a DOM-only test cannot measure. All browser data lives in this temp root.
describe.skipIf(process.env.ITER_TEST_RENDERER_LAYOUT !== '1')('test output Chromium layout', () => {
    it('places every physical line below the previous one for LF, CRLF and mixed diff rows', async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'iter-output-layout-'))
        try {
            const css = (
                await Promise.all(
                    ['base', 'panels'].map((name) =>
                        readFile(new URL(`../styles/${name}.css`, import.meta.url), 'utf8')
                    )
                )
            ).join('\n')
            const html = `<!doctype html><meta charset="utf-8"><style>${css}\nbody{overflow:auto} .fixture{width:540px}</style>${cases.map((test, i) => `<section class="fixture" data-case="${i}">${card(test.output, test.expected, test.verdict)}</section>`).join('')}`
            await writeFile(path.join(temp, 'index.html'), html)
            await writeFile(
                path.join(temp, 'main.cjs'),
                `
        const { app, BrowserWindow } = require('electron');
        const fs = require('node:fs');
        const path = require('node:path');
        for (const name of ['appData', 'userData', 'sessionData', 'logs', 'crashDumps']) {
          const dir = path.join(__dirname, name); fs.mkdirSync(dir, { recursive: true }); app.setPath(name, dir);
        }
        app.disableHardwareAcceleration();
        app.whenReady().then(async () => {
          const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
          await window.loadFile(path.join(__dirname, 'index.html'));
          const result = await window.webContents.executeJavaScript(
            '(' + (() => Array.from(document.querySelectorAll('.fixture')).map(fixture => {
              const pre = fixture.querySelector('.is-output pre');
              const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
              const points = [];
              while (walker.nextNode()) {
                const node = walker.currentNode;
                for (let i = 0; i < node.textContent.length; i++) {
                  if (!/[12]/.test(node.textContent[i])) continue;
                  const range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1);
                  const rect = range.getBoundingClientRect(); points.push({ text: node.textContent[i], x: rect.x, y: rect.y });
                }
              }
              return { text: pre.textContent, width: pre.clientWidth, scrollWidth: pre.scrollWidth, lineHeight: parseFloat(getComputedStyle(pre).lineHeight), points };
            })).toString() + ')()'
          );
          fs.writeFileSync(path.join(__dirname, 'result.json'), JSON.stringify(result));
          window.destroy(); app.quit();
        }).catch(error => { console.error(error); app.exit(1); });
      `
            )
            const env = { ...process.env }
            delete env.ELECTRON_RUN_AS_NODE
            const electron = createRequire(import.meta.url)('electron') as string
            await promisify(execFile)(electron, ['--no-sandbox', path.join(temp, 'main.cjs')], {
                env,
                timeout: 30_000,
                windowsHide: true
            })
            const result = JSON.parse(await readFile(path.join(temp, 'result.json'), 'utf8')) as {
                text: string
                width: number
                scrollWidth: number
                lineHeight: number
                points: { text: string; x: number; y: number }[]
            }[]
            for (const [i, test] of cases.entries()) {
                const row = result[i]
                expect(
                    row.points.map((point) => point.text),
                    test.name
                ).toEqual(['1', '2'])
                expect(row.points[1].y - row.points[0].y, test.name).toBeCloseTo(
                    row.lineHeight * (test.name === 'blank line' ? 2 : 1),
                    1
                )
                expect(row.points[1].x, test.name).toBeCloseTo(row.points[0].x, 1)
                expect(row.scrollWidth, test.name).toBeLessThanOrEqual(row.width)
                expect(row.text, test.name).toBe(test.output.replace(/\r\n/g, '\n'))
            }
        } finally {
            const target = path.resolve(temp)
            if (
                path.dirname(target) !== path.resolve(os.tmpdir()) ||
                !path.basename(target).startsWith('iter-output-layout-')
            ) {
                throw new Error(`Refusing to remove an unexpected output layout test directory: ${target}`)
            }
            await rm(target, { recursive: true, force: true })
        }
    }, 40_000)
})
