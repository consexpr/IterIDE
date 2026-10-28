// clangd knows what every identifier is; the Monarch grammar can only guess from spelling. These
// tokens are laid over the grammar, so one name is one colour wherever it appears (a macro, a
// local, a global), and kinds the grammar cannot tell apart get their own colour.

export interface SemanticLegend {
    tokenTypes: string[]
    tokenModifiers: string[]
}

/**
 * The legend Monaco is given. Names are the keys a theme colours (prefix matched, like the grammar's
 * own): the first group deliberately reuses the grammar's names so both agree on them.
 */
export const ITER_LEGEND: SemanticLegend = {
    tokenTypes: [
        'function',
        'type',
        'type.stl',
        'constant',
        'comment',
        'macro',
        'variable.local',
        'variable.param',
        'variable.global',
        'variable.field',
        'namespace',
        'label'
    ],
    tokenModifiers: []
}
const INDEX = new Map(ITER_LEGEND.tokenTypes.map((name, index) => [name, index]))

/** What the editor client advertises, so clangd serves tokens in the encoding decoded below. */
export const CLIENT_CAPABILITY = {
    requests: { full: true, range: false },
    tokenTypes: [
        'variable',
        'parameter',
        'function',
        'method',
        'property',
        'class',
        'interface',
        'enum',
        'enumMember',
        'type',
        'unknown',
        'namespace',
        'typeParameter',
        'concept',
        'modifier',
        'operator',
        'bracket',
        'label',
        'comment',
        'macro',
        'field'
    ],
    tokenModifiers: [
        'declaration',
        'definition',
        'deprecated',
        'deduced',
        'readonly',
        'static',
        'abstract',
        'virtual',
        'dependentName',
        'defaultLibrary',
        'usedAsMutableReference',
        'usedAsMutablePointer',
        'constructorOrDestructor',
        'userDefined',
        'functionScope',
        'classScope',
        'fileScope',
        'globalScope'
    ],
    formats: ['relative'],
    overlappingTokenSupport: false,
    multilineTokenSupport: false
}

/** The theme key for one clangd token, or null to leave the grammar's colour. */
export function classify(type: string, modifiers: ReadonlySet<string>): string | null {
    const std = modifiers.has('defaultLibrary')
    switch (type) {
        case 'macro':
            return 'macro'
        case 'parameter':
            return 'variable.param'
        case 'field':
            return 'variable.field'
        case 'property':
            return 'variable.field'
        case 'variable':
            if (modifiers.has('readonly') && !modifiers.has('functionScope')) return 'constant'
            if (modifiers.has('functionScope')) return 'variable.local'
            if (modifiers.has('classScope')) return 'variable.field'
            if (modifiers.has('fileScope') || modifiers.has('globalScope')) return 'variable.global'
            return 'variable.local'
        case 'function':
        case 'method':
            return 'function'
        case 'class':
        case 'interface':
        case 'enum':
        case 'type':
        case 'typeParameter':
        case 'concept':
            return std ? 'type.stl' : 'type'
        case 'enumMember':
            return 'constant'
        case 'namespace':
            return std ? 'type.stl' : 'namespace'
        case 'label':
            return 'label'
        case 'comment':
            return 'comment'
        default:
            return null
    }
}

/** Re-encode clangd's relative token stream with the ITER legend, dropping tokens left to the grammar. */
export function remapSemanticTokens(data: ArrayLike<number>, legend: SemanticLegend): Uint32Array {
    const out: number[] = []
    let line = 0,
        character = 0,
        outLine = 0,
        outCharacter = 0
    for (let i = 0; i + 4 < data.length; i += 5) {
        line += data[i]
        character = data[i] === 0 ? character + data[i + 1] : data[i + 1]
        const type = legend.tokenTypes[data[i + 3]]
        if (type === undefined || data[i + 2] <= 0) continue
        const modifiers = new Set<string>()
        for (let bit = 0; bit < legend.tokenModifiers.length; bit++)
            if (data[i + 4] & (1 << bit)) modifiers.add(legend.tokenModifiers[bit])
        const name = classify(type, modifiers)
        const mapped = name === null ? undefined : INDEX.get(name)
        if (mapped === undefined) continue
        const deltaLine = line - outLine
        out.push(deltaLine, deltaLine === 0 ? character - outCharacter : character, data[i + 2], mapped, 0)
        outLine = line
        outCharacter = character
    }
    return new Uint32Array(out)
}
