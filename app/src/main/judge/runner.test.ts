import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileSource } from './compile'
import { execute, launch } from './process'
import { getRunner, readAccounting } from './runner'
import * as resources from './resources'
import type { ToolchainSettings } from '../../shared/judge'

const tc: ToolchainSettings = {
    compiler: 'g++',
    flags: '-std=c++17 -O2 -Wall -Wextra -Wshadow',
    debugFlags: '-g',
    gdb: 'gdb',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 4,
    outputLimitBytes: 64 * 1024,
    displayLimitChars: 1000
}

describe.skipIf(process.platform !== 'win32')('runner in a Windows GUI parent', () => {
    let dir: string
    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-runner-test-'))
    })
    afterEach(async () => {
        vi.restoreAllMocks()
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    })

    it('reports an access violation promptly even when its parent allows OS error dialogs', async () => {
        // Node normally suppresses these dialogs, hiding the bug from Vitest. Launch
        // the same helper under the error mode inherited from a Windows GUI app.
        const launcher = await compileSource(
            path.join(dir, 'gui-parent.cpp'),
            `
#include <windows.h>
#include <process.h>
int main(int argc, char** argv) {
    if (argc < 2) return 125;
    SetErrorMode(0);
    return _spawnv(_P_WAIT, argv[1], argv + 1);
}`,
            tc,
            false
        )
        const crash = await compileSource(
            path.join(dir, 'crash.cpp'),
            'int main(){*static_cast<volatile int*>(nullptr)=1;}',
            tc,
            false
        )
        expect(launcher.ok, launcher.output).toBe(true)
        expect(crash.ok, crash.output).toBe(true)
        const runner = await getRunner(tc)
        expect(runner).toBeTruthy()
        const input = path.join(dir, 'empty.in')
        await fs.writeFile(input, '')
        const result = await execute(
            launcher.exe!,
            [runner!, path.join(dir, 'result.json'), '1000', '512', crash.exe!],
            {
                cwd: dir,
                input,
                timeout: 2500
            }
        )
        expect(result.timedOut).toBe(false)
        expect(result.code).toBe(0)
        expect(await readAccounting(dir)).toMatchObject({
            status: 'ok',
            wallTimedOut: false,
            exitCode: 0xc0000005
        })
        const passthrough = await execute(launcher.exe!, [runner!, '--exec', '--', crash.exe!], {
            cwd: dir,
            input,
            timeout: 1500
        })
        expect(passthrough).toMatchObject({ code: 0xc0000005, timedOut: false })
    }, 40_000)

    it('preserves Windows arguments, Unicode executable paths, stdio and exit codes', async () => {
        const build = await compileSource(
            path.join(dir, 'arguments.cpp'),
            `
#include <windows.h>
#include <shellapi.h>
#include <cstdio>
#include <string>
#include <iostream>
int main() {
    int argc = 0; auto argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; i < argc; ++i) {
        int n = WideCharToMultiByte(CP_UTF8,0,argv[i],-1,nullptr,0,nullptr,nullptr);
        std::string arg(n,'\\0');
        WideCharToMultiByte(CP_UTF8,0,argv[i],-1,arg.data(),n,nullptr,nullptr);
        for (int j = 0; j < n-1; ++j) printf("%02x",static_cast<unsigned char>(arg[j]));
        puts("");
    }
    LocalFree(argv);
    int x=0; std::cin>>x; std::cout<<x<<'\\n'; std::cerr<<"stderr";
    return 7;
}`,
            tc,
            false,
            '-lshell32'
        )
        expect(build.ok, build.output).toBe(true)
        const directory = path.join(dir, '执行 目录')
        await fs.mkdir(directory)
        const exe = path.join(directory, '参数程序.exe'),
            input = path.join(dir, 'case.in')
        await fs.copyFile(build.exe!, exe)
        await fs.writeFile(input, '42\n')
        const runner = await getRunner(tc)
        expect(runner).toBeTruthy()
        const args = ['', 'a b', 'a"b', 'C:\\trailing\\', 'space \\', '\\\\"quote', '雪与猫']
        const result = await execute(exe, args, { runner, input, timeout: 1500 })
        expect(result).toMatchObject({ code: 7, timedOut: false, stderr: 'stderr' })
        expect(result.stdout.replaceAll('\r\n', '\n')).toBe(
            args.map((arg) => Buffer.from(arg).toString('hex')).join('\n') + '\n42\n'
        )
    }, 40_000)

    it('kills the entire passthrough job when only the runner is forcibly terminated', async () => {
        const build = await compileSource(
            path.join(dir, 'tree.cpp'),
            `
#include <windows.h>
#include <fstream>
#include <string>
int main(int argc, char** argv) {
    if (argc == 1) { Sleep(INFINITE); return 0; }
    wchar_t exe[32768]; GetModuleFileNameW(nullptr,exe,32768);
    std::wstring command=L"\\\""+std::wstring(exe)+L"\\\"";
    STARTUPINFOW startup{}; startup.cb=sizeof(startup); PROCESS_INFORMATION child{};
    if (!CreateProcessW(exe,command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW,nullptr,nullptr,&startup,&child)) return 1;
    { std::ofstream out(argv[1]); out<<GetCurrentProcessId()<<" "<<child.dwProcessId; }
    CloseHandle(child.hThread); CloseHandle(child.hProcess);
    Sleep(INFINITE);
}`,
            tc,
            false
        )
        expect(build.ok, build.output).toBe(true)
        const runner = await getRunner(tc)
        expect(runner).toBeTruthy()
        const file = path.join(dir, 'pids.txt'),
            pids: number[] = []
        const child = launch(runner!, ['--exec', '--', build.exe!, file], dir)
        child.stdin.end()
        child.stdout.resume()
        child.stderr.resume()
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        try {
            const deadline = Date.now() + 2000
            while (!pids.length) {
                const content = await fs.readFile(file, 'utf8').catch(() => '')
                if (/^\d+ \d+$/.test(content)) pids.push(...content.split(' ').map(Number))
                else if (Date.now() > deadline) throw new Error('Passthrough descendants did not start')
                else await new Promise((resolve) => setTimeout(resolve, 10))
            }
            child.kill('SIGKILL') // Do not use taskkill /T: the job must clean up itself.
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Passthrough job did not close its pipes')), 1500)
                void closed.then(() => {
                    clearTimeout(timer)
                    resolve()
                })
            })
            for (const pid of pids)
                expect(() => process.kill(pid, 0), `Descendant ${pid} survived the runner`).toThrow()
        } finally {
            child.kill('SIGKILL')
            for (const pid of pids) {
                try {
                    process.kill(pid, 'SIGKILL')
                } catch {
                    /* already gone */
                }
            }
        }
    }, 40_000)

    it('does not leave suspended children or open pipes when stopped during process creation', async () => {
        const build = await compileSource(
            path.join(dir, 'sleep.cpp'),
            '#include <windows.h>\nint main(){Sleep(INFINITE);}',
            tc,
            false
        )
        expect(build.ok, build.output).toBe(true)
        const runner = await getRunner(tc)
        expect(runner).toBeTruthy()
        for (const delay of [1, 5, 10, 15, 20, 25, 30, 10, 15, 20]) {
            const child = launch(runner!, ['--exec', '--', build.exe!], dir)
            child.stdin.end()
            child.stdout.resume()
            child.stderr.resume()
            try {
                await new Promise<void>((resolve, reject) => {
                    const stop = setTimeout(() => child.kill('SIGKILL'), delay)
                    const timeout = setTimeout(
                        () => reject(new Error(`Job/pipes survived cancellation at ${delay} ms`)),
                        1500
                    )
                    child.once('close', () => {
                        clearTimeout(stop)
                        clearTimeout(timeout)
                        resolve()
                    })
                })
            } finally {
                child.kill('SIGKILL')
                child.stdin.destroy()
                child.stdout.destroy()
                child.stderr.destroy()
            }
        }
    }, 40_000)

    it('can still build and run the helper lazily when the packaged executable is absent', async () => {
        const original = resources.resourceFile
        vi.spyOn(resources, 'resourceFile').mockImplementation((relative) =>
            relative === 'runner/runner.exe' ? Promise.reject(new Error('No prebuilt helper')) : original(relative)
        )
        const runner = await getRunner(tc)
        expect(runner).toBeTruthy()
        expect(runner).not.toBe(path.resolve('resources/runner/runner.exe'))
        expect(
            await execute(runner!, ['--exec', '--', process.execPath, '-e', 'process.exit(7)'], { timeout: 2000 })
        ).toMatchObject({ code: 7, timedOut: false })
    }, 40_000)
})
