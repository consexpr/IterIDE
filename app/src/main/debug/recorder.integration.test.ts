import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildDebug, removeBuild, type DebugBuild } from './build'
import { NativeDebugger } from './native'
import type { ToolchainSettings } from '../../shared/judge'

const tools: ToolchainSettings = {
    compiler: 'g++',
    gdb: 'gdb',
    flags: '-std=c++17',
    debugFlags: '-std=c++17 -g -O0',
    clangd: 'clangd',
    clangFormat: 'clang-format',
    parallel: 1,
    outputLimitBytes: 64 * 1024 * 1024,
    displayLimitChars: 200_000
}
let directory: string | undefined, build: DebugBuild | undefined, native: NativeDebugger | undefined
afterEach(async () => {
    await native?.dispose()
    if (build) await removeBuild(build.dir)
    if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    native = undefined
    build = undefined
    directory = undefined
})

async function prepare(source: string, maxSteps: number, input = ''): Promise<NativeDebugger> {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-recorder-'))
    build = await buildDebug(
        { sourcePath: path.join(directory, 'main.cpp'), source, input, stopAtEntry: true, breakpoints: [] },
        tools,
        new AbortController().signal
    )
    native = new NativeDebugger(
        build,
        tools,
        { maxSteps },
        () => {},
        (error) => {
            throw error
        }
    )
    await native.initialize(source)
    expect(native.python).toBe(true)
    return native
}

it('captures the input and loop line before entering a user call on that same line', async () => {
    const source =
        '#include<bits/stdc++.h>\nusing namespace std;\nint T,x;\nvoid solve(){\n cin>>x;\n x++;\n}\nsigned main(){\n ios::sync_with_stdio(0),cin.tie(0),cout.tie(0);\n cin>>T;while(T--) solve();\n return 0;\n}\n'
    const debugger_ = await prepare(source, 8, '1\n3\n')
    expect(await debugger_.resolveLine(build!.sourcePath, 10)).toBe(10)
    const result = await debugger_.record()
    expect(result.snapshots.some((s) => s.line === 10 && s.frames[0]?.func === 'main')).toBe(true)
}, 30_000)

it('reads only bounded native integer array prefixes without per-element GDB scalar conversions', async () => {
    const source =
        'using ll=long long;\nstruct Tree{ll values[4000020],tags[4000020];} tree;\nunsigned long long wide[4000020]={18446744073709551615ULL};\nint main(){\n tree.values[0]=-9223372036854775807LL;\n tree.tags[199]=42;\n return tree.values[0]==0;\n}\n'
    const debugger_ = await prepare(source, 5)
    await debugger_.console(
        `python exec(${JSON.stringify('iter_trace.scalar_calls=0\noriginal_scalar=iter_trace.scalar\ndef counted_scalar(value,typ):\n iter_trace.scalar_calls+=1\n return original_scalar(value,typ)\niter_trace.scalar=counted_scalar')})`
    )
    const result = await debugger_.record()
    const snapshot = result.snapshots.find((s) => s.line === 7)!
    const tree = snapshot.globals.find((n) => n.name === '::tree')!
    const before = result.snapshots.find((s) => s.line === 6)!.globals.find((n) => n.name === '::tree')!
    expect(before.children?.find((n) => n.name === 'tags')?.children?.[199].scalar?.value).toBe('0')
    expect(tree.children?.find((n) => n.name === 'values')?.children?.[0].scalar?.value).toBe('-9223372036854775807')
    expect(tree.children?.find((n) => n.name === 'tags')?.children?.[199].scalar?.value).toBe('42')
    const wide = snapshot.globals.find((n) => n.name === '::wide')!
    expect(wide.children?.[0].scalar).toMatchObject({ value: '18446744073709551615', signed: false, bits: 64 })
    expect(wide.children).toHaveLength(200)
    expect(wide.truncated).toBe(true)
    await expect(
        debugger_.console(
            'python assert iter_trace.scalar_calls < 100, "per-element GDB scalar conversions: " + str(iter_trace.scalar_calls)'
        )
    ).resolves.toBeDefined()
}, 30_000)

