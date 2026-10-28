import type { JudgeModePlugin } from '../registry'
import { describeBase, prepareShared, runShared, solutionBuild, toolBadges } from './common'

export const spjMode: JudgeModePlugin = {
    id: 'spj',
    name: '特殊评测',
    description: '使用自定义检查器评测输出',
    settingsSchema: [
        { key: 'checker.path', label: '检查器', type: 'file', required: true },
        { key: 'checker.args', label: '参数模板', type: 'text' }
    ],
    detect(folder) {
        const checker = folder.files.find((file) => /^(checker|chk|spj|check)\.(cpp|exe)$/i.test(file))
        return checker
            ? {
                  confidence: 0.85,
                  config: { checker: { kind: 'custom', path: checker, relativeTo: 'source' } },
                  attachments: { checker },
                  excludeSources: [checker],
                  notes: ['发现自定义检查器，将使用特殊评测']
              }
            : undefined
    },
    build: solutionBuild,
    prepare: (ctx) => prepareShared(ctx, true),
    run: runShared,
    describe: async (problem, src) =>
        describeBase('spj', '特殊评测', problem, src, await toolBadges('检查器', problem.checker, src))
}
