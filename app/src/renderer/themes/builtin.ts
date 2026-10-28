import { DEFAULT_SHAPE, type IterTheme } from './types'

// Design notes: low-saturation palettes, contrast tuned for long sessions (text ~11:1, comments ~3.5:1),
// one accent per theme, verdict colors kept recognisable across themes (green AC / red WA / amber TLE).

const dusk: IterTheme = {
    id: 'iter-dusk',
    name: 'Dusk 暮蓝',
    kind: 'dark',
    ui: {
        bg: '#141619',
        panel: '#181a1f',
        elevated: '#1e2127',
        sunken: '#121418',
        border: '#262a31',
        borderStrong: '#323741',
        text: '#c9ced6',
        textMuted: '#8b929d',
        textFaint: '#5c626c',
        accent: '#86a8e7',
        accentText: '#0f1420',
        hover: 'rgba(255,255,255,0.045)',
        selection: 'rgba(134,168,231,0.22)',
        shadow: '0 12px 40px rgba(0,0,0,0.45)'
    },
    verdict: {
        ac: '#8cc79a',
        wa: '#e58a8a',
        tle: '#e2b86b',
        mle: '#d79be0',
        re: '#c79ce6',
        ce: '#e0a07a',
        pending: '#7d8590'
    },
    editor: {
        background: '#16181c',
        foreground: '#c9ced6',
        lineHighlight: '#1c1f24',
        selection: '#2b3a55',
        cursor: '#a9c1f0',
        lineNumber: '#424852',
        lineNumberActive: '#8b929d',
        indentGuide: '#22262c',
        bracketMatch: '#3a4659',
        debugLine: '#3b3420'
    },
    highlight: {
        occurrence: '#c9ced62b',
        occurrenceWrite: '#c9ced62d',
        selectionMatch: '#c9ced62b',
        findCurrent: '#86a8e735',
        findOther: '#86a8e737',
        findRange: '#c9ced61a'
    },
    tokens: {
        comment: '#5f6673 italic',
        keyword: '#c19be3',
        'keyword.control': '#c19be3',
        'type.primitive': '#7fc1c9',
        type: '#7fc1c9',
        'type.stl': '#8fc7b0',
        function: '#86a8e7',
        constant: '#e3a77b',
        number: '#e3a77b',
        string: '#a9c58c',
        'string.escape': '#d7c38a',
        preprocessor: '#d68fae',
        'string.include': '#a9c58c',
        operator: '#97a0ab',
        delimiter: '#7f8792',
        identifier: '#c9ced6',
        // clangd semantic tokens: what a name is, not how it is spelled
        macro: '#e07a9c',
        'variable.local': '#c9ced6',
        'variable.param': '#e6cf9a italic',
        'variable.global': '#8ad7a4',
        'variable.field': '#d9b3a0',
        namespace: '#8fc7b0',
        label: '#e3a77b'
    },
    shape: DEFAULT_SHAPE
}

