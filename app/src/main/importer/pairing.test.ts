import { describe, expect, it } from 'vitest'
import { pairingFixtures } from './fixtures/pairing'
import { pairFiles } from './pairing'

describe('pairFiles fixtures', () => {
    for (const fixture of pairingFixtures) {
        it(fixture.title, () => {
            const result = pairFiles(fixture.files)
            expect(result.pairs).toEqual(fixture.pairs)
            expect(result.unmatched).toEqual(fixture.unmatched ?? [])
            if (fixture.note) expect(result.notes.join('\n')).toMatch(fixture.note)
            expect(pairFiles([...fixture.files].reverse())).toEqual(result)
        })
    }

    it.each([
        ['checker.cpp', 'checker'],
        ['chk.cpp', 'checker'],
        ['spj.cpp', 'checker'],
        ['check.cpp', 'checker'],
        ['CHECKER.EXE', 'checker'],
        ['chk.exe', 'checker'],
        ['interactor.cpp', 'interactor'],
        ['interact_custom.cpp', 'interactor'],
        ['interactor.exe', 'interactor'],
        ['testlib.h', 'testlib'],
        ['val.cpp', 'validator'],
        ['validator.cpp', 'validator'],
        ['gen.cpp', 'generator'],
        ['generate.cpp', 'generator'],
        ['std.cpp', 'solution'],
        ['sol.cpp', 'solution'],
        ['solution.cpp', 'solution']
    ])('detects %s as %s', (file, role) => {
        expect(pairFiles([`tools/${file}`])).toEqual({
            pairs: [],
            unmatched: [],
            extras: [{ path: `tools/${file}`, role }],
            notes: []
        })
    })

    it('explains deterministic extra selection and interactive precedence', () => {
        const result = pairFiles(['chk.cpp', 'checker.cpp', 'interact.cpp', 'interactor.cpp'])
        expect(result.notes).toEqual(
            expect.arrayContaining([
                '多个检查器，附加时采用 checker.cpp',
                '多个交互器，附加时采用 interact.cpp',
                '同时附加检查器和交互器时，采用交互模式'
            ])
        )
    })

    it('deduplicates normalized paths and ignores code/doc files', () => {
        expect(pairFiles(['./1.in', '1.in', '1.out', 'main.cpp', 'README.md', 'winter.txt']).pairs).toEqual([
            { name: '1', input: '1.in', answer: '1.out' }
        ])
        expect(pairFiles([])).toEqual({ pairs: [], unmatched: [], extras: [], notes: [] })
    })
})
