/** Read-only compatibility with files and extensions created before the ITER rename. */
export const LEGACY_BRAND = 'naven'
export const LEGACY_SCHEME = LEGACY_BRAND
export const LEGACY_PLUGIN_MANIFEST = 'naven-plugin.json'
export const LEGACY_CONFIG_FORMAT = 'naven-config'
export const LEGACY_CONFIG_EXTENSION = 'navenconf'
export const LEGACY_STORE_DIRECTORY = '.naven'
export const LEGACY_SYNC_REPOSITORY = 'naven-sync'

/** Only built-in ids are renamed; an author's other theme ids remain unchanged. */
export function canonicalThemeId(id: string): string {
    return /^naven-(dusk|ember|forest|paper|mist|terminal)$/.test(id) ? id.replace(/^naven-/, 'iter-') : id
}