const ember: IterTheme = {
    id: 'iter-ember',
    name: 'Ember 余烬',
    kind: 'dark',
    ui: {
        bg: '#161412',
        panel: '#1a1715',
        elevated: '#211d1a',
        sunken: '#131110',
        border: '#2b2622',
        borderStrong: '#3a332d',
        text: '#d6ccc1',
        textMuted: '#998d81',
        textFaint: '#655b52',
        accent: '#e2a464',
        accentText: '#1d140b',
        hover: 'rgba(255,240,220,0.045)',
        selection: 'rgba(226,164,100,0.2)',
        shadow: '0 12px 40px rgba(0,0,0,0.5)'
    },
    verdict: {
        ac: '#9fc48a',
        wa: '#e8877a',
        tle: '#e6bb62',
        mle: '#d29ad1',
        re: '#c9a0e0',
        ce: '#e3a070',
        pending: '#857a70'
    },
    editor: {
        background: '#181513',
        foreground: '#d6ccc1',
        lineHighlight: '#1e1a17',
        selection: '#46321f',
        cursor: '#f0b878',
        lineNumber: '#4a423b',
        lineNumberActive: '#998d81',
        indentGuide: '#25211d',
        bracketMatch: '#4a3a2a',
        debugLine: '#3a3220'
    },
    highlight: {
        occurrence: '#d6ccc125',
        occurrenceWrite: '#d6ccc126',
        selectionMatch: '#d6ccc125',
        findCurrent: '#e2a4642d',
        findOther: '#e2a4642f',
        findRange: '#d6ccc11a'
    },
    tokens: {
        comment: '#71675d italic',
        keyword: '#e3906d',
        'type.primitive': '#d8b86c',
        type: '#d8b86c',
        'type.stl': '#cdb27f',
        function: '#e6c08a',
        constant: '#c99ad4',
        number: '#c99ad4',
        string: '#a9bb7c',
        'string.escape': '#e0c58a',
        preprocessor: '#d58a8a',
        'string.include': '#a9bb7c',
        operator: '#a99a8c',
        delimiter: '#8b7f73',
        identifier: '#d6ccc1',
        // clangd semantic tokens: what a name is, not how it is spelled
        macro: '#e07a7a',
        'variable.local': '#d6ccc1',
        'variable.param': '#b8cfa0 italic',
        'variable.global': '#8fc9c0',
        'variable.field': '#a8b8d8',
        namespace: '#a89c8c',
        label: '#c99ad4'
    },
    shape: DEFAULT_SHAPE
}

const forest: IterTheme = {
    id: 'iter-forest',
    name: 'Forest 松间',
    kind: 'dark',
    ui: {
        bg: '#131715',
        panel: '#171b19',
        elevated: '#1d221f',
        sunken: '#111412',
        border: '#252b27',
        borderStrong: '#313933',
        text: '#c8d1c9',
        textMuted: '#88948b',
        textFaint: '#58625b',
        accent: '#82c09c',
        accentText: '#0d1a12',
        hover: 'rgba(230,255,240,0.04)',
        selection: 'rgba(130,192,156,0.2)',
        shadow: '0 12px 40px rgba(0,0,0,0.45)'
    },
    verdict: {
        ac: '#86c99a',
        wa: '#e38b86',
        tle: '#e1bb6d',
        mle: '#cf9edc',
        re: '#c3a0e3',
        ce: '#e0a27d',
        pending: '#7a857d'
    },
    editor: {
        background: '#151917',
        foreground: '#c8d1c9',
        lineHighlight: '#1a1f1c',
        selection: '#27402f',
        cursor: '#9ed6b4',
        lineNumber: '#3f4842',
        lineNumberActive: '#88948b',
        indentGuide: '#202622',
        bracketMatch: '#2f4a39',
        debugLine: '#363320'
    },
    highlight: {
        occurrence: '#c8d1c92b',
        occurrenceWrite: '#c8d1c926',
        selectionMatch: '#c8d1c92b',
        findCurrent: '#82c09c2d',
        findOther: '#82c09c2f',
        findRange: '#c8d1c91a'
    },
    tokens: {
        comment: '#5f6c63 italic',
        keyword: '#92b9df',
        'type.primitive': '#dfc27d',
        type: '#dfc27d',
        'type.stl': '#d1c18e',
        function: '#9fd1b3',
        constant: '#e4a283',
        number: '#e4a283',
        string: '#b6cf8c',
        'string.escape': '#dcc98f',
        preprocessor: '#cf96b6',
        'string.include': '#b6cf8c',
        operator: '#97a39a',
        delimiter: '#7d887f',
        identifier: '#c8d1c9',
        // clangd semantic tokens: what a name is, not how it is spelled
        macro: '#e07aa0',
        'variable.local': '#c8d1c9',
        'variable.param': '#e0d29a italic',
        'variable.global': '#d49ae0',
        'variable.field': '#b5c97a',
        namespace: '#a0b8a8',
        label: '#e4a283'
    },
    shape: DEFAULT_SHAPE
}

