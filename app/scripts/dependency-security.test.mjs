import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'

it('keeps Electron downloads working through a local proxy after the security override', async () => {
    const require = createRequire(import.meta.url)
    const builder = createRequire(require.resolve('app-builder-lib/package.json'))
    const electronGet = builder.resolve('@electron/get')
    const requests = []
    const proxy = createServer((request, response) => {
        requests.push(request.url)
        response.end('proxy-ok')
    })
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    let child
    try {
        const script = `
      require(${JSON.stringify(electronGet)}).initializeProxy();
      if (!global.GLOBAL_AGENT) throw Error('Proxy bootstrap failed');
      const timer = setTimeout(() => process.exit(2), 5000);
      require('node:http').get('http://iter-proxy-check.invalid/asset', response => {
        let body = ''; response.on('data', chunk => body += chunk);
        response.on('end', () => { clearTimeout(timer); process.exit(body === 'proxy-ok' ? 0 : 3); });
      }).on('error', () => process.exit(4));
    `
        child = spawn(process.execPath, ['-e', script], {
            windowsHide: true,
            stdio: 'pipe',
            env: {
                ...process.env,
                GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
                GLOBAL_AGENT_NO_PROXY: '',
                ELECTRON_GET_USE_PROXY: '',
                HTTP_PROXY: '',
                HTTPS_PROXY: '',
                NO_PROXY: ''
            }
        })
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject)
            child.once('close', resolve)
        })
        expect(code).toBe(0)
        expect(requests).toEqual(['http://iter-proxy-check.invalid/asset'])
    } finally {
        child?.kill()
        proxy.closeAllConnections()
        await new Promise((resolve) => proxy.close(resolve))
    }
}, 10000)
