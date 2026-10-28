import { store } from '../state/app'
import { flushFileOperations } from './files'
import { flushProblemWrites } from './problemWrites'
import { pauseSessionSaving, saveSessionNow } from './session'

let pending: Promise<string> | undefined
export const isRecovering = (): boolean => pending !== undefined

/** Preserve live models after a UI error; partial startup must never replace the previous session. */
export function preserveRecoverySession(): Promise<string> {
    if (pending) return pending
    pauseSessionSaving()
    store.set({ closing: true })
    if (!store.get().ready) {
        return (pending = Promise.resolve('启动尚未完成，已保留上次会话。'))
    }
    pending = (async () => {
        let expired = false
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([
                (async () => {
                    await flushFileOperations()
                    await flushProblemWrites()
                    if (expired) return
                    await saveSessionNow()
                })(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => {
                        expired = true
                        reject(new Error('保存会话超时'))
                    }, 4000)
                })
            ])
            return '当前编辑内容已保存到会话，重新启动后可恢复。'
        } catch (error) {
            console.error('[iter] could not preserve recovery session', error)
            return '未能保存当前会话。重新启动后将尝试恢复最近一次成功保存的内容。'
        } finally {
            clearTimeout(timer)
        }
    })()
    return pending
}
