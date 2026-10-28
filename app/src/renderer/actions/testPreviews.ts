import { store, updateFile, type FileState } from '../state/app'
import { testById } from '../state/testCases'

interface PreviewRequest {
    row: FileState['tests'][number]
    promise: Promise<void>
}
const requests = new WeakMap<FileState['model'], Map<string, PreviewRequest>>()

/** Preview requests belong to one model and one immutable metadata row. */
export function loadTestPreview(path: string, id: string): Promise<void> {
    const owner = store.get().files.find((file) => file.path === path)
    const test = owner && testById(owner.tests, id)
    if (!owner || !test || test.previewLoaded !== false) return Promise.resolve()
    let pending = requests.get(owner.model)
    if (!pending) {
        pending = new Map()
        requests.set(owner.model, pending)
    }
    const existing = pending.get(id)
    if (existing?.row === test) return existing.promise
    const jobs = pending
    const request = { row: test } as PreviewRequest
    const job = window.iter.problem
        .readTest(path, id)
        .then((preview) => {
            const current = store.get().files.find((file) => file.model === owner.model)
            if (!current || current.path !== path || testById(current.tests, id) !== test) return
            updateFile(path, {
                tests: current.tests.map((row) => (row === test ? { ...preview, previewLoaded: true } : row))
            })
        })
        .finally(() => {
            if (jobs.get(id) === request) jobs.delete(id)
        })
    request.promise = job
    jobs.set(id, request)
    return job
}
