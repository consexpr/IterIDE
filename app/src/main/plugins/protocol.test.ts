import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerPluginAssets, servePluginRequest, unregisterPluginAssets } from './protocol'

describe('plugin asset protocol', () => {
    let root: string
    let pluginDir: string
    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'iter-panel-assets-'))
        pluginDir = path.join(root, 'plugin')
        await fs.mkdir(pluginDir)
        registerPluginAssets('assets', pluginDir)
    })
    afterEach(async () => {
        unregisterPluginAssets('assets')
        await fs.rm(root, { recursive: true, force: true })
    })

    it.each([
        ['html', 'text/html; charset=utf-8'],
        ['js', 'text/javascript; charset=utf-8'],
        ['css', 'text/css; charset=utf-8'],
        ['png', 'image/png'],
        ['svg', 'image/svg+xml'],
        ['json', 'application/json; charset=utf-8'],
        ['wasm', 'application/wasm']
    ])('serves %s with MIME, CSP, no caching and opaque-origin access', async (extension, type) => {
        await fs.writeFile(path.join(pluginDir, `file.${extension}`), 'content')
        const response = await servePluginRequest(`iter://plugins/assets/file.${extension}`)
        expect(response.status).toBe(200)
        expect(await response.text()).toBe('content')
        expect(response.headers.get('content-type')).toBe(type)
        expect(response.headers.get('content-security-policy')).toContain('iter://plugins/assets/')
        expect(response.headers.get('content-security-policy')).toContain('iter://sdk')
        expect(response.headers.get('x-content-type-options')).toBe('nosniff')
        expect(response.headers.get('access-control-allow-origin')).toBe('*')
        expect(response.headers.get('cache-control')).toBe('no-store')
    })

    it.each([
        '../outside.html',
        '%2e%2e/outside.html',
        '%2e%2e%2foutside.html',
        '..%5coutside.html',
        'nested/../../outside.html',
        '/outside.html',
        'C:/outside.html',
        'file.html:stream',
        '%00.html',
        '%zz.html'
    ])('blocks traversal and malformed paths: %s', async (entry) => {
        await fs.writeFile(path.join(root, 'outside.html'), 'secret')
        const response = await servePluginRequest(`iter://plugins/assets/${entry}`)
        expect(response.status).toBe(403)
        expect(await response.text()).not.toContain('secret')
    })

    it('blocks a directory junction outside the plugin and serves nested/escaped filenames inside it', async () => {
        await fs.mkdir(path.join(root, 'outside'))
        await fs.writeFile(path.join(root, 'outside/secret.html'), 'secret')
        await fs.symlink(
            path.join(root, 'outside'),
            path.join(pluginDir, 'link'),
            process.platform === 'win32' ? 'junction' : 'dir'
        )
        expect((await servePluginRequest('iter://plugins/assets/link/secret.html')).status).toBe(403)
        await fs.mkdir(path.join(pluginDir, 'nested'))
        await fs.writeFile(path.join(pluginDir, 'nested/页面 with spaces.html'), '<p>ok</p>')
        expect(
            (await servePluginRequest('iter://plugins/assets/nested/' + encodeURIComponent('页面 with spaces.html')))
                .status
        ).toBe(200)
    })

    it('preserves old plugin URLs with the same path restrictions and current SDK', async () => {
        await fs.writeFile(path.join(pluginDir, 'legacy.html'), '<p>legacy</p>')
        const page = await servePluginRequest('naven://plugins/assets/legacy.html')
        expect(page.status).toBe(200)
        expect(page.headers.get('content-security-policy')).toContain('naven://sdk')
        expect((await servePluginRequest('naven://plugins/assets/%2e%2e/outside.html')).status).toBe(403)
        const sdk = await servePluginRequest('naven://sdk/panel.js')
        expect(await sdk.text()).toContain('window.naven = window.iter')
        const declaration = await servePluginRequest('naven://sdk/naven-panel.d.ts')
        expect(await declaration.text()).toContain('type NavenPanel = IterPanel')
    })

    it('returns 404 for missing/unloaded plugins and exposes the packaged SDK and declarations', async () => {
        expect((await servePluginRequest('iter://plugins/missing/file.html')).status).toBe(404)
        expect((await servePluginRequest('iter://plugins/assets/missing.html')).status).toBe(404)
        const sdk = await servePluginRequest('iter://sdk/panel.js')
        expect(sdk.status).toBe(200)
        expect(sdk.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
        expect(await sdk.text()).toContain('iter:request')
        expect(await (await servePluginRequest('iter://sdk/iter-panel.d.ts')).text()).toContain('IterPanelState')
        expect((await servePluginRequest('iter://sdk/other.js')).status).toBe(404)
        unregisterPluginAssets('assets')
        expect((await servePluginRequest('iter://plugins/assets/file.html')).status).toBe(404)
    })
})
