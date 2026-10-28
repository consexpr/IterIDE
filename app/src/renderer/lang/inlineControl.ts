let once = false
export function activateInlineShortcut(): void {
    once = true
}
export function allowInlineRequest(): boolean {
    const allowed = once
    once = false
    return allowed
}
