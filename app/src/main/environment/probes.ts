import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolchainSettings } from '../../shared/judge'
import { resolveCompiler, resolveTool } from '../toolchain'
import { splitArgs } from '../toolchain/args'
import { execute, type ProcessResult } from '../judge/process'
import { MIClient, MICommandError } from '../debug/mi-client'
import { miQuote, miString, type MIRecord } from '../debug/mi'
import { checkCompletion } from './completion'

export interface ProbeContext {
    directory: string
    tools: ToolchainSettings
    signal: AbortSignal
    compiled: boolean
}
export interface ProbeResult {
    summary: string
    detail?: string
    warning?: boolean
}
const SOURCE =
    '#include <iostream>\n#include <vector>\nint main() {\n int health_value = 7;\n std::vector<int> values{1, 1};\n int input = 0;\n std::cin >> input;\n std::cout << input + values[0] + values[1] << "\\n";\n return health_value == 7 ? 0 : 1;\n}\n'
const executable = (directory: string, name: string): string =>
    path.join(directory, name + (process.platform === 'win32' ? '.exe' : ''))
function successful(result: ProcessResult): void {
    if (result.error || result.timedOut || result.outputExceeded || result.code !== 0) {
        throw new Error(
            [
                result.timedOut
                    ? '检查超时'
                    : result.outputExceeded
                      ? '检查输出超过上限'
                      : (result.error ?? `退出码 ${result.code}`),
                result.stdout,
                result.stderr
            ]
                .filter(Boolean)
                .join('\n')
                .slice(0, 8192)
        )
    }
}
async function compile(context: ProbeContext, debug = false): Promise<string> {
    const { directory, tools, signal } = context
    const source = path.join(directory, 'health.cpp'),
        target = executable(directory, debug ? 'debug' : 'run')
    await fs.writeFile(source, SOURCE)
    const compiler = resolveCompiler(tools, [
        ...splitArgs(debug ? tools.debugFlags : tools.flags),
        ...(debug ? ['-g', '-O0'] : [])
    ])
    const result = await execute(compiler.command, [...compiler.flags, source, '-o', target], {
        cwd: directory,
        signal,
        timeout: 15_000,
        outputLimit: 128 * 1024,
        displayLimit: 8192
    })
    successful(result)
    if (!(await fs.stat(target)).isFile()) throw new Error('编译器没有生成可运行程序，请检查编译选项。')
    return compiler.command
}

export const environmentProbes = {
    async compile(context: ProbeContext): Promise<ProbeResult> {
        const compiler = await compile(context)
        context.compiled = true
        return { summary: '已按当前评测编译选项编译含标准库的 C++ 样例。', detail: compiler }
    },
    async run(context: ProbeContext): Promise<ProbeResult> {
        const input = path.join(context.directory, 'input.txt')
        await fs.writeFile(input, '40\n')
        const result = await execute(executable(context.directory, 'run'), [], {
            cwd: context.directory,
            input,
            signal: context.signal,
            timeout: 5000,
            outputLimit: 64 * 1024,
            displayLimit: 8192
        })
        successful(result)
        if (result.stdout.trim() !== '42') throw new Error(`样例期望输出 42，实际为 ${JSON.stringify(result.stdout)}`)
        return { summary: '程序正常退出，输入 40 得到预期输出 42。' }
    },
    async debug(context: ProbeContext): Promise<ProbeResult> {
        await compile(context, true)
        context.signal.throwIfAborted()
        const tool = resolveTool('gdb', context.tools),
            client = new MIClient(tool.command, context.directory)
        const abort = (): void => {
            void client.dispose()
        }
        context.signal.addEventListener('abort', abort, { once: true })
        let timer: NodeJS.Timeout | undefined
        let stoppedListener: ((record: MIRecord) => void) | undefined
        let closedListener: ((error: Error) => void) | undefined
        try {
            await client.batch(['-gdb-set pagination off', '-gdb-set confirm off'])
            if (process.platform === 'win32') await client.command('-gdb-set new-console off', 5000)
            await client.command(`-file-exec-and-symbols ${miQuote(executable(context.directory, 'debug'))}`, 5000)
            await client.command(
                `-break-insert ${miQuote(path.join(context.directory, 'health.cpp').replaceAll('\\', '/') + ':6')}`,
                5000
            )
            const stopped = new Promise<void>((resolve, reject) => {
                stoppedListener = (record) => {
                    if (record.kind === 'exec' && record.cls === 'stopped') {
                        miString(record.results.reason) === 'breakpoint-hit'
                            ? resolve()
                            : reject(new Error('样例未停在预设断点'))
                    }
                }
                closedListener = reject
                client.on('record', stoppedListener)
                client.on('closed', closedListener)
                timer = setTimeout(() => reject(new Error('等待调试断点超时')), 8000)
            })
            await Promise.all([client.command('-exec-run', 8000), stopped])
            const value = await client.command('-data-evaluate-expression health_value', 5000)
            if (miString(value.value) !== '7') throw new Error('断点变量读取结果不符合预期')
            let python = ''
            const consoleListener = (record: MIRecord): void => {
                if (record.kind === 'console') python = (python + record.text).slice(-8192)
            }
            client.on('record', consoleListener)
            try {
                await client.command(
                    `-interpreter-exec console ${miQuote('python import gdb, json; print("ITER_HEALTH_PYTHON_OK" if json.loads(json.dumps(int(gdb.parse_and_eval("health_value")))) == 7 else "PYTHON_VALUE_MISMATCH")')}`,
                    5000
                )
                if (!python.includes('ITER_HEALTH_PYTHON_OK')) throw new Error('GDB 未返回 Python 录制能力标记')
            } catch (error) {
                if (
                    error instanceof MICommandError &&
                    /(?:undefined command.*python|python.*(?:not supported|not compiled|unavailable))/i.test(
                        error.message
                    )
                ) {
                    return {
                        summary: '断点和变量读取正常；当前 GDB 不支持 Python，自动录制回放不可用。',
                        warning: true,
                        detail: tool.command
                    }
                }
                throw error
            } finally {
                client.off('record', consoleListener)
            }
            return { summary: '断点命中、变量读取和 Python 录制支持正常。', detail: tool.command }
        } finally {
            clearTimeout(timer)
            if (stoppedListener) client.off('record', stoppedListener)
            if (closedListener) client.off('closed', closedListener)
            context.signal.removeEventListener('abort', abort)
            await client.dispose()
        }
    },
    completion: checkCompletion
}
