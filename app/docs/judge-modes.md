# 评测模式插件

评测模式负责发现题目类型、准备构建、执行并判定每组测试，以及说明题目所用文件。插件在 `activate(host)` 中调用 `host.registerJudgeMode(mode)`。传入普通 JavaScript 对象即可，不需要继承类。卸载或重载插件时，宿主用 `unregisterSource(pluginId)` 清理注册。

类型的权威定义在 [`src/main/judge/modes/registry.ts`](../src/main/judge/modes/registry.ts)。四个内置模式也通过同一个 `registerMode('builtin', mode)` 接口注册：

- [`builtin/standard.ts`](../src/main/judge/modes/builtin/standard.ts)：普通比较。
- [`builtin/spj.ts`](../src/main/judge/modes/builtin/spj.ts)：自定义检查器（testlib 或 [n-check](n-check.md)）。
- [`builtin/interactive.ts`](../src/main/judge/modes/builtin/interactive.ts)：双向管道交互。
- [`builtin/grader.ts`](../src/main/judge/modes/builtin/grader.ts)：将 grader 与解答一起编译链接。

## 粘贴交互器代码

在运行设置中选择「交互」，点击交互器旁的「设置」或「编辑」。可直接粘贴源码，通过文件标签切换，用「添加 CPP」添加其他编译单元，或添加头文件。文件名应与代码中的 `#include` 对应；所有 CPP 联合编译成独立交互器，整个交互器只保留一个 `main()`。未提供 `testlib.h` 时使用内置版本。

保存时，源码和头文件作为题目的资源一起保存。`interactor.path` 指定首个 CPP，`interactor.files` 保存其他 CPP 与头文件，路径锚点与 `path` 一致；头文件不作为独立编译单元。旧的单 CPP 或可执行交互器配置继续可用。

## 模式对象的全部字段

```ts
interface JudgeModePlugin {
  id: string
  name: string
  description?: string
  settingsSchema?: ModeSettingField[]
  parallel?: boolean
  detect(folder: ModeFolder): ModeDetection | undefined
  build?(context: ModePaths): ModeBuildPlan | Promise<ModeBuildPlan>
  compile?(context: ModeCompileContext): CompileResult | Promise<CompileResult>
  prepare?(context: ModeContext): unknown | Promise<unknown>
  run(context: ModeRunContext): TestResult | Promise<TestResult>
  describe(problem: ModeProblem, sourcePath: string): JudgeModeInfo | Promise<JudgeModeInfo>
}
```

| 字段             | 含义                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | 全局唯一、持久化的模式 id。以英文字母或数字开头，随后允许字母、数字、下划线、点和连字符。建议加插件名前缀。重复 id 会拒绝注册。 |
| `name`           | 非空中文短名称，例如「提交答案」。                                                                                              |
| `description`    | 可选的模式说明，随 `JudgeEngine.modes()` 返回。                                                                                 |
| `settingsSchema` | 可选的配置字段描述，供未来通用设置 UI 使用。当前引擎不据此生成、校验或保存配置。                                                |
| `parallel`       | 默认 `true`，按全局并发数运行测试；`false` 时串行。交互模式使用 `false`。                                                       |
| `detect`         | 必填、同步、只读的文件夹检测函数。不匹配返回 `undefined`。                                                                      |
| `build`          | 可选的构建计划函数，供评测、调试、语法检查及 clangd 共用。应只根据路径和题目配置计算，不编译、不创建临时文件。                  |
| `compile`        | 可选的编译替代函数；省略时调用 `context.compile()`。提交答案类模式可返回 `ok: true` 而不提供 `exe`。                            |
| `prepare`        | 可选，每轮评测编译成功后调用一次。用于缓存编译检查器等；返回值作为每个测试的 `prepared`。                                       |
| `run`            | 必填，每组测试调用一次，负责执行及判定，返回现有的 `TestResult`。                                                               |
| `describe`       | 必填，只读地返回信息栏描述。不可启动评测或编译。文件路径必须是绝对路径。                                                        |

