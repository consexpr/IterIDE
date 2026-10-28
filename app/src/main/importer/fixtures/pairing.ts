import type { DetectedPair } from '../../../shared/importer'

interface Fixture {
    title: string
    files: string[]
    pairs: DetectedPair[]
    unmatched?: string[]
    note?: RegExp
}

export const pairingFixtures: Fixture[] = [
    {
        title: 'classic .in/.out',
        files: ['1.in', '1.out'],
        pairs: [{ name: '1', input: '1.in', answer: '1.out' }]
    },
    {
        title: 'classic .in/.ans',
        files: ['1.in', '1.ans'],
        pairs: [{ name: '1', input: '1.in', answer: '1.ans' }]
    },
    {
        title: 'mixed answers prefer .ans for the same case',
        files: ['3.out', '2.ans', '1.in', '1.out', '2.in', '3.in', '3.ans'],
        pairs: [
            { name: '1', input: '1.in', answer: '1.out' },
            { name: '2', input: '2.in', answer: '2.ans' },
            { name: '3', input: '3.in', answer: '3.ans' }
        ],
        unmatched: ['3.out'],
        note: /3\.in 同时有 3\.ans 和 3\.out，已采用 3\.ans/
    },
    ...['ans', 'out', 'ok', 'a', 'answer', 'output', 'res', 'sol', 'expected'].map((extension) => ({
        title: `answer extension .${extension}`,
        files: ['case.in', `case.${extension}`],
        pairs: [{ name: 'case', input: 'case.in', answer: `case.${extension}` }]
    })),
    ...['in', 'input', 'inp', 'dat'].map((extension) => ({
        title: `input extension .${extension}`,
        files: [`case.${extension}`, 'case.ans'],
        pairs: [{ name: 'case', input: `case.${extension}`, answer: 'case.ans' }]
    })),
    {
        title: 'input1.txt/output1.txt',
        files: ['input1.txt', 'output1.txt'],
        pairs: [{ name: '1', input: 'input1.txt', answer: 'output1.txt' }]
    },
    {
        title: 'in1/out1 without extensions',
        files: ['in1', 'out1'],
        pairs: [{ name: '1', input: 'in1', answer: 'out1' }]
    },
    {
        title: 'data1.in/data1.out',
        files: ['data1.in', 'data1.out'],
        pairs: [{ name: 'data1', input: 'data1.in', answer: 'data1.out' }]
    },
    {
        title: '1_input.txt/1_output.txt',
        files: ['1_input.txt', '1_output.txt'],
        pairs: [{ name: '1', input: '1_input.txt', answer: '1_output.txt' }]
    },
    {
        title: 'sample-1-in.txt suffix markers',
        files: ['sample-1-in.txt', 'sample-1-out.txt'],
        pairs: [{ name: 'sample-1', input: 'sample-1-in.txt', answer: 'sample-1-out.txt' }]
    },
    {
        title: 'Luogu/NOI example prefix',
        files: ['ex_foo1.in', 'ex_foo1.ans'],
        pairs: [{ name: 'ex_foo1', input: 'ex_foo1.in', answer: 'ex_foo1.ans' }]
    },
    {
        title: 'Luogu/NOI problem prefix',
        files: ['problem1.in', 'problem1.ans'],
        pairs: [{ name: 'problem1', input: 'problem1.in', answer: 'problem1.ans' }]
    },
    {
        title: 'test_01.in padded number',
        files: ['test_01.in', 'test_01.out'],
        pairs: [{ name: 'test_01', input: 'test_01.in', answer: 'test_01.out' }]
    },
    {
        title: 'Polygon extensionless input',
        files: ['tests/01', 'tests/01.a'],
        pairs: [{ name: 'tests/01', input: 'tests/01', answer: 'tests/01.a' }]
    },
    {
        title: 'arbitrary extensionless stems with answers',
        files: ['arbitrary', 'arbitrary.ans'],
        pairs: [{ name: 'arbitrary', input: 'arbitrary', answer: 'arbitrary.ans' }]
    },
    {
        title: 'nested subtasks never collide',
        files: ['subtask2/03.in', 'subtask1/03.ans', 'subtask1/03.in', 'subtask2/03.out'],
        pairs: [
            { name: 'subtask1/03', input: 'subtask1/03.in', answer: 'subtask1/03.ans' },
            { name: 'subtask2/03', input: 'subtask2/03.in', answer: 'subtask2/03.out' }
        ]
    },
    {
        title: 'distinct case-sensitive folders stay isolated',
        files: ['A/1.in', 'a/1.ans'],
        pairs: [{ name: 'A/1', input: 'A/1.in' }],
        unmatched: ['a/1.ans']
    },
    {
        title: 'ignore macOS metadata and hidden files',
        files: ['.DS_Store', '__MACOSX/._1.in', '.hidden/2.in', 'sub/.3.in', '1.in', '1.out'],
        pairs: [{ name: '1', input: '1.in', answer: '1.out' }]
    },
    {
        title: 'case-insensitive extensions and both separators',
        files: ['sub\\1.IN', 'sub/1.AnS'],
        pairs: [{ name: 'sub/1', input: 'sub/1.IN', answer: 'sub/1.AnS' }]
    },
    {
        title: 'natural sorting with samples first',
        files: ['10.in', 'sample10.in', '2.in', 'sample2.in', 'example3.in', 'ex_foo1.in'],
        pairs: [
            { name: 'ex_foo1', input: 'ex_foo1.in' },
            { name: 'example3', input: 'example3.in' },
            { name: 'sample2', input: 'sample2.in' },
            { name: 'sample10', input: 'sample10.in' },
            { name: '2', input: '2.in' },
            { name: '10', input: '10.in' }
        ]
    },
    {
        title: 'missing answers remain importable and loose data stays unmatched',
        files: ['1.in', '2.ans', '3.txt', 'input4.txt', '05', 'README.txt', 'solution.cpp'],
        pairs: [
            { name: '1', input: '1.in' },
            { name: '4', input: 'input4.txt' },
            { name: '05', input: '05' }
        ],
        unmatched: ['2.ans', '3.txt'],
        note: /3 个输入没有答案，仍可导入/
    },
    {
        title: '.txt requires a name keyword',
        files: ['1.txt', '1.out'],
        pairs: [],
        unmatched: ['1.out', '1.txt']
    },
    {
        title: 'keywords at both ends normalize separators',
        files: ['foo_input_1.txt', 'foo_output_1.txt'],
        pairs: [{ name: 'foo_1', input: 'foo_input_1.txt', answer: 'foo_output_1.txt' }]
    },
    {
        title: 'exact stems win over ambiguous keyword aliases',
        files: ['1.in', 'input1.in', '1.ans', 'input1.out'],
        pairs: [
            { name: '1', input: '1.in', answer: '1.ans' },
            { name: '1', input: 'input1.in', answer: 'input1.out' }
        ]
    },
    {
        title: 'ambiguous aliases never share an answer',
        files: ['1.in', 'input1.in', 'output1.txt'],
        pairs: [
            { name: '1', input: '1.in' },
            { name: '1', input: 'input1.in' }
        ],
        unmatched: ['output1.txt'],
        note: /1\.in、input1\.in 配对不明确，答案未匹配/
    },
    {
        title: 'UTF-8 relative paths',
        files: ['子任务/测试1.in', '子任务/测试1.ans'],
        pairs: [{ name: '子任务/测试1', input: '子任务/测试1.in', answer: '子任务/测试1.ans' }]
    },
    {
        title: 'unsafe paths do not become importable entries',
        files: ['../1.in', '/2.in', 'C:\\3.in', 'sub/../../4.in', '1.in:secret', 'ok.in'],
        pairs: [{ name: 'ok', input: 'ok.in' }],
        note: /已忽略不安全路径/
    }
]
