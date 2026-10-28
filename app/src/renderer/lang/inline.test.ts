import { describe, expect, it } from 'vitest'
import { cleanInline } from './inline'

describe('cleanInline', () => {
    it('drops trailing whitespace and empty answers', () => {
        expect(cleanInline('return 0;\n\n', '\n}')).toBe('return 0;')
        expect(cleanInline('  \n', '')).toBe('')
    })
    it('removes what already follows the cursor on the line', () => {
        expect(cleanInline('n);', ');')).toBe('n')
        expect(cleanInline('a + b', '\n}')).toBe('a + b')
    })
})
