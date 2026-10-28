import type { WebContents, WebFrameMain } from 'electron'

/** Hash navigation stays inside the application; a different path, query or origin does not. */
export function sameDocument(url: string, expected: string): boolean {
    try {
        const actual = new URL(url),
            trusted = new URL(expected)
        actual.hash = trusted.hash = ''
        return actual.href === trusted.href
    } catch {
        return false
    }
}

/** A plugin window or subframe must never inherit the editor's filesystem/process privileges. */
export function trustedSender(
    event: { sender: WebContents; senderFrame: WebFrameMain | null },
    contents: WebContents | null | undefined,
    documentUrl: string
): boolean {
    try {
        return (
            !!contents &&
            !contents.isDestroyed() &&
            event.sender === contents &&
            !!event.senderFrame &&
            event.senderFrame === contents.mainFrame &&
            sameDocument(event.senderFrame.url, documentUrl)
        )
    } catch {
        return false /* A frame may have been destroyed while its message was queued. */
    }
}

/** Only web links belong in the OS browser. Never dispatch file, script or custom executable schemes. */
export function externalUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value))
        throw new Error('无效的网页链接')
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error('无效的网页链接')
    }
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
        throw new Error('仅允许打开 HTTP/HTTPS 网页链接')
    }
    return url.href
}