it('uses bounded output reads and preserves overwritten, truncated and UTF-8 bytes', async () => {
    const source =
        '#include<cstdio>\n#include<cstdlib>\nint main(){\n std::fputs("\\xE4\\xBD\\xA0X",stdout);\n std::fseek(stdout,0,SEEK_SET);\n std::fputs("Z",stdout);\n std::freopen(std::getenv("ITER_STDOUT"),"wb",stdout);\n std::setvbuf(stdout,nullptr,_IONBF,0);\n std::fputs("ok",stdout);\n return 0;\n}\n'
    const debugger_ = await prepare(source, 30)
    const guard = `original_open=open
class CheckedReader:
 def __init__(self,stream): self.stream=stream
 def __enter__(self): self.stream.__enter__(); return self
 def __exit__(self,*args): return self.stream.__exit__(*args)
 def read(self,count):
  assert 0<count<=65536, "oversized output read: " + str(count)
  return self.stream.read(count)
def checked_open(file,mode='r',*args,**kwargs):
 stream=original_open(file,mode,*args,**kwargs)
 return CheckedReader(stream) if mode=='rb' and file in [iter_trace.c['stdoutPath'],iter_trace.c['stderrPath']] else stream
open=checked_open`
    await debugger_.console(`python exec(${JSON.stringify(guard)})`)
    const result = await debugger_.record()
    expect(result.ended).toBe(true)
    const outputs = result.snapshots.map((s) => debugger_.recordedOutput.buffers(s.index).stdout)
    expect(outputs.some((data) => data.equals(Buffer.from('你X')))).toBe(true)
    expect(outputs.some((data) => data.equals(Buffer.from([0x5a, 0xbd, 0xa0, 0x58])))).toBe(true)
    expect(result.snapshots.some((s) => s.outputChanges?.stdout?.reset && s.outputChanges.stdout.data === '')).toBe(
        true
    )
    expect(outputs.at(-1)?.toString()).toBe('ok')
}, 30_000)

it('keeps equally named signed and unsigned local array typedefs distinct across frames', async () => {
    const source =
        'unsigned second(){\n using Number=unsigned int;\n Number values[3]={4294967295u,4294967294u,3};\n return values[0];\n}\nint first(){\n using Number=int;\n Number values[3]={-1,-2,3};\n return second()+values[0];\n}\nint main(){\n return first()==-2?0:1;\n}\n'
    const debugger_ = await prepare(source, 30)
    const result = await debugger_.record()
    const snapshot = result.snapshots.find((s) => s.line === 4 && s.frames[0]?.func === 'second')!
    expect(snapshot.frames[0].locals.find((n) => n.name === 'values')?.children?.[0].scalar).toMatchObject({
        value: '4294967295',
        signed: false,
        bits: 32
    })
    expect(snapshot.frames[1].locals.find((n) => n.name === 'values')?.children?.[0].scalar).toMatchObject({
        value: '-1',
        signed: true,
        bits: 32
    })
}, 30_000)

it('reuses unchanged sampled integer elements when one array slot changes and keeps exact history', async () => {
    const source =
        'int values[200];\nint main(){\n for(int i=0;i<80;i++){\n  values[i]=i+1;\n }\n return values[79]==80?0:1;\n}\n'
    const debugger_ = await prepare(source, 500)
    const count = `original_int=int
iter_trace.array_conversions=0
class CountedInt(int):
 @staticmethod
 def from_bytes(*args,**kwargs):
  iter_trace.array_conversions+=1
  return original_int.from_bytes(*args,**kwargs)
int=CountedInt`
    await debugger_.console(`python exec(${JSON.stringify(count)})`)
    const result = await debugger_.record()
    console.info(
        'changed-array recording',
        JSON.stringify({
            steps: result.snapshots.length,
            elapsedMs: result.elapsedMs,
            limited: result.limited,
            timings: result.timings
        })
    )
    expect(result.ended).toBe(true)
    expect(result.limited).toBeUndefined()
    const before = result.snapshots.find((s) => s.line === 4)!
    const after = result.snapshots.find((s) => s.line === 6)!
    expect(before.globals.find((n) => n.name === '::values')?.children?.[0].scalar?.value).toBe('0')
    expect(after.globals.find((n) => n.name === '::values')?.children?.[0].scalar?.value).toBe('1')
    expect(after.globals.find((n) => n.name === '::values')?.children?.[79].scalar?.value).toBe('80')
    await expect(
        debugger_.console(
            'python assert iter_trace.array_conversions < 500, "array scalar conversions: " + str(iter_trace.array_conversions)'
        )
    ).resolves.toBeDefined()
    expect(await debugger_.query(after.index, 0, 'values[79]')).toMatchObject({ value: '80' })
}, 30_000)

