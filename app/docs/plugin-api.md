# ITER 插件 API

在线提交功能已移除，旧版 `registerSubmitter` 接口不再提供；插件可使用面板、处理器和评测模式接口。

插件是普通的 CommonJS 模块，不需要 SDK 包、构建工具、审核或权限清单。插件可以提供侧栏页面、持久数据和评测模式。主进程插件可以直接使用 Node、Electron 和随插件携带的依赖；面板用普通 HTML/CSS/JavaScript 即可，也可以使用打包成本地文件的前端框架。

## 安装、布局与 manifest

用户插件放在 `app.getPath('userData')/plugins/<目录>/`，通过 ITER 的“打开插件目录”找到实际位置。Windows 通常为 `%APPDATA%/ITER/plugins/`，macOS 为 `~/Library/Application Support/ITER/plugins/`，Linux 为 `~/.config/ITER/plugins/`。加载器也支持 `app.getAppPath()/plugins/`，当前发行版不附带内置插件。

```text
plugins/my-plugin/
  iter-plugin.json
  index.cjs
  panel.html             # 可选
  panel.js
  panel.css
```

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "main": "index.cjs",
  "description": "自由扩展 ITER"
}
```

`id` 是 1–64 位字母、数字、下划线或连字符，以字母或数字开头；它决定插件身份，不要求与目录名一致。`name`、`version`、`main` 必须是非空字符串，`description` 可选。`main` 必须是插件目录内的 `.js` 或 `.cjs` 相对路径。上级 `package.json` 声明 `"type": "module"` 时请用 `.cjs`。入口和面板资源都不能通过路径或符号链接跳出插件目录。

相同 manifest id 的用户插件优先于内置插件，包括损坏的用户版本；不会在加载失败时悄悄激活内置版本。单个插件失败不会阻止其他插件。加载器不会自动下载插件。

## 生命周期与重载

```js
let timer
exports.activate = async function (host) {
  host.log('开始激活')
  // 注册任意组合的面板、处理器、评测模式。
  timer = setInterval(() => { /* 后台工作 */ }, 60000)
}
exports.deactivate = async function () {
  clearInterval(timer)
  // 清理监听器、连接、子进程，并等待尚未完成的数据写入。
}
```

必须导出 `activate(host)`，可同步或返回 Promise；`deactivate()` 可选。宿主等待激活最多 30 秒、停用最多 5 秒。激活失败或超时会记录错误，撤销插件已注册的全部贡献。

重载先让旧 host 失效，清空面板、频道和评测模式，撤下资源路由，再停用插件并关闭其窗口。随后清除插件目录内的 CommonJS 缓存（含本地辅助模块），重新发现并激活。目录外的依赖保留缓存；持久登录会话和 `dataDir` 保留。旧 host 再注册、通知或打开窗口会报“插件已卸载”。

这些超时不能抢占阻塞主线程的同步代码，也不会取消已经开始的后台操作。插件应自行停止异步工作，避免停用后继续注册或写入。

主进程 `PluginManager.reload()` 和 IPC `plugins:reload` 已提供重载；重启应用也会重新加载。宿主在加载、移除或错误清理后发送 `plugins:changed`，前端重新读取 `plugins:panels` 并刷新 iframe。刷新面板页面只刷新前端，不会重新执行 activate。

## PluginHost API

| API                                   | 用途                                                   |
| ------------------------------------- | ------------------------------------------------------ |
| `openWindow(url, opts?)`              | 打开或复用插件窗口，返回 `Promise<BrowserWindow>`。    |
| `registerPanel({ id, title, entry })` | 注册侧栏页面，插件内 id 唯一。                         |
| `handle(channel, fn)`                 | 注册本插件面板调用的同步或异步处理器，频道名唯一。     |
| `registerJudgeMode(mode)`             | 注册评测模式，来源自动设为插件 manifest id。           |
| `dataDir`                             | 已创建的可写绝对目录：`<userData>/plugin-data/<id>/`。 |
| `log(message)`                        | 输出带插件 id 的控制台日志，管理器保留最近 100 行。    |
| `notify(message)`                     | 通过 ITER 的通知回调提示用户。                         |

`dataDir` 是稳定的存储位置，用户插件覆盖内置插件后仍使用相同目录。请自行组织文件，不要把运行数据写回可能只读或位于 asar 内的插件文件夹。主进程插件本身仍有完整文件权限。当前完整运行时类型为 `src/main/plugins/host.ts` 的 `RuntimePluginHost`；共享 `PluginHost` 的 `dataDir` 字段待共享契约维护者合入，JavaScript 插件已可直接使用。

### 窗口

```js
const win = await host.openWindow('https://example.com', {
  width: 1100, height: 800, show: true
})
await win.webContents.executeJavaScript('document.title')
```

仅接受 HTTP/HTTPS。每个插件复用一个窗口，等待页面加载后返回；默认显示并聚焦，`show: false` 不主动显示。窗口关闭后可重新创建。持久会话分区为 `persist:iter-plugin-<id>`，登录 Cookie 由 Electron 保存。

窗口关闭 Node 集成并开启上下文隔离、沙箱。向网页脚本传入源代码等文本时用 `JSON.stringify` 编码为数据，避免代码注入；ITER 不向插件传递账号或密码。

### 面板与频道

```js
exports.activate = function (host) {
  host.handle('runtime', () => ({ platform: process.platform, arch: process.arch }))
  host.registerPanel({ id: 'runtime', title: '运行环境', entry: 'panel.html' })
}
```

`entry` 是目录内实际存在的 HTML 相对路径，使用 `/` 分隔目录。禁止绝对路径、`.` / `..` 段、反斜杠、盘符、查询或锚点。`panels()` 返回 `{ pluginId, id, title, url }[]`，例如 `iter://plugins/my-plugin/panel.html`，路径各段会 URL 编码。

