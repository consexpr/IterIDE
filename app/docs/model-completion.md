# 补全模型排序

在“设置 → 补全”开启 **Model**。默认关闭，配置键为 `editor.completion.model`（旧版本的 `cnn` 键会自动迁移），旧配置自动补为关闭。开关跟随现有设置导入、导出及同步。

开启后只对 clangd 返回的前 100 个候选进行本地重排。显式代码片段和未评分项保留原位置；插入文本、括号光标、替换范围、附加编辑保持原样。关闭时保持原排序。

## 运行结构

- 主进程管理一个后台 `worker_threads`，WebAssembly 单线程 CPU 推理，不需要 Python、PyTorch、CUDA 或联网。
- `resources/model/ranker.onnx` 是随应用提供的固定模型；版本、训练来源记录和文件哈希见 [部署清单](../resources/model/manifest.json)。
- `tokenizer.exe` 使用内置 `libclang.dll` 19.1.7 的 `clang_tokenize`。单文件模式不进入头文件，实际词法边界、UTF-8 拼写、注释及字面量处理与训练器一致。
- 上下文为前 128、后 32 个词法单元和光标标记，模型输入填充到 192；字节上限为单词 48、候选 256。Unicode casefold 补充表由 Python 3.12 的 Unicode 15.0 生成，跨语言输入哈希由回归样本核验。
- 推理失败、资源损坏、冷启动或 120ms 内未完成，使用原排序。队列至多一个进行中的请求和一个最新等待请求，迟到结果检查请求序号和文档版本。
- 关闭开关、窗口退出或 worker 故障时，只停止本实例的 worker 与词法进程。词法进程内存上限 512MiB，并监测所属主进程退出。

## 资源与更新

`resources/model/manifest.json` 固定模型、词法版本及各运行资源 SHA-256。ONNX Runtime Web 1.22.0 来自官方 npm 包，仅打包 WASM CPU 文件，保留 MIT 和第三方许可。

重编词法桥：`npm run build-model-tokenizer`，使用已准备的内置 MinGW，并更新可执行文件哈希。首次从源码运行时执行 `npm run setup`；Windows 打包流程也会重编 helper，模型与运行资源由 `electron-builder.yml` 的 `extraResources` 携带。

更新模型时同时更新 `ranker.onnx`、清单和跨语言黄金样本，核对输出概率与排序。ONNX 导出时保留动态候选数量；不得替换成另一套正则分词或固定标识符词表。

## 验证

`npm test` 自动隔离测试数据目录。`features.test.ts` 核验固定输入字节和文件统计特征；`runtime.integration.test.ts` 核验原生 Clang 和实际 CPU 模型。集成测试需先构建，并设置 `ITER_TEST_MODEL_INTEGRATION=1`。

UI 与语言服务回归覆盖开关、调用失败/超时、关闭开关、快速编辑、同版本迟到响应，以及有参数/无参数函数的括号光标行为。打包验收使用独立 Electron 用户目录和源码样例。

完整调用协议、二进制帧及模型替换要求见 [补全模型调用协议](model-protocol.md)。
