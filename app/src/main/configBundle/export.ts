import { app } from 'electron'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { SettingsStore } from '../settings'
import { contents, isWithin, type Manifest } from './common'
import { collectConfig } from './collect'
import { writeZip, type ZipSource } from './zip'

export async function exportConfig(targetPath: string, settings: SettingsStore): Promise<string> {
    const target = path.resolve(targetPath)
    const dirs = settings.userDirs()
    if (
        Object.values(dirs).some((dir) => isWithin(dir, target)) ||
        path.relative(path.join(app.getPath('userData'), 'settings.json'), target) === ''
    ) {
        throw new Error('Save the config bundle outside the user configuration directories')
    }
    async function* entries(): AsyncGenerator<ZipSource> {
        const manifest: Manifest = {
            format: 'iter-config',
            version: 2,
            appVersion: app.getVersion(),
            createdAt: new Date().toISOString(),
            contents
        }
        yield { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }
        yield* collectConfig(settings)
    }
    const temp = await mkdtemp(path.join(path.dirname(target), '.iter-config-export-'))
    try {
        const file = path.join(temp, 'bundle')
        await writeZip(file, entries())
        await rename(file, target)
        return target
    } finally {
        await rm(temp, { recursive: true, force: true })
    }
}
