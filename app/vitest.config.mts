import { defineConfig } from 'vitest/config'

// Keep test discovery away from local caches and recoverable source backups.
export default defineConfig({
    test: {
        include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.{mjs,cjs}'],
        setupFiles: ['scripts/test-setup.mjs'],
        maxWorkers: 2
    }
})