it('bounds repeated scalar decoding for a changing vector and nested structure array', async () => {
    const source =
        '#include<vector>\nstruct Values{long long cells[200];} data;\nstd::vector<int> numbers(200,7);\nint main(){\n for(int i=0;i<80;i++){\n  numbers[0]++;\n  data.cells[i]=i+1;\n }\n return numbers[0]==87&&data.cells[79]==80?0:1;\n}\n'
    const debugger_ = await prepare(source, 600)
    await debugger_.console(
        `python exec(${JSON.stringify('iter_trace.scalar_calls=0\noriginal_scalar=iter_trace.scalar\ndef counted_scalar(value,typ):\n iter_trace.scalar_calls+=1\n return original_scalar(value,typ)\niter_trace.scalar=counted_scalar')})`
    )
    const result = await debugger_.record()
    console.info(
        'vector-struct recording',
        JSON.stringify({
            steps: result.snapshots.length,
            elapsedMs: result.elapsedMs,
            limited: result.limited,
            timings: result.timings
        })
    )
    expect(result.ended).toBe(true)
    expect(result.limited).toBeUndefined()
    const after = result.snapshots.find((s) => s.line === 9)!
    expect(after.globals.find((n) => n.name === '::numbers')?.children?.[0].scalar?.value).toBe('87')
    expect(after.globals.find((n) => n.name === '::numbers')?.children?.[199].scalar?.value).toBe('7')
    expect(after.globals.find((n) => n.name === '::data')?.children?.[0].children?.[79].scalar?.value).toBe('80')
    await expect(
        debugger_.console(
            'python assert iter_trace.scalar_calls < 2000, "per-element GDB scalar conversions: " + str(iter_trace.scalar_calls)'
        )
    ).resolves.toBeDefined()
    expect(await debugger_.query(after.index, 0, 'data.cells[79]')).toMatchObject({ value: '80' })
}, 30_000)

it('keeps vector truncation and resizing exact and supports the vector<bool> printer fallback', async () => {
    const source =
        '#include<vector>\nstd::vector<unsigned long long> numbers;\nstd::vector<bool> bits(3,false);\nint main(){\n numbers.assign(205,18446744073709551615ULL);\n bits[1]=true;\n numbers[0]=42;\n numbers.resize(1);\n return numbers[0]==42&&bits[1]?0:1;\n}\n'
    const debugger_ = await prepare(source, 50)
    const result = await debugger_.record()
    expect(result.ended).toBe(true)
    expect(result.limited).toBeUndefined()
    const before = result.snapshots.find((s) => s.line === 8)!,
        after = result.snapshots.find((s) => s.line === 9)!
    expect(before.globals.find((n) => n.name === '::numbers')).toMatchObject({
        truncated: true,
        children: expect.arrayContaining([
            expect.objectContaining({
                scalar: expect.objectContaining({ value: '18446744073709551615', signed: false, bits: 64 })
            })
        ])
    })
    expect(after.globals.find((n) => n.name === '::numbers')).toMatchObject({
        truncated: false,
        children: [
            expect.objectContaining({ scalar: expect.objectContaining({ value: '42', signed: false, bits: 64 }) })
        ]
    })
    expect(after.globals.find((n) => n.name === '::bits')?.children?.[1]).toMatchObject({
        value: 'true',
        scalar: { value: '1', signed: false }
    })
}, 30_000)