生命周期为：选定模式 → `build` → `compile`（默认缓存编译）→ `prepare` → 对每组测试调用 `run` → 清理本轮临时目录。只有编译成功才进入准备和测试。单独点击编译不会调用 `prepare`。`build` 还可能被调试器、clangd、语法检查独立调用。

引擎保留 `compile-start`、`compile-done`、`test-start`、`test-done`、`done` 事件。某个测试抛错或返回无效结果，该测试为 `SE`；选模式、准备阶段抛错则整轮 `SE`。编译返回 `ok: false` 为 `CE`，主动停止为 `SE`。已经开始的评测持有模式对象引用；卸载后下一轮无法再选择该模式。

## 文件夹检测

`ModeFolder` 的字段：

| 字段                              | 含义                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `dir: string`                     | 题目文件夹的绝对路径。竞赛文件夹的各个子目录分别分析。                                                                            |
| `files: readonly string[]`        | 排好序的直接文件条目，路径相对于 `dir`，不含隐藏文件、子目录或 PDF。可包含源码、头文件、可执行文件、测试数据。                    |
| `peek(file): string \| undefined` | 同步、只读文本预览，最多 65,536 个字符。当前导入器预读 C++ 源码和头文件；未预读的文件返回 `undefined`。不应假设预览包含完整代码。 |

`ModeDetection` 的字段：

| 字段                            | 含义                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confidence: number`            | 必填，有限的 `[0, 1]` 数。最高者获选，同分按注册顺序。标准模式以 `0` 兜底。                                                                                         |
| `config?: Partial<ModeProblem>` | 建议的题目配置。注册表根据获选模式补上 `mode`；不要放入 `tests`、`version`、`title`。检查器、交互器、grader 路径相对 `folder.dir`，导入器会换算为解答路径。         |
| `attachments?`                  | 兼容现有预览的 `{ checker?: string; interactor?: string; grader?: { sources: string[]; headers: string[] } }`。路径相对 `dir`。这些文件在导入前会通过现有文件验证。 |
| `excludeSources?: string[]`     | 不应作为用户解答的文件，例如检查器和 grader。相对路径。                                                                                                             |
| `solutionFiles?: string[]`      | 如果存在，仅这些文件可作为用户解答；用于识别没有 `main` 的函数式解答。空数组表示没有现成解答。                                                                      |
| `notes?: string[]`              | 导入预览中的简短中文说明。                                                                                                                                          |

导入器合并匹配结果的配置和附件，高置信度覆盖低置信度的同名字段。这样 grader 与检查器可同时附加。获选结果决定 `mode`；第一个提供 `solutionFiles` 的匹配结果限制解答候选。没有这一字段时，仍要求解答定义 `main`。导入器保留原有配对、模板排序及源文件排序规则。

自定义选项放在 `modeOptions`。其中自定义路径不会被导入器自动重定位；跨目录导入时可在 `detect` 中用 `folder.dir` 生成绝对路径。插件作者必须说明这些路径在题目移动、导出时如何处理。

## 配置、路径和构建计划

`ModeProblem` 包含现有 `ProblemConfig` 的全部字段，`mode` 扩展为字符串，另可带 `modeOptions?: Record<string, unknown>`。插件不应修改传入配置。

显式 `problem.mode` 决定模式。兼容旧配置：`standard` 或 `spj` 加 `problem.grader` 映射为 `grader`；`standard` 加自定义 checker 映射为 `spj`。交互题仍选择 `interactive`。未知 id 必须保留：`describe` 显示「模式不可用」和错误徽章，运行发出带说明的编译失败事件及 `SE` 汇总。

`ModePaths` 是所有构建上下文的基础：

| 字段         | 含义                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| `problem`    | 当前题目配置快照。                                                         |
| `sourcePath` | 用户解答的绝对路径。                                                       |
| `sourceDir`  | 解答文件所在的绝对目录。                                                   |
| `problemDir` | 由题目存储提供的题目数据目录；不要自行拼接 `.iter/...`，存储布局可能变化。 |

`ModeBuildPlan` 的三个可选字段：

- `sources: string[]`：与编辑器中的解答一起编译链接的额外翻译单元。不要包含解答自身。
- `includeDirs: string[]`：头文件搜索目录。解答目录始终自动加入。
- `flags: string[]`：已分词的编译参数，例如 `['-std=c++20', '-DMODE=1']`。不要拼成 shell 命令。

`sources`、`includeDirs` 可相对于 `sourceDir`，也可为绝对路径，进入构建前会转为绝对路径并去重。参数顺序为全局 flags → 调试时补 `-g` → `problem.extraFlags` → 模式 flags → `-I` 目录 → 源码及额外翻译单元。clangd 使用 `compileArgsFor(sourcePath, flags)` 得到相同的标准、附加参数和头文件搜索路径；调试器使用调试全局 flags 与同一构建计划。

内置模式还加入 grader 源码目录、配置中的 grader include 目录、checker/interactor 所在目录。因此 `#include "perm.h"` 在评测、调试和语言服务中使用一致的搜索路径。

