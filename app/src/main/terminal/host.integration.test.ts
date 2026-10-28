import { afterEach, beforeEach, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ToolchainSettings } from '../../shared/judge'
import { compileSource } from '../judge/compile'
import { killTree } from '../judge/process'
import { configureToolchain, toolchainEnv } from '../toolchain'
import { buildTerminalHost, launchTerminalHost, type TerminalView } from './host'

const tools = { compiler: 'g++', flags: '-std=c++17 -O2', debugFlags: '-g' } as ToolchainSettings
let dir: string, child: ChildProcess | undefined
const releases: (() => void)[] = []
beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-terminal-native-'))
    configureToolchain(path.resolve('resources/toolchain'))
})
afterEach(async () => {
    if (child?.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child!.once('close', () => resolve()))
        killTree(child)
        await closed
    }
    child = undefined
    for (const release of releases.splice(0)) release()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

// A window stand-in: the real ConPTY helper feeds it, and the test types into it.
function fakeView(): TerminalView & { text(): string; code?: number; type(data: string): void } {
    let close!: () => void
    const closed = new Promise<void>((resolve) => (close = resolve))
    const chunks: Buffer[] = []
    let input: (data: string) => void = () => {}
    const view = {
        cols: 100,
        rows: 30,
        closed,
        code: undefined as number | undefined,
        write: async (data: Uint8Array) => {
            chunks.push(Buffer.from(data))
        },
        exited: (code: number) => void (view.code = code),
        onInput: (listener: (data: string) => void) => void (input = listener),
        onResize: () => {},
        close,
        text: () => Buffer.concat(chunks).toString('utf8'),
        type: (data: string) => input(data)
    }
    return view
}

it.skipIf(process.platform !== 'win32')(
    'runs the program in a pseudo console, relays typed input, output and the exit code, and preserves special paths',
    async () => {
        const special = path.join(dir, '终端 & %! ^ (path)')
        await fs.mkdir(special)
        const sourcePath = path.join(special, 'main.cpp')
        const source =
            '#include <iostream>\n#include <fstream>\n#include <string>\nint main(){std::string s; std::getline(std::cin,s); std::cout<<"echo<"<<s<<"> 中文"<<std::endl; std::ofstream("result.txt")<<s; return 7;}'
        const compile = await compileSource(sourcePath, source, tools, false)
        expect(compile.ok, compile.output).toBe(true)
        // Also run a binary whose actual executable path has shell metacharacters.
        const executable = path.join(special, 'user & %! ^.exe')
        await fs.copyFile(compile.exe!, executable)
        const host = await buildTerminalHost(path.join(dir, 'host'), tools, new AbortController().signal)
        releases.push(host.release)
        const cwd = path.join(special, 'work')
        await fs.mkdir(cwd)
        const view = fakeView()
        const terminal = await launchTerminalHost(
            host.exe,
            executable,
            cwd,
            path.join(special, 'status'),
            new AbortController().signal,
            view
        )
        expect(await fs.readdir(cwd)).toEqual([])
        view.type('41\r')
        await expect.poll(() => view.code, { timeout: 10_000 }).toBe(7)
        expect(view.text()).toContain('echo<41> 中文')
        expect(await fs.readFile(path.join(cwd, 'result.txt'), 'utf8')).toBe('41')
        view.close()
        await terminal.closed
    },
    45_000
)

it.skipIf(process.platform !== 'win32')(
    'cancels the window and terminates a running program through its job',
    async () => {
        const compiled = await compileSource(
            path.join(dir, 'loop.cpp'),
            '#include <windows.h>\n#include <fstream>\nint main(){std::ofstream("pid")<<GetCurrentProcessId(); for(;;) Sleep(50);}',
            tools,
            false
        )
        expect(compiled.ok, compiled.output).toBe(true)
        const host = await buildTerminalHost(path.join(dir, 'host'), tools, new AbortController().signal)
        releases.push(host.release)
        const cwd = path.join(dir, 'work')
        await fs.mkdir(cwd)
        const controller = new AbortController()
        const view = fakeView()
        const terminal = await launchTerminalHost(
            host.exe,
            compiled.exe!,
            cwd,
            path.join(dir, 'status'),
            controller.signal,
            view
        )
        await expect
            .poll(() => fs.readFile(path.join(cwd, 'pid'), 'utf8').catch(() => ''), { timeout: 5000 })
            .toMatch(/^\d+$/)
        const pid = Number(await fs.readFile(path.join(cwd, 'pid'), 'utf8'))
        controller.abort()
        await terminal.closed
        await expect
            .poll(
                () => {
                    try {
                        process.kill(pid, 0)
                        return true
                    } catch {
                        return false
                    }
                },
                { timeout: 5000 }
            )
            .toBe(false)
    },
    40_000
)

it.skipIf(process.platform !== 'win32')(
    'cancels a flooding native console while its renderer has stopped acknowledging output',
    async () => {
        const compiled = await compileSource(
            path.join(dir, 'flood.cpp'),
            '#include <windows.h>\n#include <cstdio>\n#include <fstream>\nint main(){std::ofstream("pid")<<GetCurrentProcessId();for(;;)puts("0123456789012345678901234567890123456789");}',
            tools,
            false
        )
        expect(compiled.ok, compiled.output).toBe(true)
        const host = await buildTerminalHost(path.join(dir, 'host'), tools, new AbortController().signal)
        releases.push(host.release)
        const cwd = path.join(dir, 'work')
        await fs.mkdir(cwd)
        const controller = new AbortController(),
            view = fakeView()
        let received!: () => void
        const firstOutput = new Promise<void>((resolve) => {
            received = resolve
        })
        view.write = () => {
            received()
            return new Promise<void>(() => {})
        }
        const terminal = await launchTerminalHost(
            host.exe,
            compiled.exe!,
            cwd,
            path.join(dir, 'status'),
            controller.signal,
            view
        )
        await firstOutput
        const pid = Number(await fs.readFile(path.join(cwd, 'pid'), 'utf8'))
        controller.abort()
        await terminal.closed
        await expect
            .poll(
                () => {
                    try {
                        process.kill(pid, 0)
                        return true
                    } catch {
                        return false
                    }
                },
                { timeout: 5000 }
            )
            .toBe(false)
    },
    40_000
)

it.skipIf(process.platform !== 'win32')(
    'kills the solution and its descendants when the window goes away',
    async () => {
        const source = String.raw`#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <fstream>
#include <string>
#include <vector>
int main(int argc, char**) {
  std::ofstream(argc == 1 ? "parent-pid" : "child-pid") << GetCurrentProcessId();
  if (argc == 1) {
    wchar_t executable[32768];
    GetModuleFileNameW(NULL, executable, 32768);
    std::wstring command = L"\"" + std::wstring(executable) + L"\" child";
    std::vector<wchar_t> mutableCommand(command.begin(), command.end());
    mutableCommand.push_back(0);
    STARTUPINFOW startup = {}; startup.cb = sizeof(startup);
    PROCESS_INFORMATION process = {};
    if (!CreateProcessW(executable, mutableCommand.data(), NULL, NULL, FALSE, 0, NULL, NULL, &startup, &process)) return 10;
    CloseHandle(process.hThread); CloseHandle(process.hProcess);
  }
  for (;;) Sleep(50);
}`
        const compiled = await compileSource(path.join(dir, 'tree.cpp'), source, tools, false)
        expect(compiled.ok, compiled.output).toBe(true)
        const host = await buildTerminalHost(path.join(dir, 'host'), tools, new AbortController().signal)
        releases.push(host.release)
        const cwd = path.join(dir, 'work')
        await fs.mkdir(cwd)
        const statusFile = path.join(dir, 'status')
        child = spawn(host.exe, [compiled.exe!, cwd, statusFile, '100', '30'], {
            cwd,
            env: toolchainEnv(),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'ignore'],
            shell: false
        })
        child.stdout!.resume()
        const closed = new Promise<void>((resolve) => child!.once('close', () => resolve()))
        await expect.poll(() => fs.readFile(statusFile, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('ready')
        const pids = await Promise.all(
            ['parent-pid', 'child-pid'].map(async (file) => {
                await expect
                    .poll(() => fs.readFile(path.join(cwd, file), 'utf8').catch(() => ''), { timeout: 5000 })
                    .toMatch(/^\d+$/)
                return Number(await fs.readFile(path.join(cwd, file), 'utf8'))
            })
        )
        // Deliberately avoid taskkill /T: only kill-on-job-close can remove both
        // generations after the helper is terminated this way.
        child.kill('SIGKILL')
        await closed
        for (const pid of pids)
            await expect
                .poll(
                    () => {
                        try {
                            process.kill(pid, 0)
                            return true
                        } catch {
                            return false
                        }
                    },
                    { timeout: 5000 }
                )
                .toBe(false)
    },
    40_000
)
