import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isInside, pluginFilePath } from './paths'
import sdkScript from '../../../resources/sdk/panel.js?raw'
import sdkTypes from '../../../resources/sdk/iter-panel.d.ts?raw'
import { LEGACY_SCHEME } from '../../shared/legacyBrand'

// Only activated plugins can expose assets. The manager owns registration and removal.
const directories = new Map<string, string>()
export function registerPluginAssets(id: string, directory: string): void {
    directories.set(id, directory)
}
export function unregisterPluginAssets(id: string): void {
    directories.delete(id)
}

const mime: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8'
}

export function panelCsp(id: string): string {
    const own = ['iter', LEGACY_SCHEME].map((scheme) => `${scheme}://plugins/${encodeURIComponent(id)}/`).join(' ')
    const sdk = `iter://sdk ${LEGACY_SCHEME}://sdk`
    const fonts = `iter://fonts ${LEGACY_SCHEME}://fonts`
    return [
        "default-src 'none'",
        `script-src ${own} ${sdk} 'unsafe-inline' 'wasm-unsafe-eval'`,
        `style-src ${own} 'unsafe-inline'`,
        `img-src ${own} data: blob:`,
        `font-src ${own} ${fonts} data:`,
        `connect-src ${own} ${sdk}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'"
    ].join('; ')
}

/** Raw URL inspection precedes WHATWG normalization so encoded/literal dot segments are rejected. */
export async function servePluginRequest(url: string): Promise<Response> {
    try {
        const compatibleUrl = url.startsWith(`${LEGACY_SCHEME}://`)
            ? `iter://${url.slice(LEGACY_SCHEME.length + 3)}`
            : url
        const match = /^iter:\/\/(plugins|sdk)(\/[^?#]*)?(?:[?#].*)?$/.exec(compatibleUrl)
        if (!match) return new Response('not found', { status: 404 })
        const parts = decodeURIComponent(match[2] ?? '')
            .split('/')
            .slice(1)
        if (parts.some((part) => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f:]/.test(part))) {
            return new Response('forbidden path', { status: 403 })
        }
        let directory: string | undefined
        let entry: string
        let csp: string | undefined
        if (match[1] === 'plugins') {
            const id = parts.shift()!
            directory = directories.get(id)
            entry = parts.join('/')
            csp = panelCsp(id)
        } else {
            entry = parts.join('/')
            const content =
                entry === 'panel.js'
                    ? sdkScript
                    : entry === 'iter-panel.d.ts' || entry === `${LEGACY_SCHEME}-panel.d.ts`
                      ? sdkTypes
                      : null
            if (content === null) return new Response('not found', { status: 404 })
            // Vite embeds these tiny sources into the main bundle, so packaged builds need no extra files.
            return new Response(content, {
                headers: {
                    'Content-Type': entry === 'panel.js' ? mime['.js'] : mime['.ts'],
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'no-store',
                    'Access-Control-Allow-Origin': '*'
                }
            })
        }
        if (!directory) return new Response('not found', { status: 404 })
        const file = pluginFilePath(directory, entry)
        if (!file) return new Response('forbidden path', { status: 403 })
        const [realDir, realFile] = await Promise.all([fs.realpath(directory), fs.realpath(file)])
        if (!isInside(realDir, realFile)) return new Response('forbidden path', { status: 403 })
        if (!(await fs.stat(realFile)).isFile()) return new Response('not found', { status: 404 })
        return new Response(new Uint8Array(await fs.readFile(realFile)), {
            headers: {
                'Content-Type': mime[path.extname(realFile).toLowerCase()] ?? 'application/octet-stream',
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-store',
                // Sandboxed iframes have opaque origins, including when they import the SDK as a module.
                'Access-Control-Allow-Origin': '*',
                ...(csp ? { 'Content-Security-Policy': csp } : {})
            }
        })
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        return new Response('not found', {
            status: code === 'EACCES' || code === 'EPERM' ? 403 : error instanceof URIError ? 403 : 404
        })
    }
}
