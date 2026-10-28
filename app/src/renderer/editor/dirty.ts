interface VersionedText {
    getAlternativeVersionId(): number
    getValueLength(): number
    getValue(): string
}

/** Undo can return to the saved version; ordinary typing rarely needs a full text comparison. */
export function isModelDirty(model: VersionedText, savedVersion: number, savedText: string): boolean {
    if (model.getAlternativeVersionId() === savedVersion) return false
    if (model.getValueLength() !== savedText.length) return true
    // Preserve clean-state detection when edits recreate the saved text without undo.
    return model.getValue() !== savedText
}