默认构建保留原有编译诊断、缓存和并发去重。缓存键包括编辑器内容、编译器路径、参数、附加源码内容及搜索目录下的直接头文件内容。不要依赖它跟踪任意外部工具链或所有递归包含文件的变化。

## 运行上下文和工具

`ModeContext` 除 `ModePaths` 外包含：

| 字段或方法                               | 含义                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolchain`                              | 当前轮的 `ToolchainSettings` 快照：compiler、flags、debugFlags、gdb、clangd、clangFormat、parallel、outputLimitBytes、displayLimitChars。                                                   |
| `signal`                                 | 该轮的 `AbortSignal`。自己的异步操作也应遵守取消。                                                                                                                                          |
| `compile()`                              | 使用编辑器内容、当前模式的构建计划进行默认缓存编译，返回 `CompileResult`。                                                                                                                  |
| `prepareTool(file, relativeTo?, files?)` | 返回 helper 的绝对可执行路径；`.cpp` 使用缓存编译，`files` 中的其他 CPP 一起链接，头文件目录加入搜索路径。`relativeTo: 'source'` 表示相对解答目录，省略则相对题目数据目录；也接受绝对路径。 |
| `runner()`                               | 返回原有资源限制 runner 的路径；不可用时为 `undefined`，共享执行路径会回退。                                                                                                                |
| `execute(exe, args, options?)`           | 通过原有 `--exec` wrapper 运行进程，保留 Windows 崩溃对话框防护、树清理和取消。默认 10 秒，输出及显示上限来自工具链。                                                                       |
| `tempDir()`                              | 创建本轮拥有的临时目录。正常结束、失败或停止后统一删除。每测试需要独立空间时，在各自的 `run` 中调用。                                                                                       |

`prepareTool` 对 C++ helper 使用 `-std=c++17 -O2 -include cstdint`。优先使用 helper 同目录或附加文件中的 `testlib.h`，缺失时使用内置版本。默认编译仍包含 helper 自身目录，局部头文件参与缓存。它不使用用户解答的 `extraFlags` 或模式的 `build.flags`。

`execute` 的 `options` 支持 `cwd`、`timeout`（毫秒）、`input`（有限 stdin 文件的路径）、`output`（stdout 保存路径）、`outputLimit`、`displayLimit`、`poll`。`signal` 和 `runner` 由引擎固定注入；`nativeJob` 不能绕过 wrapper。返回 `ProcessResult` 的 `code`、`signal`、`stdout`、`stderr`、`truncated`、`timeMs`、`timedOut`、`outputExceeded` 及可选 `error`。此低层 helper 不会自动把退出码转成 verdict，也不提供原生内存统计；优先复用下面的共享评测方法。

`ModeCompileContext` 额外有 `source`（编辑器未保存的文本）及 `debug: boolean`。`CompileResult` 字段为 `ok`、可选 `exe`、`output`、`diagnostics`、`timeMs`、`cached`。每条诊断包含 1 起始的 `line`、`column`、`severity`、`message`，可选 `file`、`endLine`、`endColumn`、`source`。省略 `exe` 的编译成功结果只适用于不运行用户程序的模式。

`ModeRunContext` 额外有：

| 字段或方法                          | 含义                                                                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`                              | 当前 `TestCaseMeta`，含 id、name、enabled，可选 sample、timeLimit、link。                                                                                                         |
| `compiled`                          | 此轮 `CompileResult`。                                                                                                                                                            |
| `prepared`                          | 本轮 `prepare` 的返回值，类型为 `unknown`；插件自行收窄。并行测试共享它，应视为只读。                                                                                             |
| `dataPaths`                         | 当前测试的绝对 `{ input, answer? }` 路径。链接数据只读。                                                                                                                          |
| `runShared({ checker?, runner? }?)` | 原有隔离执行及判定路径，包含文件 IO、时限、内存、输出限制、退出码、答案缺失处理。checker 是已准备的可执行路径；runner 可传 `await context.runner()` 的结果。要求 `compiled.exe`。 |
| `runInteractive(interactor)`        | 原有解答与交互器双向管道实现，参数模板来自 `problem.interactor.args`，使用独立测试临时目录。要求 `compiled.exe`。                                                                 |

