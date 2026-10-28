import { openFile } from './files'
import { store } from '../state/app'

const pendingPaths: string[] = []
const startupWaiters = new Set<() => void>()

export function waitForStartup(): Promise<void> {
    if (store.get().ready !== false) return Promise.resolve()
    return new Promise((resolve) => startupWaiters.add(resolve))
}

/** Keep argv/second-instance opens behind session restoration so each model has one owner. */
export function openExternalFiles(paths: string[]): void {
    if (!store.get().ready) {
        pendingPaths.push(...paths)
        return
    }
    for (const path of paths) void openFile(path)
}

export async function finishStartup(): Promise<void> {
    store.set({ ready: true })
    while (pendingPaths.length) {
        const path = pendingPaths.shift()!
        await openFile(path)
    }
    for (const resolve of startupWaiters) resolve()
    startupWaiters.clear()
}