const paper: IterTheme = {
    id: 'iter-paper',
    name: 'Paper 宣纸',
    kind: 'light',
    ui: {
        bg: '#ece6dc',
        panel: '#f1ece3',
        elevated: '#faf7f1',
        sunken: '#e8e1d5',
        border: '#ddd4c6',
        borderStrong: '#cdc2b1',
        text: '#3a3530',
        textMuted: '#776e64',
        textFaint: '#a59b8f',
        accent: '#b0662a',
        accentText: '#fffaf3',
        hover: 'rgba(60,40,20,0.05)',
        selection: 'rgba(176,102,42,0.16)',
        shadow: '0 12px 36px rgba(80,60,30,0.16)'
    },
    verdict: {
        ac: '#3f8a52',
        wa: '#c0463d',
        tle: '#b07b14',
        mle: '#9a4fa8',
        re: '#7f52b5',
        ce: '#b45f2a',
        pending: '#8d8478'
    },
    editor: {
        background: '#f8f4ed',
        foreground: '#3a3530',
        lineHighlight: '#f1ebe1',
        selection: '#dcc7b0',
        cursor: '#b0662a',
        lineNumber: '#c4b9aa',
        lineNumberActive: '#776e64',
        indentGuide: '#ebe4d8',
        bracketMatch: '#e5d3bd',
        debugLine: '#f6e7b5'
    },
    highlight: {
        occurrence: '#3a353033',
        occurrenceWrite: '#3a35302d',
        selectionMatch: '#3a353033',
        findCurrent: '#b0662a49',
        findOther: '#b0662a41',
        findRange: '#3a35301e'
    },
    tokens: {
        comment: '#92897e italic',
        keyword: '#8a43ad',
        'type.primitive': '#1d7676',
        type: '#1d7676',
        'type.stl': '#2a7062',
        function: '#2f5fa8',
        constant: '#b0541e',
        number: '#b0541e',
        string: '#5b781f',
        'string.escape': '#936611',
        preprocessor: '#a3376b',
        'string.include': '#5b781f',
        operator: '#6e655c',
        delimiter: '#766d63',
        identifier: '#3a3530',
        // clangd semantic tokens: what a name is, not how it is spelled
        macro: '#c0305f',
        'variable.local': '#3a3530',
        'variable.param': '#8a6a1d italic',
        'variable.global': '#1f7a3a',
        'variable.field': '#7a5a30',
        namespace: '#5a6f6f',
        label: '#b0541e'
    },
    shape: { radiusSm: '4px', radius: '6px', radiusLg: '9px', islandRadius: '999px' }
}

const mist: IterTheme = {
    id: 'iter-mist',
    name: 'Mist 晨雾',
    kind: 'light',
    ui: {
        bg: '#e6eaef',
        panel: '#edf0f4',
        elevated: '#f8f9fb',
        sunken: '#e2e7ed',
        border: '#d6dce4',
        borderStrong: '#c4ccd7',
        text: '#2d333c',
        textMuted: '#6a7381',
        textFaint: '#9aa3b0',
        accent: '#3d6fcf',
        accentText: '#f6f9ff',
        hover: 'rgba(20,40,80,0.05)',
        selection: 'rgba(61,111,207,0.14)',
        shadow: '0 12px 36px rgba(30,50,90,0.14)'
    },
    verdict: {
        ac: '#2f8a50',
        wa: '#c4413e',
        tle: '#a97612',
        mle: '#9447a6',
        re: '#7052b8',
        ce: '#b05a2a',
        pending: '#8590a0'
    },
    editor: {
        background: '#f6f8fa',
        foreground: '#2d333c',
        lineHighlight: '#eef1f5',
        selection: '#c0cee5',
        cursor: '#3d6fcf',
        lineNumber: '#b8c0cb',
        lineNumberActive: '#6a7381',
        indentGuide: '#e6eaf0',
        bracketMatch: '#d4def0',
        debugLine: '#fbf0c4'
    },
    highlight: {
        occurrence: '#2d333c33',
        occurrenceWrite: '#2d333c2d',
        selectionMatch: '#2d333c33',
        findCurrent: '#3d6fcf3e',
        findOther: '#3d6fcf41',
        findRange: '#2d333c1e'
    },
    tokens: {
        comment: '#858e9b italic',
        keyword: '#7546c2',
        'type.primitive': '#0f7889',
        type: '#0f7889',
        'type.stl': '#22766a',
        function: '#2f5fbf',
        constant: '#b0551d',
        number: '#b0551d',
        string: '#3b7a37',
        'string.escape': '#92690e',
        preprocessor: '#a83a73',
        'string.include': '#3b7a37',
        operator: '#5e6672',
        delimiter: '#69717d',
        identifier: '#2d333c',
        // clangd semantic tokens: what a name is, not how it is spelled
        macro: '#c22d62',
        'variable.local': '#2d333c',
        'variable.param': '#8c6a10 italic',
        'variable.global': '#1c7a40',
        'variable.field': '#8a4a4a',
        namespace: '#566a74',
        label: '#b0551d'
    },
    shape: DEFAULT_SHAPE
}

