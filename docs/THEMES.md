# ITER 主题开发指南

主题就是**皮肤**：功能、数据、布局逻辑都不变，主题只负责「长什么样」。
界面和主题之间的接口固定为三部分，主题只依赖它们：

1. **Tokens**：颜色、形状、编辑器配色 → 变成 CSS 变量和 Monaco 编辑器主题
2. **稳定类名**：`nv-*` 结构类（见 §4）
3. **状态属性**：`data-*`，描述当前在做什么（见 §5）

只用 tokens 能换配色；再加 CSS 可以把界面改成完全不同的风格（内置的 _Terminal 终端_ 主题就是用 CSS 做的：直角、等宽界面字体、方括号灵动岛）。

内置暖调主题还包括深色的 _Cocoa 可可_、_Tea 茶褐_，以及浅色的 _Wheat 麦纸_、_Sandstone 砂岩_，可在「设置 → 外观」直接切换。

---

## 1. 放在哪里

设置 → 外观 → 「打开主题目录」（即 `<userData>/themes/`）。两种形式：

```
themes/
  midnight.json              单文件：只有 tokens（也可以内联 "css"）
  aurora/                    主题包
    theme.json
    theme.css                可选，会自动加载
    bg.png                   CSS 里用相对路径 url("bg.png") 引用
```

保存文件后**自动热重载**，不用重启。

## 2. theme.json

只有 `id` 和 `name` 必填，其余缺省项从基础主题继承：

```json
{
    "id": "aurora",
    "name": "Aurora 极光",
    "kind": "dark",
    "extends": "iter-dusk",
    "ui": { "accent": "#7fd6c2", "panel": "#12161c" },
    "verdict": { "ac": "#7fd6a0" },
    "editor": { "background": "#0f1318" },
    "tokens": { "keyword": "#b59cf0", "comment": "#5a6678 italic" },
    "shape": { "radius": "10px", "islandRadius": "14px" }
}
```

| 字段      | 说明                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `kind`    | `dark` / `light`，决定 Monaco 基础配色与滚动条等                                                                          |
| `extends` | 继承哪个主题的 tokens（内置 id 或其它用户主题 id）；不写则继承同 `kind` 的第一个内置主题。写了 `extends` 时也继承它的 CSS |
| `cssFile` | 主题包里 CSS 的文件名，默认 `theme.css`                                                                                   |
| `css`     | 内联 CSS（单文件主题用）                                                                                                  |

内置主题 id：`iter-dusk` `iter-ember` `iter-forest` `iter-paper` `iter-mist` `iter-terminal`。

## 3. Tokens → CSS 变量

| 组                                 | 键                                                                                                                           | CSS 变量                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui`                               | bg, panel, elevated, sunken, border, borderStrong, text, textMuted, textFaint, accent, accentText, hover, selection, shadow  | `--bg` `--panel` `--elevated` `--sunken` `--border` `--border-strong` `--text` `--text-muted` `--text-faint` `--accent` `--accent-text` `--hover` `--selection` `--shadow` |
| `verdict`                          | ac, wa, tle, mle, re, ce, pending                                                                                            | `--v-ac` … `--v-pending`                                                                                                                                                   |
| `editor`                           | background, foreground, lineHighlight, selection, cursor, lineNumber, lineNumberActive, indentGuide, bracketMatch, debugLine | `--editor-background` … `--editor-debug-line`（同时写入 Monaco）                                                                                                           |
| `highlight`                        | occurrence, occurrenceWrite, selectionMatch, findCurrent, findOther, findRange                                               | Monaco 与独立查找面板的匹配高亮（见 §7）                                                                                                                                   |
| `shape`                            | radiusSm, radius, radiusLg, islandRadius                                                                                     | `--r-sm` `--r` `--r-lg` `--r-island`                                                                                                                                       |
| 字体（来自用户设置，不由主题决定） |                                                                                                                              | `--ui-font` `--mono`                                                                                                                                                       |

`tokens` 是代码高亮，键是 ITER C++ 语法的 token 类型（前缀匹配）。`macro`、`variable.*`、`namespace`、`label`、`type`、`function`、`constant` 在 clangd 可用时由语义分析决定，不依赖拼写；clangd 不可用时回退到语法着色，值为 `#rrggbb`，可附加 `italic` / `bold` / `underline`：

