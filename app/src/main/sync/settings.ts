import { writeFileSync } from 'node:fs'
import type { SettingsStore } from '../settings'
import { settingsContent } from '../configBundle/collect'
import { parseJson, portableSettings } from '../configBundle/common'
import { safePath } from '../configBundle/files'
import { conflictName } from './apply'
import { blobSha } from './github'

/** Settings are virtual portable JSON, not the raw file containing recent paths. */
export async function installSettings(
    root: string,
    settings: SettingsStore,
    content: Buffer,
    base?: string
): Promise<boolean> {
    const imported = portableSettings(parseJson(content, 'settings'))
    await safePath(root, 'settings.json')
    const backup = await safePath(root, conflictName('settings.json'))
    // No yield between capturing live settings, backing them up and applying the patch.
    // replaceConfig() preserves local history and updates main-process consumers, including map removals.
    const current = settingsContent(settings)
    const sha = blobSha(current)
    const conflict = sha !== base && sha !== blobSha(content)
    if (conflict) writeFileSync(backup, current, { flag: 'wx', mode: 0o600 })
    settings.replaceConfig(imported)
    return conflict
}
