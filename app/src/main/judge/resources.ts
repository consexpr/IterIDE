import { promises as fs } from 'node:fs'
import path from 'node:path'

export async function resourceFile(relative: string): Promise<string> {
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
    const candidates = [
        ...(resourcesPath
            ? [
                  path.join(resourcesPath, relative),
                  path.join(resourcesPath, 'resources', relative),
                  path.join(resourcesPath, 'app.asar.unpacked', 'resources', relative),
                  path.join(resourcesPath, 'app.asar', 'resources', relative)
              ]
            : []),
        path.resolve('resources', relative),
        path.resolve(__dirname, '../../resources', relative)
    ]
    for (const candidate of candidates)
        if (
            await fs.access(candidate).then(
                () => true,
                () => false
            )
        )
            return candidate
    throw new Error(`Bundled resource not found: ${relative}`)
}
