# Windows 安装包

需要 Windows x64、Node.js 24 或更新版本、npm。以下命令均在仓库的 `app/` 目录执行：

```powershell
npm ci
npm run setup
npm run dist:win
```

`setup` 准备内置工具链、图标、runner 和模型 tokenizer。`dist:win` 的前置步骤准备工具链和图标，再执行格式检查、类型检查、测试、构建、项目文件检查，以及真实应用的安全和发布验收。随后重新构建应用和原生 helper，由 electron-builder 生成 NSIS 安装包。

安装包输出为 `dist/ITER-Setup-<版本>.exe`，解包目录为 `dist/win-unpacked/`。安装器支持中英文和自定义安装目录，默认按用户安装并创建桌面、开始菜单快捷方式及 `.cpp` 文件关联。安装包签名需要发布者另行配置签名证书。

## 资源与可复现构建

- `package-lock.json` 固定 npm 依赖；使用 `npm ci` 安装。构建复用 `node_modules/electron/dist/`，避免再次下载 Electron。
- 源码仓库保留模型、ONNX Runtime WASM 文件、资源清单、testlib 和原生 helper 源码。编译器、依赖目录、缓存、编译产物、安装包及用户配置不入库。
- `resources/toolchain/` 使用 WinLibs GCC 14.2.0、GDB 16.2、clangd / clang-format 19.1.7，目标为 x86_64、POSIX 线程、SEH、MinGW-w64 12.0.0 UCRT，r3。
- 工具链头文件、库、DLL、GDB 数据、Python 和发行包自带的 pretty printers 保留。下载脚本仅裁剪文档和未使用的 Fortran、Ada、Objective-C 编译前端，并准备 GDB 的 UTF-8 兼容 manifest。
- `resources/model/`、`resources/toolchain/`、`resources/testlib/` 和 `resources/runner/` 作为 asar 外资源打包。构建会重编译 `runner.exe`、`tokenizer.exe`，并更新模型清单中的 tokenizer 哈希。
- 图标使用 `src/shared/branding/iter-icon.svg` 原稿，`npm run make-icon` 写出 `build/icon.svg`、PNG 和 ICO；欢迎页使用同目录下的 `iter-logo.svg` 透明字标，文字随深浅主题切换。

工具链来源：[官方发行页](https://github.com/brechtsanders/winlibs_mingw/releases/tag/14.2.0posix-12.0.0-ucrt-r3)。固定下载地址、文件大小和 SHA-256 位于 [fetch-toolchain.mjs](../scripts/fetch-toolchain.mjs)。下载脚本校验固定哈希，再使用 npm 依赖 `7zip-bin` 解压；无需另装 7-Zip。

下载缓存位于 `.cache/toolchain/`，支持断点续传；安装位置为 `resources/toolchain/`。两者均由 Git 忽略。需要更换缓存位置时，可以在当前 PowerShell 会话配置 npm、Electron 和 electron-builder 的缓存：

```powershell
$env:npm_config_cache = "$PWD/.cache/npm"
$env:ELECTRON_CACHE = "$PWD/.cache/electron"
$env:ELECTRON_BUILDER_CACHE = "$PWD/.cache/electron-builder"
```

## 发布验证

生成安装包后可执行 `npm run verify:win` 验证解包应用。该脚本检查工具版本、C++23 示例、GDB、runner、testlib 和应用启动；截图与日志写入 `dist/verification/`。运行前先退出其他 ITER 实例。

受限 Windows 环境可使用 `npm run verify:win -- -RestrictedEnvironment`。该选项只针对工作区的 `dist/win-unpacked/` 调整读取权限，并在验证进程中使用隔离数据目录及软件渲染，不修改安装器的启动参数。

验证解包应用不能代替实际安装、升级和卸载验收。正式发布前应在独立 Windows 环境检查安装流程、文件关联和设置保留情况。

## 升级工具链

在 [fetch-toolchain.mjs](../scripts/fetch-toolchain.mjs) 中同时更新 `TOOLCHAIN` 的发行版本、组件版本、URL、字节数与 SHA-256。选择文件名含 `llvm`、`x86_64`、`ucrt` 的官方发行包，独立核对官方校验值，再重新准备工具链、构建和验证。

调整裁剪策略时增加 `layout`，使已有安装重新解压。升级 LLVM 时需要同步核对模型 tokenizer 的版本约束和应用清单，并更新本文的组件版本。
