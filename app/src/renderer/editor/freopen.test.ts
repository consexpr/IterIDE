import { describe, expect, it } from 'vitest'
import { detectFreopen, insertFreopen } from './freopen'

describe('detectFreopen', () => {
    it('detects active global and std calls with comments, whitespace and Chinese filenames', () => {
        expect(
            detectFreopen(`int main() {
      std :: freopen /* keep */ ( "输入数据.in", "rb+", stdin );
      ::freopen("输出结果.out", "a+b", stdout);
    }`)
        ).toEqual({ input: '输入数据.in', output: '输出结果.out' })
    })

    it.each(['r', 'rb', 'r+', 'rb+', 'r+b', 'rt', 'rt+', 'r+t'])('recognizes input mode %s', (mode) => {
        expect(detectFreopen(`freopen("data.in", "${mode}", stdin);`)).toEqual({ input: 'data.in' })
    })

    it.each(['w', 'wb', 'w+', 'wb+', 'w+b', 'a', 'ab', 'a+', 'ab+', 'a+b'])('recognizes output mode %s', (mode) => {
        expect(detectFreopen(`freopen("data.out", "${mode}", stdout);`)).toEqual({ output: 'data.out' })
    })

    it('ignores line/block comments and strings/characters containing fake calls', () => {
        expect(
            detectFreopen(String.raw`
      // freopen("line.in", "r", stdin);
      /* freopen("block.out", "w", stdout); */
      const char* a = "freopen(\"string.in\", \"r\", stdin)";
      const char* b = R"tag(freopen("raw.out", "w", stdout))tag";
      auto c = '\'';
      auto d = '"';
      auto e = u8R"(freopen("utf8.in", "r", stdin))";
      auto f = LR"(freopen("wide.in", "r", stdin))";
    `)
        ).toEqual({})
    })

    it('preserves comment-like text inside filenames and skips comments inside a real call', () => {
        expect(
            detectFreopen(`
      const char* sample = "https://example.test/*keep*/";
      freopen("folder//data.in", /* mode */ "r", stdin);
      freopen("folder/*literal*/data.out", "w", stdout);
    `)
        ).toEqual({ input: 'folder//data.in', output: 'folder/*literal*/data.out' })
    })

    it('rejects identifier suffixes, members, other namespaces and nonliteral arguments', () => {
        expect(
            detectFreopen(`
      my_freopen("one.in", "r", stdin);
      自定义freopen("unicode.in", "r", stdin);
      freopen_s("two.in", "r", stdin);
      object.freopen("three.in", "r", stdin);
      object->freopen("four.in", "r", stdin);
      other::freopen("five.in", "r", stdin);
      other::std::freopen("six.in", "r", stdin);
      freopen(filename, "r", stdin);
      freopen("seven.in", mode, stdin);
      freopen("eight.in", "not-a-mode", stdin);
      freopen("nine.in", "r", stderr);
      freopen("ten.in", "r", "stdin");
    `)
        ).toEqual({})
    })

    it('decodes escaped filenames and adjacent literals without interpreting their contents as code', () => {
        expect(
            detectFreopen(String.raw`
      freopen("目录\\数据\u8f93\u5165" ".in", "r" "b", stdin);
      freopen(R"path(输出\原样.out)path", "w", stdout);
    `)
        ).toEqual({ input: '目录\\数据输入.in', output: '输出\\原样.out' })
    })

    it('retains the first active filename for each standard stream', () => {
        expect(
            detectFreopen(`
      freopen("first.in", "r", stdin); freopen("later.in", "r", stdin);
      freopen("first.out", "w", stdout); freopen("later.out", "a", stdout);
    `)
        ).toEqual({ input: 'first.in', output: 'first.out' })
    })

    it('disables calls when removed or commented out, including continued line comments', () => {
        const code = 'freopen("input.in", "r", stdin);\nfreopen("output.out", "w", stdout);'
        expect(detectFreopen(code)).toEqual({ input: 'input.in', output: 'output.out' })
        expect(
            detectFreopen(
                code
                    .split('\n')
                    .map((line) => `// ${line}`)
                    .join('\n')
            )
        ).toEqual({})
        expect(detectFreopen(`/* ${code} */`)).toEqual({})
        expect(detectFreopen('')).toEqual({})
        expect(detectFreopen('// disabled \\\nfreopen("input.in", "r", stdin);')).toEqual({})
    })

    it('skips explicit inactive preprocessor branches, including nested conditions and elif', () => {
        expect(
            detectFreopen(`
      #if 0
        freopen("disabled.in", "r", stdin);
        #if 1
          freopen("nested.out", "w", stdout);
        #endif
      #elif (1)
        freopen("active.in", "rb", stdin);
      #else
        freopen("unreachable.out", "w", stdout);
      #endif
      #if 1
        freopen("active.out", "a", stdout);
      #else
        freopen("disabled.out", "w", stdout);
      #endif
    `)
        ).toEqual({ input: 'active.in', output: 'active.out' })
    })

    it('does not invent macro evaluation, and ignores call text inside macro definitions', () => {
        expect(
            detectFreopen(`
      #define REDIRECT freopen("macro.in", "r", stdin)
      #include "freopen(\"header.out\", \"w\", stdout)"
      #ifdef UNKNOWN_MACRO
        freopen("possible.in", "r", stdin);
      #else
        freopen("possible.out", "w", stdout);
      #endif
    `)
        ).toEqual({ input: 'possible.in', output: 'possible.out' })
    })

    it('keeps directive-looking text inside raw literals inert', () => {
        expect(
            detectFreopen(`const auto text = R"tag(
      #if 0
      freopen("fake.in", "r", stdin);
      #endif
    )tag";
    freopen("real.in", "r", stdin);`)
        ).toEqual({ input: 'real.in' })
    })
})

describe('insertFreopen compatibility', () => {
    it('retains insertion and main-not-found behavior', () => {
        const result = insertFreopen('int main() {\n  return 0;\n}\n', '数据.in', '数据.out')
        expect(result).toContain('  freopen("数据.in", "r", stdin);\n  freopen("数据.out", "w", stdout);\n')
        expect(detectFreopen(result!)).toEqual({ input: '数据.in', output: '数据.out' })
        expect(insertFreopen('void helper() {}', 'a.in', 'a.out')).toBeNull()
    })
})
