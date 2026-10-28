import { activeFile, store } from '../state/app'

/** The last clicked test, then the first failure, then the first available test. */
export function selectedTest(): string | undefined {
    const file = activeFile()
    if (!file) return undefined
    const focused = file.tests.find((test) => store.get().focused === `${file.path}#${test.id}`)
    const failing = file.tests.find(
        (test) => file.results[test.id] && !['AC', 'PENDING', 'RUNNING', 'NA'].includes(file.results[test.id].verdict)
    )
    return (focused ?? failing ?? file.tests[0])?.id
}
