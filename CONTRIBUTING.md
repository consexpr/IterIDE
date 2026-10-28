# 参与开发

先按 [README](README.md) 完成 `npm ci` 和 `npm run setup`。应用面向 Windows x64；其他平台上的原生评测和调试路径尚未完整验证。

## 代码约定

- 自有代码使用 4 个空格、UTF-8、LF；配置见根目录 `.editorconfig`、`.prettierrc.json` 和 `.clang-format`。
- 在 `app/` 执行 `npm run format`；PowerShell 使用 `npm run format:powershell`，需要 PSScriptAnalyzer。第三方资源、生成锁文件和依赖精确字节的测试夹具不做批量重排。
- IPC 类型定义于 `src/shared/api.ts`，主进程参数校验位于 `src/main/ipcValidation.ts`。不要绕过 preload 暴露任意 Node.js API。
- 文件创建、保存和关闭复用 `renderer/actions/fileOperations.ts` 的队列；题库写入使用现有事务，避免并发覆盖。
- 修改功能时添加能复现问题的定向回归。纯格式和文档修改不需要新增测试。

## 提交前

```powershell
cd app
npm run format:check
npm run typecheck
npm test -- <相关测试文件>
npm run check:repo
```

影响构建或资源时再运行 `npm run build`。GitHub Actions 执行常规检查；发布安装包前执行 `npm run check:release`。

不要提交 `sandbox/`、`.cache/`、`.backups/`、`node_modules/`、`out/`、`dist/`、本地密钥或下载工具链。新增公开文件类别时同步修改 `app/scripts/repository-files.mjs` 与 `.gitignore`。复现问题时使用独立数据目录，日志中的令牌和个人路径应先脱敏。
