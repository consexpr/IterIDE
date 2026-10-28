import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { frameMessage, LspMessageParser } from '../lsp/framing'
import { probeCompiler } from '../lsp/toolchain'
import { splitArgs } from '../toolchain/args'
import { resolveTool, toolchainEnv } from '../toolchain'
import { killTree } from '../debug/process'
import type { ProbeContext, ProbeResult } from './probes'

/** A private stdio client avoids restarting the editor's existing clangd session. */
export async function checkCompletion({ directory, tools, signal }: ProbeContext): Promise<ProbeResult> {
    const compiler = resolveTool('compiler', tools),
        clangd = resolveTool('clangd', tools)
    const driver = await probeCompiler(compiler.command, signal)
    signal.throwIfAborted()
    const source = path.join(directory, 'completion.cpp'),
        line = ' values.pu'
    const text = '#include <vector>\nint main(){\n std::vector<int> values;\n' + line + '\n}\n'
    await fs.writeFile(source, text)
    await fs.writeFile(
        path.join(directory, 'compile_commands.json'),
        JSON.stringify([
            {
                directory,
                file: source,
                arguments: [compiler.command, ...splitArgs(tools.flags), ...driver, '-c', source]
            }
        ])
    )
    const child = spawn(
        clangd.command,
        [
            '--background-index=false',
            '--pch-storage=memory',
            '-j=1',
            `--query-driver=${compiler.command.replaceAll('\\', '/')}`
        ],
        {
            cwd: directory,
            env: toolchainEnv(),
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: 'pipe'
        }
    )
    let id = 0,
        log = '',
        closed: Error | undefined
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
    const fail = (error: Error): void => {
        closed = error
        for (const item of pending.values()) {
            clearTimeout(item.timer)
            item.reject(error)
        }
        pending.clear()
    }
    const send = (message: unknown): void => {
        if (!closed) child.stdin.write(frameMessage(message))
    }
    const request = (method: string, params: unknown): Promise<any> => {
        if (closed) return Promise.reject(closed)
        const key = ++id
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(key)
                reject(new Error(`clangd ${method} 超时\n${log}`))
            }, 10_000)
            pending.set(key, { resolve, reject, timer })
            send({ jsonrpc: '2.0', id: key, method, params })
        })
    }
    const parser = new LspMessageParser((value) => {
        if (!value || typeof value !== 'object') return
        const message = value as { id?: number; method?: string; result?: unknown; error?: { message?: string } }
        if (message.method && message.id !== undefined) {
            send({ jsonrpc: '2.0', id: message.id, result: null })
            return
        }
        if (message.id === undefined) return
        const item = pending.get(message.id)
        if (!item) return
        pending.delete(message.id)
        clearTimeout(item.timer)
        if (message.error) item.reject(new Error(message.error.message ?? 'clangd 请求失败'))
        else item.resolve(message.result)
    })
    child.stdout.on('data', (data) => parser.push(data))
    child.stderr.on('data', (data) => {
        log = (log + data.toString()).slice(-8192)
    })
    child.once('error', fail)
    child.once('close', () => fail(new Error(`clangd 提前退出\n${log}`)))
    child.stdin.on('error', fail)
    const abort = (): void => {
        fail(new Error('补全检查已停止'))
        void killTree(child)
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
        if (signal.aborted) {
            abort()
            signal.throwIfAborted()
        }
        const initialized = await request('initialize', {
            processId: process.pid,
            rootUri: pathToFileURL(directory).href,
            capabilities: {
                textDocument: { completion: { completionItem: { snippetSupport: false, labelDetailsSupport: true } } }
            }
        })
        send({ jsonrpc: '2.0', method: 'initialized', params: {} })
        const uri = pathToFileURL(source).href
        send({
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: { textDocument: { uri, languageId: 'cpp', version: 1, text } }
        })
        await request('textDocument/documentSymbol', { textDocument: { uri } })
        const result = await request('textDocument/completion', {
            textDocument: { uri },
            position: { line: 3, character: line.length }
        })
        const items: unknown = Array.isArray(result) ? result : result?.items
        if (
            !Array.isArray(items) ||
            !items.some(
                (item) =>
                    typeof (item?.filterText ?? item?.label) === 'string' &&
                    (item.filterText ?? item.label).trim().startsWith('push_back')
            )
        )
            throw new Error('clangd 已启动，但未返回 std::vector 的预期补全')
        return {
            summary: '标准库解析正常，已取得 std::vector::push_back 补全。',
            detail: [clangd.command, initialized?.serverInfo?.version]
                .filter((value) => typeof value === 'string')
                .join('\n')
        }
    } finally {
        signal.removeEventListener('abort', abort)
        fail(new Error('补全体检已结束'))
        await killTree(child)
    }
}
