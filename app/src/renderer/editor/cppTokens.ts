import type * as Monaco from 'monaco-editor/editor/editor.api'

// A C++ Monarch grammar tuned for contest code: it separates control keywords, primitive types,
// common STL types, function calls and ALL_CAPS constants so the code reads at a glance.
// (clangd semantic tokens could refine this later; the grammar must stay fast and dependency-free.)

const keywords = [
    'alignas',
    'alignof',
    'asm',
    'case',
    'catch',
    'class',
    'concept',
    'const',
    'consteval',
    'constexpr',
    'constinit',
    'const_cast',
    'co_await',
    'co_return',
    'co_yield',
    'decltype',
    'default',
    'delete',
    'do',
    'dynamic_cast',
    'enum',
    'explicit',
    'export',
    'extern',
    'false',
    'final',
    'friend',
    'inline',
    'mutable',
    'namespace',
    'new',
    'noexcept',
    'nullptr',
    'operator',
    'override',
    'private',
    'protected',
    'public',
    'register',
    'reinterpret_cast',
    'requires',
    'sizeof',
    'static',
    'static_assert',
    'static_cast',
    'struct',
    'template',
    'this',
    'thread_local',
    'throw',
    'true',
    'try',
    'typedef',
    'typeid',
    'typename',
    'union',
    'using',
    'virtual',
    'volatile'
]
const control = ['if', 'else', 'for', 'while', 'do', 'switch', 'break', 'continue', 'return', 'goto']
const primitives = [
    'int',
    'long',
    'short',
    'char',
    'bool',
    'float',
    'double',
    'void',
    'auto',
    'signed',
    'unsigned',
    'size_t',
    'wchar_t',
    'char8_t',
    'char16_t',
    'char32_t',
    'int8_t',
    'int16_t',
    'int32_t',
    'int64_t',
    'uint8_t',
    'uint16_t',
    'uint32_t',
    'uint64_t',
    '__int128',
    'll',
    'ull',
    'ld',
    'i64',
    'u64',
    'lll'
]
const stl = [
    'vector',
    'array',
    'string',
    'deque',
    'list',
    'forward_list',
    'map',
    'multimap',
    'set',
    'multiset',
    'unordered_map',
    'unordered_set',
    'unordered_multimap',
    'unordered_multiset',
    'queue',
    'priority_queue',
    'stack',
    'pair',
    'tuple',
    'bitset',
    'complex',
    'function',
    'optional',
    'variant',
    'string_view',
    'greater',
    'less',
    'mt19937',
    'mt19937_64',
    'istream',
    'ostream',
    'stringstream',
    'istringstream',
    'ostringstream',
    'pii',
    'pll',
    'vi',
    'vll',
    'vvi',
    'vpii',
    'std'
]

/** A control statement whose body has not started yet: header ends at `)` (or is a bare `else` / `do`). */
export const BRACELESS_BODY =
    /^\s*(?:(?:\}\s*)?else\s+)?(?:(?:if|for|while|switch)\s*\(.*\)|(?:\}\s*)?else|do)\s*(?:\/\/.*)?$/