// Shows how far a theme can go with CSS alone: square geometry, terminal-like island, mono UI.
const terminal: IterTheme = {
    ...dusk,
    id: 'iter-terminal',
    name: 'Terminal 终端',
    ui: {
        ...dusk.ui,
        bg: '#0d0f0d',
        panel: '#0f120f',
        elevated: '#131713',
        sunken: '#0b0d0b',
        border: '#1e261e',
        borderStrong: '#2a352a',
        text: '#b9d4b9',
        textMuted: '#7f9a7f',
        textFaint: '#4f644f',
        accent: '#7ee08a',
        accentText: '#071207',
        selection: 'rgba(126,224,138,0.18)'
    },
    editor: {
        ...dusk.editor,
        background: '#0d0f0d',
        foreground: '#b9d4b9',
        lineHighlight: '#121612',
        selection: '#244227',
        cursor: '#7ee08a',
        lineNumber: '#334433',
        lineNumberActive: '#7f9a7f',
        indentGuide: '#161c16',
        bracketMatch: '#22402a',
        debugLine: '#2b2a12'
    },
    highlight: {
        occurrence: '#b9d4b933',
        occurrenceWrite: '#b9d4b935',
        selectionMatch: '#b9d4b933',
        findCurrent: '#7ee08a35',
        findOther: '#7ee08a37',
        findRange: '#b9d4b91a'
    },
    tokens: {
        ...dusk.tokens,
        comment: '#4f6a4f italic',
        keyword: '#7ee08a',
        'keyword.control': '#a6f0ae',
        'type.primitive': '#d7e07e',
        type: '#d7e07e',
        'type.stl': '#c4d48a',
        function: '#8fd4e0',
        constant: '#e0b37e',
        number: '#e0b37e',
        string: '#c9a6e8',
        preprocessor: '#e08fa6',
        'string.include': '#c9a6e8',
        identifier: '#b9d4b9',
        // clangd semantic tokens: what a name is, not how it is spelled
        macro: '#ff7aa8',
        'variable.local': '#b9d4b9',
        'variable.param': '#9fb0e8 italic',
        'variable.global': '#c690f0',
        'variable.field': '#e0d0a0',
        namespace: '#8fb0a0',
        label: '#e0b37e'
    },
    shape: { radiusSm: '0', radius: '0', radiusLg: '0', islandRadius: '0' },
    css: `
.nv-app { font-family: var(--mono); }
:root { --island-bg: #050705; --island-fg: #b9d4b9; --island-dim: #5f7a5f; --island-btn: rgba(126,224,138,.08); --island-btn-hover: rgba(126,224,138,.18); }
.nvi { outline: 1px dashed var(--accent); outline-offset: -1px; letter-spacing: .02em; }
.nvi-btn { border-radius: 0; }
.nv-verdict { background: none; border: 1px solid currentColor; }
.nv-tab.is-active::before { height: 1px; }
.nv-btn.is-primary { text-transform: uppercase; letter-spacing: .06em; }
`
}

