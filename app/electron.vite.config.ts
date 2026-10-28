import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            rollupOptions: {
                input: {
                    index: resolve('src/main/index.ts'),
                    'model-worker': resolve('src/main/model/worker.ts')
                }
            }
        }
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        build: {
            rollupOptions: {
                input: {
                    index: resolve('src/preload/index.ts'),
                    terminal: resolve('src/preload/terminal.ts')
                }
            }
        }
    },
    renderer: {
        plugins: [react()],
        build: {
            rollupOptions: {
                input: {
                    index: resolve('src/renderer/index.html'),
                    terminal: resolve('src/renderer/terminal.html')
                }
            }
        }
    }
})