插件自己创建的进程、文件、定时器由插件负责清理；引擎管理它提供的临时目录和上述运行 helper。`signal` 是停止协作机制，无法强行中断不返回的 JavaScript 函数。

## 判定结果

`run` 返回 `TestResult`：

| 字段                       | 含义                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `testId: string`           | 必须等于当前 `test.id`。                                                                   |
| `verdict`                  | `AC / WA / PE / TLE / MLE / RE / OLE / CE / SE / NA`；不能返回过渡态 `PENDING / RUNNING`。 |
| `timeMs: number`           | 非负有限数，执行耗时。                                                                     |
| `exitCode: number \| null` | 程序退出码；没有运行进程时可为 null。                                                      |
| `output: string`           | 用于展示的输出，插件应限制长度。                                                           |
| `stderr: string`           | 用于展示的标准错误，插件应限制长度。                                                       |
| `memoryKb?: number`        | 峰值内存；交互模式没有此统计。                                                             |
| `signal?: string \| null`  | 终止信号。                                                                                 |
| `checkerMessage?: string`  | 判定说明。                                                                                 |
| `interactorLog?: string`   | 交互器日志。                                                                               |
| `truncated?: boolean`      | 显示内容被截断。                                                                           |

共享路径的现有语义不变：成功运行但答案不存在或为空为 `NA`；缺少文件 IO 输出为 `WA`；解答非零退出或信号终止为 `RE`。testlib 检查器退出码 `0`、`7` → `AC`，`1` → `WA`，`2` → `PE`，其他 → `SE`。`7` 暂不产生部分分数。checker 超时、输出过大、运行失败为 `SE`。交互器成功且答案为空时仍为 `NA`。共享 runner 保留原有 TLE、MLE、OLE 优先级和等待输入超时说明。

汇总的 `passed` 只统计 `AC`；汇总 verdict 使用测试配置顺序中的第一个非 `AC`，与并发完成顺序无关。

## 信息栏和设置描述

`describe` 返回 `{ modeId, modeName, badges }`，不要把 UI 样式或 HTML 放进来。每个 `ModeBadge` 包含必填 `label`，以及可选：

- `value`：短值，例如「grader.cpp」「1 s · 512 MB」。
- `file`：文件或目录的绝对路径，UI 可据此打开或定位。
- `tone`：`normal`、`warn`、`error`；省略为普通显示。缺少必需文件用 `error`；同目录没有 testlib、将使用内置版本时用 `warn`。
- `detail`：悬停说明，例如完整数据目录、缺失原因。

内置描述展示模式、所用文件、全局时限和内存、文件 IO、数据来源。数据示例为「引用 bot/ 下 4 组 · 内置 2 组」。有单独测试时限时在限制徽章的详情中提示。第三方模式自行返回适合自己的简短中文标签。

每个 `ModeSettingField` 包含必填 `key`、`label`、`type`（`text / number / select / file`）；可选 `description`、`default`（字符串或数字）、`required`、`min`、`max`、`options`。`options` 为 `{ label: string; value: string }[]`，用于 select。`key` 使用例如 `checker.path` 或 `modeOptions.outputFile` 的点路径；它只是 UI 元数据，当前不执行自动赋值。

