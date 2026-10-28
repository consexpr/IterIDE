import type { JudgeModePlugin } from '../registry'
import { describeBase, prepareShared, runShared, solutionBuild } from './common'

export const standardMode: JudgeModePlugin = {
    id: 'standard',
    name: '普通比较',
    description: '运行解答并比较输出',
    detect: () => ({ confidence: 0 }),
    build: solutionBuild,
    prepare: (ctx) => prepareShared(ctx),
    run: runShared,
    describe: (problem, src) => describeBase('standard', '普通比较', problem, src)
}
