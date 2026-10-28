import { APP_NAME } from '../../shared/brand'
import { createHash } from 'node:crypto'

export function blobSha(content: Uint8Array): string {
    return createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex')
}

export class GitHubError extends Error {
    constructor(
        message: string,
        readonly status = 0
    ) {
        super(message)
    }
}

export interface RemoteFile {
    sha: string
    size: number
}
export interface RemoteTree {
    head?: string
    tree?: string
    branch: string
    files: Map<string, RemoteFile>
}
export interface TreeChange {
    path: string
    mode: '100644'
    type: 'blob'
    sha: string | null
}

/** Endpoints are injectable; tests never contact GitHub. No response/error body can expose a token. */
export class GitHubClient {
    constructor(
        private readonly token: string,
        private readonly apiBase = 'https://api.github.com',
        private readonly authBase = 'https://github.com',
        private readonly signal?: AbortSignal
    ) {}

    async request<T>(route: string, method = 'GET', body?: unknown, auth = true): Promise<T> {
        let response: Response
        try {
            response = await fetch(`${auth ? this.apiBase : this.authBase}${route}`, {
                method,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    ...(auth ? { Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28' } : {})
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: this.signal
                    ? AbortSignal.any([this.signal, AbortSignal.timeout(30_000)])
                    : AbortSignal.timeout(30_000),
                redirect: 'error'
            })
        } catch {
            if (this.signal?.aborted) throw new GitHubError('同步已取消。')
            throw new GitHubError('无法连接 GitHub，请检查网络后重试。')
        }
        if (!response.ok) {
            if (
                response.status === 429 ||
                (response.status === 403 &&
                    (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))
            ) {
                const retry = Number(response.headers.get('retry-after'))
                const reset = Number(response.headers.get('x-ratelimit-reset'))
                const when = retry > 0 ? `${retry} 秒后` : reset > 0 ? new Date(reset * 1000).toISOString() : '稍后'
                throw new GitHubError(`GitHub 请求频率受限，请${when}重试。`, response.status)
            }
            const hint =
                response.status === 401
                    ? '，请重新登录'
                    : response.status === 403
                      ? '，请检查令牌的仓库 Contents 读写权限'
                      : ''
            throw new GitHubError(`GitHub 请求失败（HTTP ${response.status}）${hint}。`, response.status)
        }
        try {
            return (await response.json()) as T
        } catch {
            throw new GitHubError('GitHub 返回了无效的数据。')
        }
    }

    async readTree(repo: string, login: string): Promise<RemoteTree> {
        const route = repoRoute(repo)
        let info: { default_branch: string; size: number; private: boolean }
        try {
            info = await this.request(route)
        } catch (error) {
            if (!(error instanceof GitHubError) || error.status !== 404) throw error
            const [owner, name] = repo.split('/')
            if (owner.toLowerCase() !== login.toLowerCase()) {
                throw new GitHubError('同步仓库不存在或无访问权限；只能自动创建当前用户自己的仓库。')
            }
            info = await this.request('/user/repos', 'POST', { name, private: true, auto_init: true })
        }
        // Keep personal configuration private even when a repository name was mistyped.
        if (!info.private) throw new GitHubError('请选择私有同步仓库。')
        const branch = info.default_branch || 'main'
        let head: string
        try {
            head = (await this.request<{ object: { sha: string } }>(`${route}/git/ref/heads/${encodeBranch(branch)}`))
                .object.sha
        } catch (error) {
            if (error instanceof GitHubError && [404, 409].includes(error.status) && info.size === 0) {
                return { branch, files: new Map() }
            }
            throw error
        }
        const commit = await this.request<{ tree: { sha: string } }>(`${route}/git/commits/${head}`)
        const tree = await this.request<{
            truncated: boolean
            tree: { path: string; type: string; mode: string; sha: string; size?: number }[]
        }>(`${route}/git/trees/${commit.tree.sha}?recursive=1`)
        if (tree.truncated) throw new GitHubError('同步仓库文件树过大，GitHub 返回了截断结果；本次未修改文件。')
        const files = new Map<string, RemoteFile>()
        for (const file of tree.tree) {
            if (file.type !== 'tree') {
                // Keep unsupported entries visible to the engine so they cannot be mistaken for deletions.
                files.set(file.path, {
                    sha: file.sha,
                    size: ['100644', '100755'].includes(file.mode) && file.type === 'blob' ? (file.size ?? 0) : Infinity
                })
            }
        }
        return { head, tree: commit.tree.sha, branch, files }
    }

    async download(repo: string, file: RemoteFile, maxBytes: number): Promise<Buffer> {
        const data = await this.request<{ encoding: string; content: string; size: number }>(
            `${repoRoute(repo)}/git/blobs/${file.sha}`
        )
        if (
            data.encoding !== 'base64' ||
            data.size > maxBytes ||
            data.content.length > Math.ceil(maxBytes / 3) * 4 * 1.1 + 1024
        ) {
            throw new GitHubError('远端文件过大或编码不受支持。')
        }
        const content = Buffer.from(data.content, 'base64')
        if (content.length > maxBytes || blobSha(content) !== file.sha) throw new GitHubError('远端文件内容校验失败。')
        return content
    }

    async upload(repo: string, content: Buffer): Promise<string> {
        const result = await this.request<{ sha: string }>(`${repoRoute(repo)}/git/blobs`, 'POST', {
            content: content.toString('base64'),
            encoding: 'base64'
        })
        if (result.sha !== blobSha(content)) throw new GitHubError('上传文件内容校验失败。')
        return result.sha
    }

    async commit(repo: string, remote: RemoteTree, changes: TreeChange[]): Promise<string | undefined> {
        if (!changes.length) return remote.head
        const route = repoRoute(repo)
        const tree = await this.request<{ sha: string }>(`${route}/git/trees`, 'POST', {
            base_tree: remote.tree,
            tree: changes
        })
        const commit = await this.request<{ sha: string }>(`${route}/git/commits`, 'POST', {
            message: `${APP_NAME} sync`,
            tree: tree.sha,
            parents: remote.head ? [remote.head] : []
        })
        // force:false rejects concurrent remote changes instead of overwriting another device's commit.
        if (remote.head) {
            await this.request(`${route}/git/refs/heads/${encodeBranch(remote.branch)}`, 'PATCH', {
                sha: commit.sha,
                force: false
            })
        } else {
            await this.request(`${route}/git/refs`, 'POST', { ref: `refs/heads/${remote.branch}`, sha: commit.sha })
        }
        return commit.sha
    }
}

export function repoRoute(repo: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repo) || repo.endsWith('/.') || repo.endsWith('/..')) {
        throw new GitHubError('同步仓库必须为 owner/name 格式。')
    }
    return `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`
}

function encodeBranch(branch: string): string {
    return branch.split('/').map(encodeURIComponent).join('/')
}

/** Wait for all started workers on failure, so no writes outlive a failed/cancelled cycle. */
export async function parallel<T, R>(items: T[], work: (item: T) => Promise<R>, limit = 4): Promise<R[]> {
    let next = 0
    let failed = false
    let failure: unknown
    const results: R[] = new Array(items.length)
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (!failed && next < items.length) {
                const index = next++
                try {
                    results[index] = await work(items[index])
                } catch (error) {
                    failed = true
                    failure = error
                }
            }
        })
    )
    if (failed) throw failure
    return results
}
