# 内置工具链与格式化

安装包将完整工具链放在 `process.resourcesPath/toolchain/`，开发环境可选放在
`app/resources/toolchain/`（已忽略，不入库）。目录采用 WinLibs 布局：

```text
toolchain/
  bin/g++.exe
  bin/gdb.exe
  bin/clangd.exe
  bin/clang-format.exe
  bin/*.dll
  lib/  libexec/  include/  share/  ...
```

必须保留 GCC 的头文件、库、运行时 DLL、GDB/Python 等配套目录，不能只复制四个 exe。
Linux/macOS 使用相同的 `bin/` 布局，程序无 `.exe` 后缀，并保留可执行权限。

所有工具统一通过 `src/main/toolchain/` 解析：存在且可执行的绝对设置路径优先；
裸命令名先尝试内置工具对应的标准文件名，再按 PATH 顺序查找该裸命令。
无效绝对路径、相对路径和找不到的工具返回明确错误，不静默替换用户的绝对路径。
子进程统一继承环境并把内置 `bin` 放在 PATH 最前面（Windows 合并 PATH/Path），
涵盖编译器、评测程序、runner、checker、interactor、GDB 及其 inferior 和 clangd。
`toolchain:status` / `api.toolchain.status()` 按工具返回 `{command, source, version}` 或 `{error}`，
版本查询有超时和输出上限。

打包流程后续由打包脚本下载固定版本、目标架构的 WinLibs GCC/GDB/LLVM 发行包，
校验预先记录的 SHA-256 后解压并整理成上述目录，再作为 Electron 的外部资源复制到
`resources/toolchain`，不要放入 asar。下载脚本与版本锁定由打包任务实现。

格式化由一个 Monaco 文档/选区 provider 提供，保留默认 Shift+Alt+F。
clangd 连接时优先请求它；离线、崩溃或请求失败时调用 `format:run` / `api.format.run()`，
使用解析后的 clang-format，从 stdin 读取当前内容，返回完整 `{text}` 或 `{error}`。
选区使用一基 UTF-16 行列，主进程转换成 clang-format 的 UTF-8 字节 offset/length；
clang-format 可能扩展到完整语句。过期或已取消的结果不会写回模型。

编辑器的“缩进宽度”和“用空格缩进”同时控制 Tab、Enter、clangd 和 clang-format。
修改设置时，已打开源码仅转换行首空白，可单次撤销；多行字符串和反斜杠续行保留原内容。
打开既有文件只应用编辑选项，不自动改写内容。

旧 `clangFormatStyle` 的非缩进风格继续兼容；`file` 仍读取最近的项目配置。
两条格式化路径通过 clang-format `--dump-config` 解析配置，再统一基础、续行和构造初始化
缩进，写入独立临时配置。CLI 使用 `--style=file:<临时配置>`；clangd 使用临时文档。
完成或停止时清理，项目目录不写入配置。打包时应使用相同 LLVM 版本的两种工具；
真实集成测试会比较它们的输出。

`formatActive()` 将修改合并为一个撤销步骤并保留光标；保存钩子在写盘前完成格式化，
失败时提示并保存当前内容。

## 手动环境体检

在“设置 → 环境体检”中点击“开始体检”，可以随时检查当前工具链；不会在启动时自动执行。
支持取消、修改配置后重新体检，以及复制诊断信息。检查期间可以关闭设置，重新打开后仍可查看本次进度和结果。

体检使用独立临时样例与进程，检查当前评测编译选项、程序输入输出、调试编译选项与 GDB 断点/变量读取、Python 录制支持，以及 clangd 标准库补全。
它不会重启当前编辑器的 clangd，也不会停止当前题目的评测或调试。体检结束后会清理自己的进程和临时文件。

“部分可用”表示某些能力受限，例如无 Python 的 GDB 仍可单步调试，但无法自动录制回放。
编译失败时运行项会标为未检查，调试与补全仍分别检查；详情与处理提示保留在结果中。
复制的报告包含本次工具路径、编译选项及诊断结果，不包含题目源码、测试数据或同步凭据。
体检结果只对应点击开始时的配置；配置变化后页面会提示重新检查。结果在本次应用会话内保留。
