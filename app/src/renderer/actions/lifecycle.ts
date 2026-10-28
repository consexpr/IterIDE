import { editorRef } from '../editor/instance'
import { isDebugging, store, toast } from '../state/app'
import { flushFileOperations, persistFile } from './files'
import { flushProblemWrites } from './problemWrites'
import { pauseSessionSaving, resumeSessionSaving, saveSessionNow } from './session'
import { stopRun } from './judge'
import { stopDebug } from './debug'
import { stopTerminal } from './terminal'
import { waitForStartup } from './startup'

/** Finish before the main coordinator's 30-second deadline, leaving time to deliver cancel. */
export const CLOSE_PREPARE_TIMEOUT_MS = 25_000

/** Invoked while the UI is frozen, so acknowledgement covers every accepted edit. */
export async function prepareAppClose(signal?: AbortSignal): Promise<'ready' | 'cancel'> {
    signal?.throwIfAborted()
    await waitForStartup()
    await flushFileOperations()
    signal?.throwIfAborted()
    // Runtime leases protect the input snapshot. Release them before retrying pending edits.
    await Promise.all(store.get().files.map((file) => stopRun(file.path)))
    await Promise.all(store.get().files.map((file) => stopTerminal(file.path)))
    signal?.throwIfAborted()
    await stopDebug()
    signal?.throwIfAborted()
    await flushProblemWrites()
    signal?.throwIfAborted()
    // Quitting never asks: with auto-save the files are written, and whatever stays unsaved
    // (new files, edits with auto-save off) is kept by the session and comes back next time.
    if (store.get().settings.autoSave) {
        for (const file of [...store.get().files]) {
            let current = store.get().files.find((f) => f.model === file.model)
            while (current?.dirty && !current.missing && current.untitled === undefined) {
                await persistFile(current.path)
                signal?.throwIfAborted()
                current = store.get().files.find((f) => f.model === file.model)
            }
        }
    }
    await flushProblemWrites()
    signal?.throwIfAborted()
    await saveSessionNow()
    signal?.throwIfAborted()
    return 'ready'
}

export function listenAppClose(): () => void {
    const api = window.iter.app
    // Older test transports and captured development harnesses need not implement window lifecycle.
    if (typeof api.onCloseRequest !== 'function' || typeof api.resolveClose !== 'function') return () => {}
    interface Attempt {
        requestId: string
        controller: AbortController
        timer?: ReturnType<typeof setTimeout>
    }
    let active: Attempt | undefined
    const release = (attempt: Attempt): void => {
        clearTimeout(attempt.timer)
        if (active !== attempt) return
        active = undefined
        resumeSessionSaving()
        store.set({ closing: false })
        editorRef.editor?.updateOptions({ readOnly: isDebugging() })
    }
    const off = api.onCloseRequest(({ requestId }) => {
        if (active?.requestId === requestId) return
        if (active) {
            clearTimeout(active.timer)
            active.controller.abort(new Error('关闭请求已被替代'))
        }
        const attempt: Attempt = { requestId, controller: new AbortController() }
        active = attempt
        pauseSessionSaving()
        const ownsRequest = (): boolean => active === attempt && !attempt.controller.signal.aborted
        store.set({ closing: true })
        editorRef.editor?.updateOptions({ readOnly: true })
        attempt.timer = setTimeout(() => {
            if (!ownsRequest()) return
            attempt.controller.abort(new Error('退出前保存等待超时'))
            release(attempt)
            toast('退出前保存等待超时，窗口已保留；已开始的写入会继续完成', 'error', 7000)
            void api.resolveClose(requestId, 'cancel').catch(() => {})
        }, CLOSE_PREPARE_TIMEOUT_MS)
        void (async () => {
            let decision: 'ready' | 'cancel' = 'cancel'
            try {
                decision = await prepareAppClose(attempt.controller.signal)
            } catch (error) {
                if (!ownsRequest()) return
                toast(`退出前保存失败，窗口已保留：${(error as Error).message}`, 'error', 7000)
            }
            if (!ownsRequest()) return
            // Once ready is sent, main owns its bounded cleanup phase; do not thaw during disposal.
            clearTimeout(attempt.timer)
            if (decision === 'cancel') release(attempt)
            try {
                await api.resolveClose(requestId, decision)
            } catch (error) {
                if (active !== attempt && decision === 'ready') return
                if (decision === 'ready') release(attempt)
                toast(`退出请求失败：${(error as Error).message}`, 'error', 6000)
            }
        })()
    })
    return () => {
        off()
        if (active) {
            active.controller.abort(new Error('关闭监听已移除'))
            release(active)
        }
    }
}
