import os from 'node:os'
import path from 'node:path'

/** Shared by problem storage and sync. Resolve at call time so tests can isolate the store. */
export function storeRoot(): string {
    return process.env.ITER_STORE ? path.resolve(process.env.ITER_STORE) : path.join(os.homedir(), '.iter')
}
