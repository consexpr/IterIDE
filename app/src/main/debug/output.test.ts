import { expect, it } from 'vitest'
import { TraceOutput } from './output'
import type { Snapshot } from './trace'
it('retains overwritten output and withholds incomplete UTF-8 sequences', () => {
    const output = new TraceOutput()
    const add = (data: number[], reset = false): void =>
        output.add({ outputChanges: { stdout: { reset, data: Buffer.from(data).toString('base64') } } } as Snapshot)
    add([0xe4, 0xb8])
    expect(output.view(0)).toMatchObject({ stdout: '', stdoutOffset: 2 })
    add([0xad])
    expect(output.view(1)).toMatchObject({ stdout: '中', stdoutOffset: 3 })
    add([90], true)
    expect(output.view(2)).toMatchObject({ stdout: 'Z', stdoutOffset: 1 })
    expect(output.view(1)).toMatchObject({ stdout: '中', stdoutOffset: 3 })
})
it('shows a bounded UTF-8 tail while retaining exact old buffers for rewinds', () => {
    const output = new TraceOutput()
    output.add({
        outputChanges: { stdout: { reset: true, data: Buffer.from('abcdefgh中').toString('base64') } }
    } as Snapshot)
    output.add({ outputChanges: { stdout: { reset: false, data: Buffer.from('文').toString('base64') } } } as Snapshot)
    expect(output.view(1, 3)).toMatchObject({ stdout: 'h中文', stdoutOffset: 14 })
    expect(output.view(0, 3)).toMatchObject({ stdout: 'gh中', stdoutOffset: 11 })
    expect(output.buffers(0).stdout.toString()).toBe('abcdefgh中')
})
