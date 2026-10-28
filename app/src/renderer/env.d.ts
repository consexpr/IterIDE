/// <reference types="vite/client" />
import type { IterApi } from '../shared/api'

declare global {
    interface Window {
        iter: IterApi
    }
}
