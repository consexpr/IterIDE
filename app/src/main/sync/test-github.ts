// Test-only in-memory Git Data API. Every request is intercepted; no socket is opened.
import { createHash } from 'node:crypto'
import { blobSha } from './github'

type Files = Map<string, { sha: string; size: number }>
interface Commit {
    tree: string
    parents: string[]
}
export interface RequestRecord {
    route: string
    method: string
    body: Record<string, any>
    at: number
}
export const FAKE_TOKEN = 'unit-test-token'

export class FakeGitHub {
    readonly apiBaseUrl = 'https://github.invalid/api'
    readonly authBaseUrl = 'https://github.invalid'
    readonly requests: RequestRecord[] = []
    readonly blobs = new Map<string, Buffer>()
    readonly trees = new Map<string, Files>()
    readonly commits = new Map<string, Commit>()
    readonly polls: number[] = []
    repo = 'tester/iter-sync'
    exists = true
    privateRepo = true
    branch = 'main'
    head = ''
    offline = false
    truncated = false
    deviceExpires = 60
    deviceInterval = 1
    deviceReplies: Record<string, string>[] = [{ access_token: FAKE_TOKEN }]
    intercept?: (request: RequestRecord) => Response | undefined | Promise<Response | undefined>
    maxConcurrent = 0
    private active = 0
    private sequence = 0

    constructor() {
        this.edit({})
    }

    get files(): Files {
        return this.trees.get(this.commits.get(this.head)!.tree)!
    }
    text(name: string): string | undefined {
        const sha = this.files.get(name)?.sha
        return sha ? this.blobs.get(sha)?.toString('utf8') : undefined
    }

    edit(changes: Record<string, string | Buffer | null>): void {
        const files = this.head ? new Map(this.files) : new Map()
        for (const [name, content] of Object.entries(changes)) {
            if (content === null) {
                files.delete(name)
                continue
            }
            const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content)
            const sha = blobSha(buffer)
            this.blobs.set(sha, buffer)
            files.set(name, { sha, size: buffer.length })
        }
        const tree = this.id('tree')
        this.trees.set(tree, files)
        const head = this.id('commit')
        this.commits.set(head, { tree, parents: this.head ? [this.head] : [] })
        this.head = head
    }

    readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        if (url.origin !== 'https://github.invalid') throw new Error('Real network calls are forbidden in sync tests')
        if (init?.signal?.aborted) throw new Error('aborted')
        const api = url.pathname.startsWith('/api/')
        const route = (api ? url.pathname.slice(4) : url.pathname) + url.search
        const request: RequestRecord = {
            route,
            method: init?.method ?? 'GET',
            body: init?.body ? JSON.parse(String(init.body)) : {},
            at: Date.now()
        }
        this.requests.push(request)
        this.active++
        this.maxConcurrent = Math.max(this.maxConcurrent, this.active)
        try {
            await Promise.resolve()
            if (this.offline) throw new Error('offline')
            const overridden = await this.intercept?.(request)
            if (overridden) return overridden
            if (api && new Headers(init?.headers).get('Authorization') !== `Bearer ${FAKE_TOKEN}`) return json({}, 401)
            if (route === '/user')
                return json({ login: 'tester', name: 'Test User', avatar_url: 'https://avatars.invalid/tester' })
            if (route === '/login/device/code') {
                if (request.body.scope !== 'repo') return json({}, 400)
                return json({
                    device_code: 'device-test',
                    user_code: 'TEST-CODE',
                    verification_uri: 'https://github.com/login/device',
                    expires_in: this.deviceExpires,
                    interval: this.deviceInterval
                })
            }
            if (route === '/login/oauth/access_token') {
                this.polls.push(Date.now())
                return json(this.deviceReplies.shift() ?? { error: 'authorization_pending' })
            }
            if (route === '/user/repos' && request.method === 'POST') {
                this.exists = true
                this.privateRepo = request.body.private === true
                return json(this.info(), 201)
            }
            const base = `/repos/${this.repo}`
            if (route === base) return this.exists ? json(this.info()) : json({}, 404)
            if (!this.exists) return json({}, 404)
            if (route === `${base}/git/ref/heads/${this.branch}`) return json({ object: { sha: this.head } })
            if (route.startsWith(`${base}/git/commits/`)) {
                const sha = route.slice(`${base}/git/commits/`.length)
                const commit = this.commits.get(sha)
                return commit ? json({ sha, tree: { sha: commit.tree } }) : json({}, 404)
            }
            if (route.startsWith(`${base}/git/trees/`)) {
                const sha = route.slice(`${base}/git/trees/`.length).split('?')[0]
                const files = this.trees.get(sha)
                return files
                    ? json({
                          truncated: this.truncated,
                          tree: [...files].map(([name, file]) => ({
                              path: name,
                              type: 'blob',
                              mode: '100644',
                              ...file
                          }))
                      })
                    : json({}, 404)
            }
            if (route.startsWith(`${base}/git/blobs/`)) {
                const content = this.blobs.get(route.slice(`${base}/git/blobs/`.length))
                return content
                    ? json({ encoding: 'base64', content: content.toString('base64'), size: content.length })
                    : json({}, 404)
            }
            if (route === `${base}/git/blobs` && request.method === 'POST') {
                const content = Buffer.from(request.body.content, 'base64')
                const sha = blobSha(content)
                this.blobs.set(sha, content)
                return json({ sha }, 201)
            }
            if (route === `${base}/git/trees` && request.method === 'POST') {
                const files = new Map(this.trees.get(request.body.base_tree))
                for (const item of request.body.tree) {
                    if (item.sha === null) files.delete(item.path)
                    else {
                        const content = this.blobs.get(item.sha)
                        if (!content) return json({}, 422)
                        files.set(item.path, { sha: item.sha, size: content.length })
                    }
                }
                const sha = this.id('tree')
                this.trees.set(sha, files)
                return json({ sha }, 201)
            }
            if (route === `${base}/git/commits` && request.method === 'POST') {
                const sha = this.id('commit')
                this.commits.set(sha, { tree: request.body.tree, parents: request.body.parents })
                return json({ sha }, 201)
            }
            if (route === `${base}/git/refs/heads/${this.branch}` && request.method === 'PATCH') {
                const commit = this.commits.get(request.body.sha)
                if (!commit?.parents.includes(this.head) || request.body.force !== false) return json({}, 422)
                this.head = request.body.sha
                return json({ object: { sha: this.head } })
            }
            if (route === `${base}/git/refs` && request.method === 'POST') {
                this.head = request.body.sha
                return json({ object: { sha: this.head } }, 201)
            }
            return json({ message: `Unexpected fake API route: ${request.method} ${route}` }, 404)
        } finally {
            this.active--
        }
    }

    private info(): Record<string, unknown> {
        return { default_branch: this.branch, size: 1, private: this.privateRepo }
    }
    private id(kind: string): string {
        return createHash('sha1').update(`${kind}-${++this.sequence}`).digest('hex')
    }
}

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}
