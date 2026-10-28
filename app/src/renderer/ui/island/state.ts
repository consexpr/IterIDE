// Open/closed state of the expanded island (kept in the app store so anything can open it).
import { store } from '../../state/app'

export const openIsland = (): void => store.set({ islandOpen: true })
export const closeIsland = (): void => store.set({ islandOpen: false })
export const toggleIsland = (): void => store.set((s) => ({ islandOpen: !s.islandOpen }))