| token                                       | 含义                                               | 例                       |
| ------------------------------------------- | -------------------------------------------------- | ------------------------ |
| `keyword`                                   | 一般关键字                                         | `const` `struct` `using` |
| `keyword.control`                           | 控制流                                             | `for` `if` `return`      |
| `type.primitive`                            | 基础类型                                           | `int` `long` `ll`        |
| `type.stl`                                  | 常用 STL 类型                                      | `vector` `map` `pii`     |
| `function`                                  | 函数调用                                           | `sort(` `solve(`         |
| `constant`                                  | 常量（`const` 全局量、枚举项、全大写名）           | `MAXN` `INF`             |
| `macro`                                     | 宏（`#define` 出来的名字，用到的每个地方颜色一致） | `ls` `rs`                |
| `variable.local`                            | 局部变量                                           |                          |
| `variable.param`                            | 函数参数                                           |                          |
| `variable.global`                           | 全局 / 文件级变量                                  |                          |
| `variable.field`                            | 成员变量                                           |                          |
| `namespace` `label`                         | 命名空间、goto 标签                                |                          |
| `number` `string` `string.escape` `comment` |                                                    |                          |
| `preprocessor` `string.include`             | `#include <...>`                                   |                          |
| `operator` `delimiter` `identifier`         |                                                    |                          |

### 3.1 独立组件

品牌图稿使用 `app/src/shared/branding/` 下的 SVG：`iter-icon.svg` 用于应用与桌面图标，保留原配色与底色；`iter-logo.svg` 用于欢迎页，背景透明，文字通过页面的 `color-scheme` 随深浅主题切换，橙黄点缀保持原色。`components.brand` 的 `wordmarkColor`、`font` 仍可设置标题栏和登录页的文字字标；`color`、旧版折痕及动效字段保留读取兼容，不改变 SVG 图稿。标志保持静止。

`components` 可分别配置品牌、查找、快照和 checker。所有字段可省略，字段值使用 CSS 语法，继承按组件内的字段合并。旧主题无需增加字段；切换主题会清除上一主题的组件覆盖。也可以通过主题 CSS 覆盖对应变量。

| 组                     | 字段                                                                                                                                                               | 变量前缀                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `components.brand`     | color, wordmarkColor, font, creaseColor, creaseOpacity, motionDuration, motionEasing                                                                               | `--brand-`                                                    |
| `components.search`    | background, inputBackground, border, shadow, backdropFilter, radius, width, controlHeight, openDuration, closeDuration, easing, offset, scale                      | `--search-`，驼峰改为连字符，例如 `--search-input-background` |
| `components.snapshots` | background, previewBackground, selection, border, rowHeight, controlHeight, radius                                                                                 | `--snapshots-`                                                |
| `components.checker`   | background, codeBackground, argumentBackground, argumentSelection, argumentRadius, argumentDuration, argumentEasing, border, backdropFilter, controlHeight, radius | `--checker-`                                                  |

查找面板独立于顶部灵动岛，没有全屏遮罩。默认背景为 82% 的 `ui.elevated` 加 18% 透明，输入框为 55% 的 `ui.sunken` 加 45% 透明，只在自身区域使用 8px 背景模糊。背景图主题可降低填充浓度或设为 `transparent`，并单独调整模糊以维持文字可读性；不要通过整个面板的 `opacity` 调透明度，否则文字也会变淡。

查找面板默认 440px 宽、26px 控件，开合为 220ms / 150ms、5px 位移和 0.98 缩放，输入和匹配更新不重新播放。系统开启减少动态效果时直接显示/隐藏。快照默认 32px 行高、26px 控件。checker 默认继承通用弹窗、输入框和边框配色；参数胶囊在原行横向展开和收拢，默认高 26px、圆角 999px、过渡 260ms，选中填充继承 `ui.selection`，曲线继承 `--ease`。减少动态效果时直接切换，不改变行高。

```json
{
    "components": {
        "search": {
            "background": "#151b23b3",
            "inputBackground": "#0b0f1380",
            "backdropFilter": "blur(6px)",
            "openDuration": "220ms",
            "closeDuration": "150ms"
        },
        "snapshots": { "previewBackground": "#0b0f1380", "rowHeight": "30px" },
        "checker": { "argumentBackground": "#0b0f1380", "controlHeight": "26px" }
    }
}
```

## 4. 稳定类名（可以放心写选择器）

