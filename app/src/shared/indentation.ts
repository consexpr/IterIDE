export interface IndentationSettings {
    tabSize: number
    insertSpaces: boolean
}

export function indentationSettings(value: IndentationSettings): IndentationSettings {
    return {
        tabSize: Number.isInteger(value.tabSize) && value.tabSize >= 1 && value.tabSize <= 8 ? value.tabSize : 4,
        insertSpaces: typeof value.insertSpaces === 'boolean' ? value.insertSpaces : true
    }
}
