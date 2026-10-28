import type { TestCaseData } from '../../shared/problem'

const indexes = new WeakMap<TestCaseData[], Map<string, TestCaseData>>()

/** All cards share one index per immutable test list instead of scanning it per subscription. */
export function testById(tests: TestCaseData[], id: string): TestCaseData | undefined {
    let index = indexes.get(tests)
    if (!index) {
        index = new Map(tests.map((test) => [test.id, test]))
        indexes.set(tests, index)
    }
    return index.get(id)
}