// Warmer surfaces retain the existing editor geometry and semantic token roles.
const cocoa: IterTheme = {
    ...ember,
    id: 'iter-cocoa',
    name: 'Cocoa 可可',
    ui: {
        ...ember.ui,
        bg: '#211a1a',
        panel: '#2c2322',
        elevated: '#352a28',
        sunken: '#201919',
        border: '#433330',
        borderStrong: '#604941',
        text: '#e9d7d0',
        textMuted: '#b49d92',
        textFaint: '#947e74',
        accent: '#dab5a3',
        accentText: '#2b1e19',
        hover: 'rgba(246,220,205,0.055)',
        selection: 'rgba(218,181,163,0.2)'
    },
    editor: {
        ...ember.editor,
        background: '#241d1d',
        foreground: '#e9d7d0',
        lineHighlight: '#2b2221',
        selection: '#523c35',
        cursor: '#e8c4b1',
        lineNumber: '#7c665d',
        lineNumberActive: '#b49d92',
        indentGuide: '#3b2e2b',
        bracketMatch: '#594239',
        debugLine: '#443921'
    },
    highlight: {
        occurrence: '#e9d7d025',
        occurrenceWrite: '#e9d7d027',
        selectionMatch: '#e9d7d025',
        findCurrent: '#dab5a330',
        findOther: '#dab5a32d',
        findRange: '#e9d7d01a'
    },
    tokens: {
        ...ember.tokens,
        comment: '#9a867d italic',
        keyword: '#daabca',
        'type.primitive': '#bfc69e',
        type: '#bfc69e',
        'type.stl': '#afc4ad',
        function: '#dab5a3',
        constant: '#c1b0de',
        number: '#c1b0de',
        string: '#bdc58d',
        'string.escape': '#ddc18e',
        preprocessor: '#dca1a2',
        'string.include': '#bdc58d',
        operator: '#b4a397',
        delimiter: '#ac998e',
        identifier: '#e9d7d0',
        macro: '#e4a1b4',
        'variable.local': '#e9d7d0',
        'variable.param': '#d8c49d italic',
        'variable.global': '#a9c9ba',
        'variable.field': '#b7bfd8',
        namespace: '#b8ad9c',
        label: '#c1b0de'
    }
}

const tea: IterTheme = {
    ...ember,
    id: 'iter-tea',
    name: 'Tea 茶褐',
    ui: {
        ...ember.ui,
        bg: '#24221c',
        panel: '#302d25',
        elevated: '#39352b',
        sunken: '#23211b',
        border: '#454033',
        borderStrong: '#615845',
        text: '#ded9c8',
        textMuted: '#aaa28c',
        textFaint: '#8e866f',
        accent: '#c6b18b',
        accentText: '#292318',
        hover: 'rgba(236,224,188,0.055)',
        selection: 'rgba(198,177,139,0.2)'
    },
    editor: {
        ...ember.editor,
        background: '#28261f',
        foreground: '#ded9c8',
        lineHighlight: '#302d24',
        selection: '#51452d',
        cursor: '#ddc69b',
        lineNumber: '#7d755f',
        lineNumberActive: '#aaa28c',
        indentGuide: '#3c382c',
        bracketMatch: '#554c34',
        debugLine: '#454023'
    },
    highlight: {
        occurrence: '#ded9c825',
        occurrenceWrite: '#ded9c827',
        selectionMatch: '#ded9c825',
        findCurrent: '#c6b18b35',
        findOther: '#c6b18b33',
        findRange: '#ded9c81c'
    },
    tokens: {
        ...ember.tokens,
        comment: '#98907a italic',
        keyword: '#d7af94',
        'type.primitive': '#c9c18e',
        type: '#c9c18e',
        'type.stl': '#b5c7a1',
        function: '#c6b18b',
        constant: '#c2b0d0',
        number: '#c2b0d0',
        string: '#afc195',
        'string.escape': '#dbc391',
        preprocessor: '#d2a2ae',
        'string.include': '#afc195',
        operator: '#b0a994',
        delimiter: '#a69d85',
        identifier: '#ded9c8',
        macro: '#dda5a0',
        'variable.local': '#ded9c8',
        'variable.param': '#cfbe98 italic',
        'variable.global': '#a7c6b5',
        'variable.field': '#b4bed2',
        namespace: '#b7bc9b',
        label: '#c2b0d0'
    }
}

