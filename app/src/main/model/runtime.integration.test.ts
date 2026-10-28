import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import fixtures from './golden-fixtures.json'
import { probabilities } from './features'
import { ClangTokenizer } from './tokenizer'
import type { ModelResult } from '../../shared/model'

describe.skipIf(process.env.ITER_TEST_MODEL_INTEGRATION !== '1')(
    'bundled CPU Model and native Clang integration',
    () => {
        it('matches native token ranges, Python feature hashes, probabilities and ranking', async () => {
            const scratch = await mkdtemp(path.join(os.tmpdir(), 'iter-model-中文 空格-'))
            const assets = path.resolve('resources/model'),
                library = path.resolve('resources/toolchain/bin/libclang.dll')
            const tokenizer = new ClangTokenizer(
                path.join(assets, 'tokenizer.exe'),
                library,
                path.join(scratch, 'direct'),
                () => {}
            )
            let worker: Worker | undefined
            const helpers = new Set<number>()
            try {
                await tokenizer.start()
                for (const fixture of fixtures)
                    expect(await tokenizer.tokenize(fixture.request.source, fixture.request.standard)).toEqual(
                        fixture.tokens
                    )
                worker = new Worker(path.resolve('out/main/model-worker.js'), {
                    workerData: { assets, library, scratch: path.join(scratch, 'worker') }
                })
                const responses = new Map<string, (value: ModelResult | null) => void>()
                const ready = new Promise<void>((resolve, reject) => {
                    worker!.on('error', reject)
                    worker!.on('message', (message) => {
                        if (message.type === 'helper') helpers.add(message.pid)
                        if (message.type === 'ready') resolve()
                        if (message.type === 'unavailable') reject(Error('Model worker initialization failed'))
                        if (message.type === 'result') responses.get(message.id)?.(message.result)
                    })
                })
                await ready
                for (const fixture of fixtures) {
                    const completed = new Promise<ModelResult | null>((resolve) =>
                        responses.set(fixture.request.id, resolve)
                    )
                    worker.postMessage({ type: 'rank', request: fixture.request })
                    const result = await completed
                    expect(result).not.toBeNull()
                    expect(result!.order).toEqual(fixture.order)
                    const expected = probabilities(fixture.scores).probabilities
                    expect(
                        Math.max(...expected.map((value, index) => Math.abs(value - result!.probabilities[index])))
                    ).toBeLessThan(0.0001)
                }
            } finally {
                tokenizer.dispose()
                for (const pid of helpers) {
                    try {
                        process.kill(pid)
                    } catch {}
                }
                if (worker) await worker.terminate()
                await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
            }
        }, 15000)
    }
)
