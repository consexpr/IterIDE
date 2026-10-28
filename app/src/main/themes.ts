// User theme discovery. Two layouts are accepted inside `<userData>/themes/`:
//   my-theme.json                      single file (tokens only, or inline `css`)
//   my-theme/theme.json [+ theme.css]  package; assets next to the css resolve via iter://themes/my-theme/...
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

export function listThemes(dir: string): unknown[] {
    const out: unknown[] = []
    for (const name of safeReaddir(dir)) {
        const full = path.join(dir, name)
        try {
            if (name.endsWith('.json') && statSync(full).isFile()) {
                out.push(JSON.parse(readFileSync(full, 'utf8')))
            } else if (statSync(full).isDirectory() && existsSync(path.join(full, 'theme.json'))) {
                const theme = JSON.parse(readFileSync(path.join(full, 'theme.json'), 'utf8')) as Record<string, unknown>
                const css = typeof theme['cssFile'] === 'string' ? theme['cssFile'] : 'theme.css'
                if (existsSync(path.join(full, css)))
                    theme['cssUrl'] = `iter://themes/${encodeURIComponent(name)}/${css}`
                out.push(theme)
            }
        } catch (e) {
            console.warn(`[iter] theme "${name}" skipped:`, (e as Error).message)
        }
    }
    return out
}

/** Map `iter://themes/<pkg>/<file>` to a path inside the themes dir (no escaping it). */
export function themeAssetPath(dir: string, urlPath: string): string | null {
    const parts = decodeURIComponent(urlPath).split('/').filter(Boolean)
    const file = path.resolve(dir, ...parts)
    return file.startsWith(path.resolve(dir) + path.sep) ? file : null
}

/** Debounced change notification so theme authors get live reload while editing. */
export function watchThemes(dir: string, onChange: () => void): FSWatcher | null {
    let timer: NodeJS.Timeout | undefined
    try {
        return watch(dir, { recursive: true }, () => {
            clearTimeout(timer)
            timer = setTimeout(onChange, 150)
        })
    } catch {
        return null
    }
}

function safeReaddir(dir: string): string[] {
    try {
        return readdirSync(dir)
    } catch {
        return []
    }
}
