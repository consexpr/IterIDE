// UI automation hooks, exposed only in capture mode (window.iter.dev exists). Lets ITER_EVAL
// scripts drive real actions instead of synthesising clicks.
import * as debug from './actions/debug'
import * as files from './actions/files'
import * as folders from './actions/folders'
import { routeDrop } from './ui/shell/drop'
import * as judge from './actions/judge'
import * as settings from './actions/settings'
import * as tests from './actions/tests'
import { editorRef } from './editor/instance'
import { monaco } from './editor/monaco'
import { store } from './state/app'

export function exposeDevHooks(): void {
    if (!window.iter.dev) return
    window.addEventListener('error', (e) => console.log('UNCAUGHT', e.error?.stack ?? e.message))
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    /** Resolve once `pred(state)` holds, or after `ms`. */
    const until = async (pred: (s: ReturnType<typeof store.get>) => boolean, ms = 15000): Promise<boolean> => {
        const end = Date.now() + ms
        while (Date.now() < end) {
            if (pred(store.get())) return true
            await sleep(100)
        }
        return false
    }
    Object.assign(window, {
        __nv: {
            store,
            editorRef,
            monaco,
            debug,
            files,
            folders,
            judge,
            settings,
            tests,
            routeDrop,
            sleep,
            until,
            shot: window.iter.dev.capture
        }
    })
}