const wheat: IterTheme = {
    ...paper,
    id: 'iter-wheat',
    name: 'Wheat 麦纸',
    ui: {
        ...paper.ui,
        bg: '#e8dcc6',
        panel: '#ede2ce',
        elevated: '#faf3e5',
        sunken: '#e6d9c0',
        border: '#d6c5a7',
        borderStrong: '#b9a381',
        text: '#45392d',
        textMuted: '#78634c',
        textFaint: '#8d785e',
        accent: '#8c5b31',
        accentText: '#fff7e9',
        hover: 'rgba(92,65,29,0.055)',
        selection: 'rgba(140,91,49,0.18)',
        shadow: '0 12px 36px rgba(86,60,26,0.18)'
    },
    editor: {
        ...paper.editor,
        background: '#f5eedf',
        foreground: '#45392d',
        lineHighlight: '#eee4d0',
        selection: '#d6bea1',
        cursor: '#8c5b31',
        lineNumber: '#a79477',
        lineNumberActive: '#78634c',
        indentGuide: '#dfd2b9',
        bracketMatch: '#dfcba9',
        debugLine: '#eadba7'
    },
    highlight: {
        occurrence: '#45392d33',
        occurrenceWrite: '#45392d30',
        selectionMatch: '#45392d33',
        findCurrent: '#8c5b3144',
        findOther: '#8c5b3140',
        findRange: '#45392d1e'
    },
    tokens: {
        ...paper.tokens,
        comment: '#7d6b57 italic',
        keyword: '#794779',
        'type.primitive': '#356b66',
        type: '#356b66',
        'type.stl': '#446c47',
        function: '#4d5e85',
        constant: '#93522c',
        number: '#93522c',
        string: '#5d6c30',
        'string.escape': '#795d25',
        preprocessor: '#91485d',
        'string.include': '#5d6c30',
        operator: '#6d5b49',
        delimiter: '#77604e',
        identifier: '#45392d',
        macro: '#9b3d57',
        'variable.local': '#45392d',
        'variable.param': '#795d25 italic',
        'variable.global': '#386b46',
        'variable.field': '#80573a',
        namespace: '#58644d',
        label: '#93522c'
    }
}

const sandstone: IterTheme = {
    ...paper,
    id: 'iter-sandstone',
    name: 'Sandstone 砂岩',
    ui: {
        ...paper.ui,
        bg: '#ded0c6',
        panel: '#e5d8cf',
        elevated: '#f5ede7',
        sunken: '#dccdc2',
        border: '#cfbbae',
        borderStrong: '#b59b8b',
        text: '#483b34',
        textMuted: '#786257',
        textFaint: '#8d776b',
        accent: '#996344',
        accentText: '#fff7f1',
        hover: 'rgba(92,60,42,0.055)',
        selection: 'rgba(153,99,68,0.18)',
        shadow: '0 12px 36px rgba(86,55,38,0.18)'
    },
    editor: {
        ...paper.editor,
        background: '#eee5de',
        foreground: '#483b34',
        lineHighlight: '#e7dad0',
        selection: '#cdb5a4',
        cursor: '#996344',
        lineNumber: '#a38c7d',
        lineNumberActive: '#786257',
        indentGuide: '#d9c8bc',
        bracketMatch: '#d8bfae',
        debugLine: '#e8d6a9'
    },
    highlight: {
        occurrence: '#483b3433',
        occurrenceWrite: '#483b3430',
        selectionMatch: '#483b3433',
        findCurrent: '#99634449',
        findOther: '#99634444',
        findRange: '#483b341e'
    },
    tokens: {
        ...paper.tokens,
        comment: '#7d685b italic',
        keyword: '#79476a',
        'type.primitive': '#38685f',
        type: '#38685f',
        'type.stl': '#50653e',
        function: '#4f5d7b',
        constant: '#8e4f2f',
        number: '#8e4f2f',
        string: '#5f672e',
        'string.escape': '#785b26',
        preprocessor: '#8e465b',
        'string.include': '#5f672e',
        operator: '#6c5749',
        delimiter: '#725c4e',
        identifier: '#483b34',
        macro: '#963f55',
        'variable.local': '#483b34',
        'variable.param': '#785b26 italic',
        'variable.global': '#3b6746',
        'variable.field': '#7d523b',
        namespace: '#57614c',
        label: '#8e4f2f'
    }
}

export const BUILTIN_THEMES: IterTheme[] = [dusk, ember, forest, paper, mist, terminal, cocoa, tea, wheat, sandstone]
