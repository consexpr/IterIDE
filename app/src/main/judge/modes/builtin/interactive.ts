import type { JudgeModePlugin } from '../registry'
import { describeBase, solutionBuild, toolBadges } from './common'

export const interactiveMode: JudgeModePlugin = {
    id: 'interactive',
    name: '交互评测',
    description: '解答与交互器通过管道通信',
    parallel: false,
    settingsSchema: [
        { key: 'interactor.path', label: '交互器', type: 'file', required: true },
        { key: 'interactor.args', label: '参数模板', type: 'text' }
    ],
    detect(folder) {
        const interactor = folder.files.find((file) => /^interact.*\.(cpp|exe)$/i.test(file))
        return interactor
            ? {
                  confidence: 0.95,
                  config: { interactor: { path: interactor, relativeTo: 'source' } },
                  attachments: { interactor },
                  excludeSources: [interactor],
                  notes: ['发现交互器，将使用交互评测']
              }
            : undefined
    },
    build: solutionBuild,
    prepare: (ctx) =>
        ctx.prepareTool(
            ctx.problem.interactor?.path ?? '',
            ctx.problem.interactor?.relativeTo,
            ctx.problem.interactor?.files
        ),
    run: (ctx) => ctx.runInteractive(ctx.prepared as string),
    describe: async (problem, src) =>
        describeBase('interactive', '交互评测', problem, src, [
            ...(await toolBadges('交互器', problem.interactor, src)),
            ...(problem.interactor?.files?.length
                ? [{ label: '交互器文件', value: `${problem.interactor.files.length + 1} 个` }]
                : []),
            { label: '内存统计', value: '不可用', tone: 'warn' }
        ])
}