| 区域           | 类名                                                                                                                                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 根             | `.nv-app`                                                                                                                                                                                                                                                                                                                          |
| 标题栏         | `.nv-titlebar` `.nv-brand` `.nv-wordmark` `.nv-logo`                                                                                                                                                                                                                                                                               |
| 灵动岛         | `.nvi`（胶囊本体）`.nvi-layer` `.nvi-title` `.nvi-meta` `.nvi-tag` `.nvi-led` `.nvi-ring` `.nvi-result-title` `.nvi-result-sub` `.nvi-line` `.nvi-btn`；CSS 变量 `--island-bg` `--island-fg` `--island-dim` `--island-btn` `--island-btn-hover`                                                                                    |
| 灵动岛展开面板 | `.nvi-panel`（面板）`.nvi-bar`（模式选择那一行）`.nvi-seg` `.nvi-chips`（`data-group="layout"` 空白处理 / `data-group="value"` 数值比较）`.nvi-params`（时间、内存、文件 IO、链接）`.nvi-io` `.nvi-file`；疏密变量 `--island-pad`（面板内边距）`--island-gap`（行间距）`--island-ctl`（控件高度）`--island-ctl-radius`（控件圆角） |
| 编辑区         | `.nv-center` `.nv-tabs` `.nv-tab`（`.is-active`）`.nv-tab-insert`（拖动插入线，继承 `ui.accent`）`.nv-editor` `.nv-welcome`                                                                                                                                                                                                        |
| 查找/替换      | `.nv-find` `.nv-find-row` `.nv-find-options` `.nv-find-count` `.nv-find-error` `.nv-search-match`（`.is-current`）                                                                                                                                                                                                                 |
| 快照           | `.nv-snapshots` `.nv-snapshots-toolbar` `.nv-snapshot-save` `.nv-snapshot-row`（`.is-selected`）`.nv-snapshot-actions` `.nv-snapshot-code`                                                                                                                                                                                         |
| checker 编辑   | `.nv-checker-dialog` `.nv-checker-args` `.nv-checker-arg` `.nv-checker-picker` `.nv-ncheck-code`                                                                                                                                                                                                                                   |
| 侧栏           | `.nv-side` `.nv-side-tabs` `.nv-judge` `.nv-judge-actions` `.nv-summary` `.nv-compile`                                                                                                                                                                                                                                             |
| 测试点         | `.nv-test` `.nv-test-head` `.nv-test-body` `.nv-verdict` `.nv-io` `.nv-io-label` `.nv-io-text` `.nv-diff` `.nv-checker`                                                                                                                                                                                                            |
| 调试           | `.nv-debug` `.nv-dsec` `.nv-var` `.nv-var-name` `.nv-var-value` `.nv-frame` `.nv-debug-stream`                                                                                                                                                                                                                                     |
| 编辑器装饰     | `.nv-bp`（断点）`.nv-debug-line`（暂停行）`.nv-debug-arrow`                                                                                                                                                                                                                                                                        |
| 题目列表       | `.nv-explorer` `.nv-tree-row`（`.is-active`）                                                                                                                                                                                                                                                                                      |
| 通用           | `.nv-btn`（`.is-primary` `.is-quiet`）`.nv-chip` `.nv-dot` `.nv-modal` `.nv-toast` `.nv-status`                                                                                                                                                                                                                                    |

这些类名属于对外接口：**改名或删除要同步更新本文档**。未列出的类名可能随版本变化。

## 5. 状态属性

| 元素                          | 属性                                       | 取值                                                                            |
| ----------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------- |
| `html`                        | `data-theme`                               | 当前主题 id                                                                     |
| `html`                        | `data-kind`                                | `dark` / `light`                                                                |
| `.nv-logo`                    | `data-expanded`                            | `true` / `false`，保留标题栏展开状态，默认标志不随状态变形                      |
| `.nv-app`                     | `data-debug`                               | `idle` `starting` `running` `paused` `exited` `error`                           |
| `.nvi`                        | `data-state`                               | `empty` `idle` `compiling` `running` `result` `debug`                           |
| `.nvi`                        | `data-tone`                                | 结果弹出时 `ac` `wa` `tle` …；调试时 `debug` / `crash`                          |
| `.nv-test`                    | `data-verdict`                             | `NONE` `PENDING` `RUNNING` `AC` `WA` `PE` `TLE` `MLE` `RE` `OLE` `CE` `SE` `NA` |
| `.nv-side`                    | `data-view`                                | `tests` `debug` `snapshots` 或 `plugin:…`                                       |
| `.nv-tab`                     | `data-dragging`                            | `true` / `false`，当前拖动的标签                                                |
| `.nv-find`                    | `data-state` / `data-regex` / `data-error` | `open` / `closing`；后两项为 `true` / `false`                                   |
| `.nv-snapshots`               | `data-busy` / `data-empty`                 | `true` / `false`                                                                |
| `.nv-checker-args`            | `data-count`                               | 文件参数数量，高级模板不提供此属性                                              |
| `.nv-checker-picker`          | `data-expanded`                            | `true` / `false`，同一行最多展开一个                                            |
| `.nv-checker-picker > button` | `aria-pressed`                             | `true` / `false`，当前参数；方向键移动焦点，Enter / 空格确认，Esc 收拢          |