`handle(channel, fn)` 的频道名必须非空且插件内唯一。处理器收到 `iter.invoke(channel, ...args)` 的展开参数，可返回普通值或 Promise；参数、结果应支持 structured clone。不同插件可使用相同的面板 id 与频道名。面板不能在请求中选择另一个插件。

主进程 `invoke(pluginId, channel, args)` 成功返回处理器结果，失败以仅含 `{ message: string }` 的对象拒绝；未知插件、频道和无效参数有明确错误，调用最多等待 30 秒。超时不会取消处理器自己的后台操作。

### 评测模式

```js
exports.activate = function (host) {
  host.registerJudgeMode(require('./my-mode.cjs'))
}
```

模式对象支持目录识别、构建计划、编译、准备、测试运行和模式说明，无需继承基类。完整类型与示例见 [评测模式 API](judge-modes.md)。模式 id 在整个注册表中唯一。宿主以插件 manifest id 为 source 调用 `registerMode`；重载、停用、激活失败时调用 `unregisterSource`，无需插件手动反注册。注册表将来源 `builtin` 保留给内置模式，因此提供评测模式的插件不能使用这个 manifest id。

## 面板 SDK

在自己的脚本之前加载 `<script src="iter://sdk/panel.js"></script>`，即可使用全局 `window.iter` / `iter`。SDK 没有依赖；类型声明为 `resources/sdk/iter-panel.d.ts`，也可从 `iter://sdk/iter-panel.d.ts` 获取并复制到插件工程。

| API                             | 返回与行为                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `iter.onState(cb)`              | 订阅完整 `PanelState`，已有状态时立即回调；返回取消订阅函数。                                            |
| `iter.invoke(channel, ...args)` | `Promise<T>`，调用本插件 `host.handle` 的频道。                                                          |
| `iter.getSource()`              | `Promise<string \| null>`，读取包含未保存修改的编辑器文本；无活动编辑器返回 null。                       |
| `iter.insertText(text)`         | `Promise<void>`，在编辑器光标或选择位置插入文本。                                                        |
| `iter.openFile(path)`           | `Promise<void>`，通过 ITER 打开文件。                                                                    |
| `iter.runTests(ids?)`           | `Promise<void>`，请求开始评测；省略 ids 或空数组运行启用测试。请求被接受不代表评测完成，结果由状态推送。 |
| `iter.toast(text, kind?)`       | `Promise<void>`，kind 为 `info`（默认）、`success`、`error`。                                            |
| `iter.setBadge(text \| null)`   | `Promise<void>`，设置本面板标签徽标，null 清除。                                                         |

除 `onState` 外均返回 Promise，失败拒绝为 `Error`，读取 `error.message` 即可。SDK 等待每个请求最多 35 秒，比主进程频道超时略长。页面销毁后未完成请求不保证继续送达，也不自动重试。

### 完整页面示例

