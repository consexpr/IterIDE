/** File identity and operation ownership shared by open, save, close and runtime actions. */
export function fileKey(path: string): string {
    const portable = path.replaceAll('\\', '/')
    const prefix = portable.startsWith('//') ? '//' : portable.startsWith('/') ? '/' : ''
    const rootDepth = /^[a-z]:\//i.test(portable) ? 1 : prefix === '//' ? 2 : 0
    const parts: string[] = []
    for (const part of portable.split('/')) {
        if (!part || part === '.') continue
        if (part === '..') {
            if (parts.length > rootDepth) parts.pop()
        } else parts.push(part)
    }
    const key = prefix + parts.join('/')
    return window.iter.app?.platform === 'win32' ? key.toLowerCase() : key
}

export class FileOperations<Model extends object> {
    readonly opening = new Map<string, Promise<void>>()
    readonly closing = new Map<Model, Promise<unknown>>()
    readonly saving = new Map<Model, Promise<unknown>>()
    readonly migrating = new Set<Model>()
    readonly targets = new Map<string, Model>()
    private readonly successors = new WeakMap<Model, Model>()
    private readonly owners = new WeakMap<Model, Model>()

    /** A model URI can change; all queued operations keep the original tab owner. */
    owner(model: Model): Model {
        return this.owners.get(model) ?? model
    }

    pendingSave(model: Model): Promise<unknown> | undefined {
        return this.saving.get(this.owner(model))
    }

    isSaving(model: Model): boolean {
        return this.saving.has(this.owner(model))
    }

    current(model: Model): Model {
        let next: Model | undefined
        while ((next = this.successors.get(model))) model = next
        return model
    }

    replace(previous: Model, next: Model): void {
        this.successors.set(previous, next)
        this.owners.set(next, this.owner(previous))
    }

    serial<T>(model: Model, action: () => Promise<T>): Promise<T> {
        model = this.owner(model)
        const previous = this.saving.get(model) ?? Promise.resolve()
        const run = previous.catch(() => {}).then(action)
        this.saving.set(model, run)
        return run.finally(() => {
            if (this.saving.get(model) === run) this.saving.delete(model)
        })
    }
}
