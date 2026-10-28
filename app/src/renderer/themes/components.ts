/** Optional component tokens. Values use CSS syntax; unspecified values follow the shared palette. */
export interface ThemeComponents {
    brand?: Partial<
        Record<
            'color' | 'wordmarkColor' | 'font' | 'creaseColor' | 'creaseOpacity' | 'motionDuration' | 'motionEasing',
            string
        >
    >
    search?: Partial<
        Record<
            | 'background'
            | 'inputBackground'
            | 'border'
            | 'shadow'
            | 'backdropFilter'
            | 'radius'
            | 'width'
            | 'controlHeight'
            | 'openDuration'
            | 'closeDuration'
            | 'easing'
            | 'offset'
            | 'scale',
            string
        >
    >
    snapshots?: Partial<
        Record<
            'background' | 'previewBackground' | 'selection' | 'border' | 'rowHeight' | 'controlHeight' | 'radius',
            string
        >
    >
    checker?: Partial<
        Record<
            | 'background'
            | 'codeBackground'
            | 'argumentBackground'
            | 'argumentSelection'
            | 'argumentRadius'
            | 'argumentDuration'
            | 'argumentEasing'
            | 'border'
            | 'backdropFilter'
            | 'controlHeight'
            | 'radius',
            string
        >
    >
}

const keys = {
    brand: ['color', 'wordmarkColor', 'font', 'creaseColor', 'creaseOpacity', 'motionDuration', 'motionEasing'],
    search: [
        'background',
        'inputBackground',
        'border',
        'shadow',
        'backdropFilter',
        'radius',
        'width',
        'controlHeight',
        'openDuration',
        'closeDuration',
        'easing',
        'offset',
        'scale'
    ],
    snapshots: ['background', 'previewBackground', 'selection', 'border', 'rowHeight', 'controlHeight', 'radius'],
    checker: [
        'background',
        'codeBackground',
        'argumentBackground',
        'argumentSelection',
        'argumentRadius',
        'argumentDuration',
        'argumentEasing',
        'border',
        'backdropFilter',
        'controlHeight',
        'radius'
    ]
} as const

export function mergeComponents(base: ThemeComponents = {}, own: ThemeComponents = {}): ThemeComponents {
    return {
        brand: { ...base.brand, ...own.brand },
        search: { ...base.search, ...own.search },
        snapshots: { ...base.snapshots, ...own.snapshots },
        checker: { ...base.checker, ...own.checker }
    }
}

/** Clear old overrides so switching to a legacy theme restores CSS defaults, including transparency. */
export function applyComponentTokens(
    style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>,
    theme: ThemeComponents = {}
): void {
    for (const group of ['brand', 'search', 'snapshots', 'checker'] as const) {
        for (const key of keys[group]) {
            const variable = `--${group}-${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`
            style.removeProperty(variable)
            const value = (theme[group] as Record<string, unknown> | undefined)?.[key]
            if (typeof value === 'string') style.setProperty(variable, value)
        }
    }
}
