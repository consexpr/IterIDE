import { defaultSettings, type AppSettings } from './settings'

const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
const unsafe = (key: string): boolean => ['__proto__', 'constructor', 'prototype'].includes(key)
const ranges: Record<string, [number, number, boolean?]> = {
    uiFontSize: [1, 128],
    'editor.fontSize': [1, 256],
    'editor.lineHeight': [0.1, 10],
    'editor.letterSpacing': [-16, 64],
    'editor.fontWeight': [1, 1000],
    'editor.tabSize': [1, 32, true],
    'editor.minimapScale': [1, 3, true],
    'editor.completion.minCharRequired': [0, 128, true],
    'toolchain.parallel': [1, 64, true],
    'toolchain.outputLimitBytes': [1, 2 ** 31, true],
    'toolchain.displayLimitChars': [0, 1_000_000, true],
    'sync.intervalMin': [0, 525_600],
    'sync.maxFileBytes': [0, 128 * 1024 * 1024, true]
}

/** One runtime contract for disk, IPC, bundles and sync. Recovery drops only invalid fields. */
export function validateSettingsPatch(
    input: unknown,
    options: { recover?: boolean; invalid?: (field: string) => void } = {}
): Partial<AppSettings> {
    const invalid = (field: string): undefined => {
        options.invalid?.(field)
        if (!options.recover) throw new Error(`Invalid settings field: ${field}`)
        return undefined
    }
    const text = (value: unknown): value is string =>
        typeof value === 'string' && value.length <= 8 * 1024 * 1024 && !value.includes('\0')
    const visit = (value: unknown, base: unknown, field: string, depth: number): unknown => {
        if (value === undefined) return undefined
        if (depth > 32) return invalid(field)
        if (Array.isArray(base)) {
            if (!Array.isArray(value) || value.length > 10_000) return invalid(field)
            if (field === 'editor.completion.snippets') {
                const result: unknown[] = []
                for (const [index, item] of value.entries()) {
                    if (
                        !object(item) ||
                        !text(item.trigger) ||
                        !text(item.body) ||
                        (item.detail !== undefined && !text(item.detail))
                    ) {
                        invalid(`${field}.${index}`)
                        continue
                    }
                    result.push({
                        trigger: item.trigger,
                        body: item.body,
                        ...(item.detail === undefined ? {} : { detail: item.detail })
                    })
                }
                return result
            }
            if (value.some((item) => !text(item))) return invalid(field)
            if (
                field === 'terminal.colors' &&
                (value.length !== 3 || value.some((item) => !/^#[0-9a-f]{6}$/i.test(item as string)))
            )
                return invalid(field)
            return [...value]
        }
        if (object(base)) {
            if (!object(value)) return invalid(field)
            const result: Record<string, unknown> = {}
            for (const [key, child] of Object.entries(value)) {
                if (unsafe(key) || child === undefined) continue
                const name = field ? `${field}.${key}` : key
                if (field === 'pluginEnabled' || field === 'keybindings') {
                    if (field === 'pluginEnabled' ? typeof child !== 'boolean' : child !== null && !text(child)) {
                        invalid(name)
                        continue
                    }
                    Object.defineProperty(result, key, {
                        value: child,
                        enumerable: true,
                        writable: true,
                        configurable: true
                    })
                    continue
                }
                if (!Object.hasOwn(base, key)) continue
                const clean = visit(child, base[key], name, depth + 1)
                if (clean !== undefined) result[key] = clean
            }
            return result
        }
        if (typeof base === 'number') {
            const range = ranges[field]
            if (
                typeof value !== 'number' ||
                !Number.isFinite(value) ||
                (range && (value < range[0] || value > range[1] || (range[2] && !Number.isInteger(value))))
            )
                return invalid(field)
            return value
        }
        if (typeof base === 'string' ? !text(value) : typeof value !== typeof base) return invalid(field)
        return value
    }
    if (!object(input)) {
        invalid('settings')
        return {}
    }
    // Accept the historical completion key without mutating callers' objects.
    const source = { ...input }
    if (object(source.editor) && object(source.editor.completion)) {
        const completion = { ...source.editor.completion }
        if (completion.model === undefined && completion.cnn !== undefined) completion.model = completion.cnn
        delete completion.cnn
        source.editor = { ...source.editor, completion }
    }
    return visit(source, defaultSettings(), '', 0) as Partial<AppSettings>
}
