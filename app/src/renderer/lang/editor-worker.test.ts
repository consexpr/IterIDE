import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

/** Run the real Monaco worker entry with a browser-message adapter, without Electron/DOM. */
async function workerEntry(entry: string) {
    const worker = new Worker(
        `
    const { parentPort, workerData } = require('node:worker_threads');
    globalThis.self = globalThis;
    const listeners = new Set();
    globalThis.addEventListener = (name, listener) => { if (name === 'message') listeners.add(listener); };
    globalThis.removeEventListener = (name, listener) => { if (name === 'message') listeners.delete(listener); };
    globalThis.postMessage = message => parentPort.postMessage(message);
    parentPort.on('message', data => { const event = {data}; for (const listener of listeners) listener(event); globalThis.onmessage?.(event); });
    import(workerData).then(() => parentPort.postMessage({ready:true, handler:typeof globalThis.onmessage === 'function'}));
  `,
        { eval: true, workerData: pathToFileURL(require.resolve(entry)).href }
    )
    const pending = new Map<string, (value: any) => void>()
    const ready = new Promise<boolean>((resolve, reject) => {
        worker.on('error', reject)
        worker.on('message', (message) => {
            if (message.ready) resolve(message.handler)
            else pending.get(message.seq)?.(message)
        })
    })
    let id = 0
    return {
        worker,
        ready,
        async request(method: string, args: unknown[]) {
            const req = String(++id)
            const reply = new Promise<any>((resolve) => pending.set(req, resolve))
            worker.postMessage({ vsWorker: 1, req, channel: 'default', method, args, type: 0 })
            const message = await reply
            pending.delete(req)
            if (message.err) throw new Error(message.err.message)
            return message.res
        }
    }
}

it('worker.start is only a factory; the worker bootstrap answers locality RPC', async () => {
    const factory = await workerEntry('monaco-editor/editor/editor.worker.start')
    try {
        expect(await factory.ready).toBe(false)
    } finally {
        await factory.worker.terminate()
    }
    const bootstrap = await workerEntry('monaco-editor/editor/editor.worker')
    try {
        expect(await bootstrap.ready).toBe(true)
        bootstrap.worker.postMessage('bootstrap') // First message installs Monaco's RPC server.
        await bootstrap.request('$initialize', [1])
        const url = 'file:///completion.cpp'
        await bootstrap.request('$acceptNewModel', [
            { url, versionId: 1, EOL: '\n', lines: ['int main() {', '  int vec = 0;', '  int total = 0;', '  ve', '}'] }
        ])
        const ranges = await bootstrap.request('$computeWordRanges', [
            url,
            { startLineNumber: 1, startColumn: 13, endLineNumber: 5, endColumn: 1 },
            '[A-Za-z_][A-Za-z_0-9]*',
            'g'
        ])
        expect(ranges.vec[0]).toMatchObject({ startLineNumber: 2, startColumn: 7, endColumn: 10 })
        expect(ranges.total[0]).toMatchObject({ startLineNumber: 3 })
    } finally {
        await bootstrap.worker.terminate()
    }
}, 5000)
