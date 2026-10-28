import { describe, expect, it } from 'vitest'
import { defaultProblem } from '../../../shared/problem'
import { panelDescription } from './description'

describe('island description before and after asynchronous file checks', () => {
    it('shows actual limits and IO immediately without a describe response', () => {
        const result = panelDescription(defaultProblem('main'), [])
        expect(result).toMatchObject({ modeId: 'standard', modeName: '普通运行' })
        expect(result.badges).toEqual([
            { label: '限制', value: '1 s · 512 MB', detail: undefined },
            { label: '文件 IO', value: '标准输入输出' },
            { label: '结果检查', value: '内置比较' }
        ])
    })

    it('retains the same leading badges when delayed metadata arrives', () => {
        const p = defaultProblem('main')
        const before = panelDescription(p, [])
        const after = panelDescription(p, [], {
            modeId: p.mode,
            modeName: '普通比较',
            badges: [{ label: '模式', value: '普通比较' }, ...before.badges, { label: '数据', value: '内置 3 组' }]
        })
        expect(after.badges.slice(0, before.badges.length)).toEqual(before.badges)
        expect(after.badges.filter((b) => b.label === '结果检查')).toHaveLength(1)
        expect(after.badges.filter((b) => b.label === '限制')).toHaveLength(1)
        expect(after.badges.at(-1)).toEqual({ label: '数据', value: '内置 3 组' })
    })

    it('never shows old limits or file IO while the latest settings are still saving', () => {
        const p = defaultProblem('main')
        const previous = panelDescription(p, [])
        p.timeLimit = 2500
        p.memoryLimit = 256
        p.fileIO.enabled = true
        const next = panelDescription(p, [], previous)
        expect(next.badges[0].value).toBe('2.5 s · 256 MB')
        expect(next.badges[1].value).toBe('main.in → main.out')
    })

    it('does not retain a previous mode warning after switching modes', () => {
        const p = defaultProblem('main')
        p.mode = 'interactive'
        const next = panelDescription(p, [], {
            modeId: 'spj',
            modeName: '特殊评测',
            badges: [{ label: '检查器', tone: 'error', value: '不存在' }]
        })
        expect(next.modeName).toBe('交互评测')
        expect(next.badges.some((b) => b.label === '检查器')).toBe(false)
    })

    it('preserves custom mode diagnostics and detects a legacy grader configuration', () => {
        const p = defaultProblem('main')
        p.mode = 'custom'
        const modes = [{ id: 'custom', name: '自定义模式', source: 'test' }]
        expect(panelDescription(p, modes).modeName).toBe('自定义模式')
        const warning = { label: '工具', value: '缺失', tone: 'error' as const }
        expect(
            panelDescription(p, modes, { modeId: p.mode, modeName: '自定义模式', badges: [warning] }).badges
        ).toContainEqual(warning)
        p.mode = 'standard'
        p.grader = { sources: ['grader.cpp'] }
        expect(panelDescription(p, modes).modeId).toBe('grader')
    })
})