## 完整最小示例：提交答案

把以下两个文件放在插件目录中，安装位置参见 [插件 API](plugin-api.md)。为题目准备普通测试输入及答案，同时把用户提交的输出放到 `submitted.out`；此模式逐组对照答案，不启动 C++ 程序。示例采用换行归一化后的精确比较，并限制读取大小。

`iter-plugin.json`：

```json
{
  "id": "demo-output",
  "name": "提交答案示例",
  "version": "1.0.0",
  "main": "index.cjs"
}
```

CommonJS 入口 `index.cjs`：

```js
const fs = require('node:fs/promises')
const path = require('node:path')

const LIMIT = 1024 * 1024
async function text(file) {
  if ((await fs.stat(file)).size > LIMIT) throw new Error('示例仅支持 1 MiB 以下文本')
  return (await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n')
}

exports.activate = function (host) {
  host.registerJudgeMode({
    id: 'demo-output-only',
    name: '提交答案',
    description: '直接评测 submitted.out',
    settingsSchema: [
      { key: 'modeOptions.outputFile', label: '提交文件', type: 'file', required: true }
    ],
    detect(folder) {
      if (!folder.files.includes('submitted.out')) return undefined
      return {
        confidence: 1,
        config: { modeOptions: { outputFile: path.join(folder.dir, 'submitted.out') } },
        notes: ['发现提交答案文件']
      }
    },
    compile() {
      return { ok: true, output: '', diagnostics: [], timeMs: 0, cached: false }
    },
    async run(ctx) {
      ctx.signal.throwIfAborted()
      const file = path.resolve(ctx.sourceDir, String(ctx.problem.modeOptions?.outputFile ?? 'submitted.out'))
      const output = await text(file)
      const answer = ctx.dataPaths.answer ? await text(ctx.dataPaths.answer).catch(error => {
        if (error.code === 'ENOENT') return ''
        throw error
      }) : ''
      ctx.signal.throwIfAborted()
      return {
        testId: ctx.test.id,
        verdict: answer === '' ? 'NA' : output === answer ? 'AC' : 'WA',
        timeMs: 0,
        exitCode: null,
        output: output.slice(0, ctx.toolchain.displayLimitChars),
        stderr: '',
        truncated: output.length > ctx.toolchain.displayLimitChars
      }
    },
    async describe(problem, sourcePath) {
      const file = path.resolve(path.dirname(sourcePath), String(problem.modeOptions?.outputFile ?? 'submitted.out'))
      const exists = await fs.stat(file).then(s => s.isFile(), () => false)
      return {
        modeId: 'demo-output-only', modeName: '提交答案',
        badges: [{ label: '提交', value: path.basename(file), file,
          tone: exists ? 'normal' : 'error', detail: exists ? undefined : '文件不存在' }]
      }
    }
  })
}
```

没有 `build`、`prepare` 也是合法模式。需要编译用户程序时省略 `compile`；需要自定义比较器时参考 SPJ 内置模式，用 `prepareTool` 准备 helper，再在 `run` 调用 `runShared`。通信方式不同的模式可自己实现 `run`，并复用上下文的进程和临时目录 helper。

## 与共享契约及存储集成

judge 模块提供了运行和注册接口；以下契约由共享类型及题目存储维护者实现，不能只在 UI 放宽选择：

1. `ProblemConfig.mode` 应接受任意非空字符串，存储归一化、迁移、导入导出都要保留未知 id，不能退回 `standard`。
2. `ProblemConfig.modeOptions?: Record<string, unknown>` 应按 JSON 对象保存并读回。
3. `ProblemFolderPreview` 应公开 `mode?: string`、`modeConfig?: Partial<ModeProblem>`。当前导入器以结构兼容字段携带它们，IPC 和 UI 转交预览时应保留。

在这些持久化契约接入前，运行时注册和 judge 调度可独立工作，但新模式写入题目后会被旧存储归一化为 standard。`modes/modes.test.ts` 通过 store 边界注入配置，覆盖插件完整执行生命周期，同时不修改题目存储实现。
