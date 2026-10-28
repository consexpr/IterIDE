import { expect, it } from 'vitest'
import { parseDepfile } from './depfile'
it('reads wrapped GCC dependencies with spaces, hashes, dollars and Windows paths', () => {
    expect(
        parseDepfile('C:/cache/unit.o: C:/src/main.cpp C:/my\\ folder/a\\#b.h \\\n C:/src/price$$.h C:\\sdk\\file.h\n')
    ).toEqual(['C:/src/main.cpp', 'C:/my folder/a#b.h', 'C:/src/price$.h', 'C:\\sdk\\file.h'])
})
