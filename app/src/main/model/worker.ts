import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parentPort, workerData } from 'node:worker_threads'
import { validModelRequest, type ModelRequest } from '../../shared/model'
import { featureArrays, probabilities } from './features'
import { ClangTokenizer } from './tokenizer'

interface Tensor {
    data: ArrayLike<number>
}
interface Ort {
    env: { wasm: { numThreads: number; proxy: boolean; wasmPaths: string; wasmBinary: Uint8Array } }
    Tensor: new (type: string, data: BigInt64Array | Float32Array | Uint8Array, dims: number[]) => Tensor
    InferenceSession: {
        create: (
            model: Uint8Array,
            options: unknown
        ) => Promise<{
            inputNames: readonly string[]
            run: (feeds: Record<string, Tensor>) => Promise<{ logits: Tensor }>
            release: () => Promise<void>
        }>
    }
}
const port = parentPort!
const options = workerData as { assets: string; library: string; scratch: string }
const tokenizer = new ClangTokenizer(
    path.join(options.assets, 'tokenizer.exe'),
    options.library,
    options.scratch,
    (pid) => port.postMessage({ type: 'helper', pid })
)

async function initialize(): Promise<void> {
    const manifest = JSON.parse(await readFile(path.join(options.assets, 'manifest.json'), 'utf8'))
    if (manifest.schema !== 1 || manifest.tokenizerVersion !== '19.1.7') throw Error('Unsupported Model manifest')
    for (const [name, digest] of Object.entries(manifest.assets as Record<string, string>)) {
        if (!/^[a-zA-Z0-9_.\-/]+$/.test(name) || name.split('/').includes('..'))
            throw Error('Unsafe Model resource path')
        if (
            createHash('sha256')
                .update(await readFile(path.join(options.assets, name)))
                .digest('hex') !== digest
        )
            throw Error('Model resource hash mismatch')
    }
    const runtime = path.join(options.assets, 'runtime')
    const require = createRequire(pathToFileURL(path.join(runtime, 'ort.wasm.min.js')))
    const ort = require(path.join(runtime, 'ort.wasm.min.js')) as Ort
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false
    ort.env.wasm.wasmPaths = pathToFileURL(runtime + path.sep).href
    ort.env.wasm.wasmBinary = await readFile(path.join(runtime, 'ort-wasm-simd-threaded.wasm'))
    const [session] = await Promise.all([
        ort.InferenceSession.create(await readFile(path.join(options.assets, 'ranker.onnx')), {
            executionProviders: ['wasm']
        }),
        tokenizer.start()
    ])
    let pending = Promise.resolve()
    const handle = async (message: { type: string; request: ModelRequest }): Promise<void> => {
        if (message.type === 'dispose') {
            tokenizer.dispose()
            await session.release()
            port.close()
            return
        }
        if (message.type !== 'rank' || !validModelRequest(message.request)) return
        const request = message.request
        try {
            const arrays = featureArrays(request, await tokenizer.tokenize(request.source, request.standard))
            const count = request.candidates.length
            const feeds: Record<string, Tensor> = {
                context_bytes: new ort.Tensor('int64', arrays.context_bytes, [1, 192, 48]),
                context_kinds: new ort.Tensor('int64', arrays.context_kinds, [1, 192]),
                candidate_bytes: new ort.Tensor('int64', arrays.candidate_bytes, [1, count, 256]),
                candidate_kinds: new ort.Tensor('int64', arrays.candidate_kinds, [1, count]),
                features: new ort.Tensor('float32', arrays.features, [1, count, 8]),
                candidate_mask: new ort.Tensor('bool', arrays.candidate_mask, [1, count])
            }
            // Models trained with file-wide statistics declare this input; older ones simply do not get it.
            if (session.inputNames.includes('file_stats'))
                feeds.file_stats = new ort.Tensor('float32', arrays.file_stats, [1, count, 8])
            const result = await session.run(feeds)
            port.postMessage({ type: 'result', id: request.id, result: probabilities(result.logits.data) })
        } catch {
            port.postMessage({ type: 'result', id: request.id, result: null })
            port.postMessage({ type: 'unavailable' })
        }
    }
    port.on('message', (message) => {
        pending = pending
            .then(() => handle(message))
            .catch(() => {
                tokenizer.dispose()
                port.postMessage({ type: 'unavailable' })
                port.close()
            })
    })
    port.postMessage({ type: 'ready' })
}

process.once('exit', () => tokenizer.dispose())
void initialize().catch(() => {
    tokenizer.dispose()
    port.postMessage({ type: 'unavailable' })
    port.close()
})
