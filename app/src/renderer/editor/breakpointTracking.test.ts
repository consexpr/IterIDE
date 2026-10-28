import { describe, expect, it } from 'vitest'
import { whitespaceLineMap } from './breakpointTracking'

describe('formatting breakpoint line mapping', () => {
    it('follows the first source character through CRLF, indentation and split statements', () => {
        const before = 'int T;\r\nint main(){\r\ncin>>T;while(T--) solve();\r\n}\r\n'
        const after = 'int T;\n\nint main() {\n  cin >> T;\n  while (T--)\n    solve();\n}\n'
        expect(whitespaceLineMap(before, after, [1, 2, 3, 4])).toEqual(
            new Map([
                [1, 1],
                [2, 3],
                [3, 4],
                [4, 7]
            ])
        )
    })

    it('rejects content changes and leaves blank lines without a guessed target', () => {
        expect(whitespaceLineMap('cin>>T;\n', 'cin>>N;\n', [1])).toBeNull()
        expect(whitespaceLineMap('int x;\n', 'int x; int y;\n', [1])).toBeNull()
        expect(whitespaceLineMap('\nint x;', 'int x;\n', [1, 2])).toEqual(new Map([[2, 1]]))
    })
})
