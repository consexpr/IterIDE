import { Store, useStore } from './store'

export const sessionHealth = new Store<{ error: string | null }>({ error: null })
export const useSessionError = (): string | null => useStore(sessionHealth, (state) => state.error)