export function registerCppTokens(monaco: typeof Monaco): void {
    monaco.languages.setMonarchTokensProvider('cpp', {
        defaultToken: '',
        keywords,
        control,
        primitives,
        stl,
        operators: /[=><!~?:&|+\-*/^%]+/,
        escapes: /\\(?:[abfnrtv\\"'?]|x[0-9A-Fa-f]+|[0-7]{1,3}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,
        tokenizer: {
            root: [
                [/^\s*#\s*include/, { token: 'preprocessor', next: '@include' }],
                [/^\s*#\s*\w+/, 'preprocessor'],
                { include: '@whitespace' },
                [/R"([^(\s\\]{0,16})\(/, { token: 'string', next: '@raw.$1' }],
                // identifiers: classify keyword / type / function / constant
                [
                    /[A-Za-z_]\w*(?=\s*\()/,
                    {
                        cases: {
                            '@control': 'keyword.control',
                            '@keywords': 'keyword',
                            '@primitives': 'type.primitive',
                            '@stl': 'type.stl',
                            '@default': 'function'
                        }
                    }
                ],
                [
                    /[A-Za-z_]\w*/,
                    {
                        cases: {
                            '@control': 'keyword.control',
                            '@keywords': 'keyword',
                            '@primitives': 'type.primitive',
                            '@stl': 'type.stl',
                            '~[A-Z][A-Z0-9_]+': 'constant',
                            '@default': 'identifier'
                        }
                    }
                ],
                [/[{}()[\]]/, '@brackets'],
                [/@operators/, 'operator'],
                [/[;,.]/, 'delimiter'],
                // numbers (with digit separators and suffixes)
                [/\d*\.\d+([eE][-+]?\d+)?[fFlL]?/, 'number'],
                [/\d+[eE][-+]?\d+[fFlL]?/, 'number'],
                [/0[xX][0-9a-fA-F']+[uUlL]*/, 'number'],
                [/0[bB][01']+[uUlL]*/, 'number'],
                [/\d[\d']*[uUlL]*/, 'number'],
                [/"/, { token: 'string', next: '@string' }],
                [/'(?:@escapes|[^\\'])'/, 'string'],
                [/'/, 'string']
            ],
            whitespace: [
                [/[ \t\r\n]+/, ''],
                [/\/\*/, 'comment', '@comment'],
                [/\/\/.*\\$/, 'comment', '@lineComment'],
                [/\/\/.*$/, 'comment']
            ],
            comment: [
                [/[^/*]+/, 'comment'],
                [/\*\//, 'comment', '@pop'],
                [/[/*]/, 'comment']
            ],
            lineComment: [
                [/.*[^\\]$/, 'comment', '@pop'],
                [/.*\\$/, 'comment']
            ],
            string: [
                [/[^\\"]+/, 'string'],
                [/@escapes/, 'string.escape'],
                [/\\./, 'string.escape'],
                [/"/, 'string', '@pop']
            ],
            raw: [
                [
                    /\)([^(\s\\]{0,16})"/,
                    { cases: { '$1==$S2': { token: 'string', next: '@pop' }, '@default': 'string' } }
                ],
                [/./, 'string']
            ],
            include: [
                [/\s+/, ''],
                [/<[^>]*>|"[^"]*"/, { token: 'string.include', next: '@pop' }],
                [/$/, '', '@pop']
            ]
        }
    } as Monaco.languages.IMonarchLanguage)

    monaco.languages.setLanguageConfiguration('cpp', {
        comments: { lineComment: '//', blockComment: ['/*', '*/'] },
        brackets: [
            ['{', '}'],
            ['[', ']'],
            ['(', ')']
        ],
        autoClosingPairs: [
            { open: '{', close: '}', notIn: ['string', 'comment'] },
            { open: '[', close: ']', notIn: ['string', 'comment'] },
            { open: '(', close: ')', notIn: ['string', 'comment'] },
            { open: "'", close: "'", notIn: ['string', 'comment'] },
            { open: '"', close: '"', notIn: ['string', 'comment'] },
            { open: '/*', close: ' */', notIn: ['string', 'comment'] }
        ],
        surroundingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '<', close: '>' },
            { open: '"', close: '"' },
            { open: "'", close: "'" }
        ],
        autoCloseBefore: ';:.,=}])> \n\t',
        indentationRules: {
            increaseIndentPattern: /^((?!\/\/).)*(\{[^}"'`]*|\([^)"'`]*|\[[^\]"'`]*)$/,
            decreaseIndentPattern: /^((?!.*?\/\*).*\*\/)?\s*[}\])].*$/,
            // a braceless `for (...)` / `if (...)` / `else` / `do` indents only the statement under it
            indentNextLinePattern: BRACELESS_BODY
        },
        onEnterRules: [
            {
                // `case x:` / `public:` keep indentation sane
                beforeText: /^\s*(case\s.*|default|public|private|protected)\s*:\s*$/,
                action: { indentAction: 1 /* Indent */ }
            }
        ],
        folding: { markers: { start: /^\s*#pragma\s+region\b/, end: /^\s*#pragma\s+endregion\b/ } },
        wordPattern: /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g
    })
}