## 6. 例子

```css
/* 调试暂停时，灵动岛描一圈强调色细边 */
.nv-app[data-debug='paused'] .nvi {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent);
}

/* 灵动岛改成主题色而不是纯黑 */
:root {
    --island-bg: var(--elevated);
    --island-fg: var(--text);
}

/* WA 的测试点卡片左侧加色条 */
.nv-test[data-verdict='WA'] {
    box-shadow: inset 3px 0 0 var(--v-wa);
}

/* 编辑区背景图（主题包内的图片） */
.nv-center {
    background: url('bg.png') center / cover;
}
```

完整的示例主题包：[docs/theme-examples/aurora](theme-examples/aurora)，复制到主题目录即可。

## 7. 高亮与对比度

高亮颜色和各类代码颜色（`tokens`）**全部由主题决定**，ITER 不会替你推导、调整或兜底。写主题时请自己保证对比度，下面是要求。

### 高亮写在 `highlight`

只用填充色区分，**不用边框、下划线**（ITER 会把所有高亮边框设为透明）。颜色可以写 `#rrggbbaa`，叠在编辑器背景上。

| 键                          | 用于                         |
| --------------------------- | ---------------------------- |
| `editor.selection`          | **选中的那一处**（实心底色） |
| `highlight.occurrence`      | 光标所在词的其他出现处       |
| `highlight.occurrenceWrite` | 其中被赋值（写入）的出现处   |
| `highlight.selectionMatch`  | 选中文字的其他相同文字       |
| `highlight.findCurrent`     | 当前查找匹配（Ctrl+F）       |
| `highlight.findOther`       | 其余查找匹配                 |
| `highlight.findRange`       | 限定的查找范围               |

背景是中等亮度（例如带图片的绿底）时，把填充做浅会既看不出来又拉低文字对比度，**往更深的方向调**更容易同时满足两条。选中的那一处和其他出现处必须**颜色不同**：内置主题的做法是选区用带强调色倾向的实心色，其余出现处用前景色的淡色（中性色调），一眼能分开。

### 对比度要求

| 要求                                                                                   | 最低对比度     | 原因                               |
| -------------------------------------------------------------------------------------- | -------------- | ---------------------------------- |
| `editor.foreground` 与 `editor.background`                                             | 7:1            | 正文                               |
| `tokens` 中除 `comment` 外的各颜色与 `editor.background`                               | 4.5:1          | 代码                               |
| `tokens` 中 `comment` 与 `editor.background`                                           | 3:1            | 注释可以弱一些，但要读得出         |
| `editor.selection` 与 `editor.background`                                              | 1.4:1          | 选区要看得出                       |
| `editor.foreground` 与 `editor.selection`                                              | 4.5:1          | 选中后文字仍然清楚                 |
| 各 `tokens` 颜色与 `editor.selection`                                                  | 3:1            | 选中后高亮的代码仍然清楚           |
| 各 `highlight.*` 填充（叠在背景上之后）与 `editor.foreground` 及各非注释 `tokens` 颜色 | 3:1            | 高亮不能盖住代码                   |
| 各 `highlight.*` 填充（叠在背景上之后）与 `editor.background`                          | 1.2:1          | 填充要看得出来；太淡会等于没有高亮 |
| `editor.selection` 与 `highlight.occurrence`（叠加后）                                 | 颜色有明显差别 | 选中处和其他出现处要分得开         |
| `editor.lineHighlight` 与 `editor.background`                                          | 1.03:1         | 当前行可辨认，但不要抢眼           |

`editor.lineHighlight`、`editor.bracketMatch` 同样完全由主题决定。颜色可以写成 `#rgb`、`#rrggbb`、`#rrggbbaa`、`rgb()` 或 `rgba()`；带透明度的颜色按不透明部分计算对比度，所以选区请直接用不透明色。

通过 `extends` 继承时，`highlight` 和 `tokens` 会一并继承。**如果你改了背景或 `tokens`，请同时重写 `highlight`**，否则继承来的填充色是按原主题调的。内置主题的 `builtin.contrast.test.ts` 和 `highlight.test.ts` 按上表检查，自己的主题可以参照这两个测试。

## 8. 约定

- 对比度要求见上一节；注释可以低一些，但不要低于 3:1。
- 判定颜色在各主题中的含义保持一致：AC 绿、WA 红、TLE 黄。
- 不要用 CSS 隐藏功能性的元素（按钮、判定徽章）；主题只换样子。
- 以长时间看着不累为准：避免大面积发光、霓虹描边、高饱和背景和持续闪烁的动画。
- 主题 CSS 在所有内置样式之后加载，一般不需要 `!important`。