此 `panel.html` 与上面“面板与频道”的入口配合，展示当前文件和运行环境。生产插件也可把脚本和样式拆为相对路径文件。

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>运行环境</title>
<style>
  body { margin: 12px; background: var(--panel, #181a1f);
    color: var(--text, #c9ced6); font: 13px/1.5 var(--ui-font, sans-serif); }
  button { margin: 8px 8px 8px 0; color: var(--text, #c9ced6);
    background: var(--elevated, #1e2127); border: 1px solid var(--border, #262a31); }
</style>
<body>
  <h3 id="file">未打开文件</h3>
  <button id="refresh">读取环境</button>
  <p id="status" role="status"></p>
  <script src="iter://sdk/panel.js"></script>
  <script>
    const status = document.getElementById('status')
    const fail = error => { status.textContent = error.message }
    iter.onState(state => {
      document.getElementById('file').textContent = state.file?.name || '未打开文件'
    })
    document.getElementById('refresh').onclick = async () => {
      try {
        const runtime = await iter.invoke('runtime')
        status.textContent = runtime.platform + ' / ' + runtime.arch
      } catch (error) { fail(error) }
    }
  </script>
</body>
</html>
```

## 状态与主题

```ts
interface PanelState {
  file: { path: string; name: string } | null
  problem: unknown | null
  tests: { id: string; name: string; enabled: boolean }[]
  results: Record<string, { verdict: string; timeMs: number; memoryKb?: number }>
  debugging: boolean
  theme: { id: string; kind: 'dark' | 'light'; vars: Record<string, string> }
}
```

每次推送都是完整快照，results 按测试 id 索引。无打开文件时 file / problem 可以为 null；请接受空测试和空结果。problem 随评测模式扩展，按需检查字段。

SDK 在通知订阅者前，把 `theme.vars` 的 CSS 自定义属性写到页面 `:root`，属性名包含 `--` 前缀。主题变更时清除上次推送的属性，并设置 `data-theme`、`data-theme-kind` 和 `color-scheme`。使用这些变量即可自动跟随主题；首帧或缺少变量时使用 CSS fallback。

| 用途       | 变量                                                                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 背景       | `--bg`、`--panel`、`--elevated`、`--sunken`                                                                                                                                                                                                       |
| 边框       | `--border`、`--border-strong`                                                                                                                                                                                                                     |
| 文字       | `--text`、`--text-muted`、`--text-faint`                                                                                                                                                                                                          |
| 强调与交互 | `--accent`、`--accent-text`、`--hover`、`--selection`、`--shadow`                                                                                                                                                                                 |
| 字体       | `--ui-font`、`--ui-font-size`、`--mono`（父页面应一并推送当前有效字体变量）                                                                                                                                                                       |
| 圆角       | `--r-sm`、`--r`、`--r-lg`、`--r-island`                                                                                                                                                                                                           |
| 评测结果   | `--v-ac`、`--v-wa`、`--v-tle`、`--v-mle`、`--v-re`、`--v-ce`、`--v-pending`                                                                                                                                                                       |
| 编辑器     | `--editor-background`、`--editor-foreground`、`--editor-line-highlight`、`--editor-selection`、`--editor-cursor`、`--editor-line-number`、`--editor-line-number-active`、`--editor-indent-guide`、`--editor-bracket-match`、`--editor-debug-line` |

iframe 不会继承父页面任意 CSS 或 `@font-face`。需要字体文件时，在自己的 CSS 定义 `@font-face` 引用 `iter://fonts/<文件>`，或携带插件内字体。

## 页面与父窗口协议（渲染器契约）

双方通过 `postMessage` 通信，没有 MessagePort、握手或额外 ready 消息。父窗口在 iframe load 后立即发送当前完整状态，之后文件、题目、测试、结果、调试状态或主题变化时推送；SDK 缓存最新状态。

页面 → 父窗口：

```ts
{ type: 'iter:request', id: number, method: PanelMethod, args: unknown[] }
```

id 是 SDK 从随机起点递增的安全整数，每个页面实例独立生成。父窗口 → 页面，原样回传 id，成功与失败二选一：

```ts
{ type: 'iter:reply', id: number, ok: true, value: unknown }
{ type: 'iter:reply', id: number, ok: false, error: { message: string } }
{ type: 'iter:state', state: PanelState }
```

void 成功值可为 undefined。错误推荐发送普通 `{ message }`，SDK 也接受当前渲染器的 `error: string`；不传 Error 实例或主进程堆栈。SDK 只接收 `event.source === window.parent` 的消息，忽略未知 id、过期回复和非布尔 ok。

| method       | args                           | 父窗口行为                                                                                                                  |
| ------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `invoke`     | `[channel, ...channelArgs]`    | 用 iframe 绑定的 pluginId 调用 `plugins:invoke(pluginId, channel, channelArgs)`；第一项是频道，其余为参数数组，不额外嵌套。 |
| `getSource`  | `[]`                           | 返回当前编辑器完整文本。                                                                                                    |
| `insertText` | `[text]`                       | 向当前光标或选择位置插入。                                                                                                  |
| `openFile`   | `[path]`                       | 通过应用打开文件流程处理。                                                                                                  |
| `runTests`   | `[]` 或 `[ids]`                | 对当前文件请求评测，ids 为字符串数组。                                                                                      |
| `toast`      | `[text]` 或 `[text, kind]`     | 显示应用提示。                                                                                                              |
| `setBadge`   | `[text]`，text 为字符串或 null | 更新发送面板的标签徽标。                                                                                                    |

渲染器将 iframe 的 contentWindow 与 PanelInfo 绑定，用 `event.source` 找到发送者，检查 type / id / method / args 后分发。不要信任页面提供的 pluginId 或 panelId。沙箱 iframe 的 origin 通常是 `"null"`，不同插件也共用 `iter://plugins` 主机，origin 不能替代 source 身份校验。

回复与状态发给指定 `iframe.contentWindow`，使用 `postMessage(message, '*')` 支持不透明沙箱 origin；SDK 向 parent 同样使用 `'*'`。iframe 使用 `sandbox="allow-scripts"`，不授予 allow-same-origin、顶层导航或 Node 能力。父页面自行执行允许的操作，不向页面暴露 preload API 对象。

每次请求最多回复一次；未知方法、无活动编辑器等错误也走 ok: false。异步请求完成时确认 iframe 仍是原实例，避免旧请求作用于重新加载的面板；移除面板时清理消息映射和徽标。

## 资源与安全模型

主进程插件具有完整 Node 权限，可以读写文件、访问网络和调用 Electron。仅安装可信插件；窗口的沙箱不能限制主进程插件自身。插件可自行选择依赖和后端实现，宿主没有权限清单或能力审批流程。

面板在沙箱 iframe 中运行，没有 Node、Electron 或应用 preload，只通过桥接访问 ITER。网络服务、数据库、任意本地文件操作可在自己的 host.handle 中实现；请校验请求参数。频道隔离由父页面绑定发送 iframe 的插件身份完成。

协议仅服务当前已激活插件目录内的普通文件，检查解码后路径、Windows 盘符/ADS、空字节和真实路径，阻止穿越及目录外符号链接。提供 HTML / JS / CSS / PNG / SVG / JSON / WASM 等 MIME，未知扩展按 application/octet-stream 返回；响应带 nosniff 和 no-store。

CSP 默认禁止资源访问，只允许本插件路径的脚本、样式、图片、字体和请求，以及 iter://sdk 的脚本/请求、iter://fonts 字体。允许内联脚本/样式、WASM 编译和 data/blob 图片；禁止 eval、外部网页脚本、表单提交和对象嵌入。前端库可随插件打包，网络操作放在主进程处理器。资源路径不是对可信主进程插件的权限限制。SDK 已嵌入主进程构建产物，不依赖额外打包配置。

## 调试与发布

1. 修改入口或模块后使用插件重载，也可重启 ITER；只刷新 iframe 不会重新激活插件。
2. 检查 plugins:list 的 error 与主进程 `[plugin:<id>]` 日志；`PluginManager.getLogs(id)` 返回最近 100 行副本，尚无日志读取 IPC。
3. 在 DevTools 选择对应 iframe，检查 JS、资源请求、CSP 错误和 window.iter。404 常见于未激活或文件不存在；403 表示非法路径或越界链接。
4. 没有状态时检查 iframe load 后的首次快照；请求挂起时检查 source 映射、reply 的 id / ok 和 invoke 参数展开方式。
5. 停用时清理定时器、监听器、连接和子进程。需跨重载保留的内容写到 dataDir；不要记录源代码、Cookie、密码等敏感内容。
6. 发布插件包含 manifest、入口、静态文件和依赖，安装到用户插件目录；SDK 不需要额外安装。
