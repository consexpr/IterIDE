import { APP_NAME } from '../../shared/brand'
// Every rebindable command, in one table. App commands run through the global key handler;
// editor commands are Monaco actions whose keybindings get rewritten when the user overrides them.
import {
    addWatchFromEditor,
    clearAllBreakpoints,
    continueDebug,
    debugCommand,
    editBreakpointAtCursor,
    runToCursor,
    startDebug,
    toggleBreakpoint
} from '../actions/debug'
import { closeFile, newUntitled, openFilesDialog, saveFile } from '../actions/files'
import { runTests, stopRun } from '../actions/judge'
import { runTerminal, stopTerminal } from '../actions/terminal'
import { addTest } from '../actions/tests'
import { editorRef } from '../editor/instance'
import { isDebugging, store } from '../state/app'
import { selectedTest } from '../actions/testSelection'
import { toggleIsland } from '../ui/island/state'
import { fimShortcut } from '../actions/inline'
import { normalize } from './accelerator'
import { saveSnapshot } from '../actions/snapshots'
import { openSearch, nextSearchMatch } from '../editor/search'

export type CommandGroup = '运行' | '调试' | '文件' | '编辑'

interface Base {
    id: string
    label: string
    group: CommandGroup
    /** Default accelerator ('' = none). */
    key: string
}
export interface AppCommand extends Base {
    kind: 'app'
    run: () => unknown
    /** Only active while a debug session runs (so F10/F11 stay free otherwise). */
    debugOnly?: boolean
}
export interface EditorCommand extends Base {
    kind: 'editor'
    /** Monaco action id; `key` must equal Monaco's own default so it can be unbound. */
    action: string
}
export type Command = AppCommand | EditorCommand

const toggleBpAtCursor = (): void => {
    const line = editorRef.editor?.getPosition()?.lineNumber
    if (line) toggleBreakpoint(line)
}

export const COMMANDS: Command[] = [
    { kind: 'app', id: 'completion.fim', label: 'FIM 单次补全', group: '编辑', key: 'Alt+F', run: fimShortcut },
    { kind: 'app', id: 'run.all', label: '运行全部测试', group: '运行', key: 'Ctrl+Enter', run: () => runTests() },
    {
        kind: 'app',
        id: 'run.allAlt',
        label: '运行全部测试（备用）',
        group: '运行',
        key: 'Ctrl+R',
        run: () => runTests()
    },
    {
        kind: 'app',
        id: 'run.stop',
        label: '停止运行',
        group: '运行',
        key: 'Ctrl+Shift+C',
        run: () => Promise.all([stopRun(), stopTerminal()])
    },
    { kind: 'app', id: 'run.terminal', label: '终端运行', group: '运行', key: 'Ctrl+F5', run: () => runTerminal() },
    { kind: 'app', id: 'run.addTest', label: '添加测试点', group: '运行', key: 'Ctrl+Shift+T', run: () => addTest() },

    {
        kind: 'app',
        id: 'debug.start',
        label: '开始调试 / 继续',
        group: '调试',
        key: 'F5',
        run: () => (isDebugging() ? debugCommand('continue') : startDebug(selectedTest()))
    },
    {
        kind: 'app',
        id: 'debug.stop',
        label: '结束调试',
        group: '调试',
        key: 'Shift+F5',
        run: () => debugCommand('stop')
    },
    {
        kind: 'app',
        id: 'debug.restart',
        label: '重新开始',
        group: '调试',
        key: 'Ctrl+Shift+F5',
        run: () => debugCommand('restart')
    },
    { kind: 'app', id: 'debug.breakpoint', label: '切换断点', group: '调试', key: 'F9', run: toggleBpAtCursor },
    {
        kind: 'app',
        id: 'debug.next',
        label: '下一行',
        group: '调试',
        key: 'F10',
        debugOnly: true,
        run: () => debugCommand('stepOver')
    },
    {
        kind: 'app',
        id: 'debug.back',
        label: '上一步',
        group: '调试',
        key: 'Shift+F10',
        debugOnly: true,
        run: () => debugCommand('stepBack')
    },
    {
        kind: 'app',
        id: 'debug.in',
        label: '步入',
        group: '调试',
        key: 'F11',
        debugOnly: true,
        run: () => debugCommand('stepIn')
    },
    {
        kind: 'app',
        id: 'debug.out',
        label: '步出',
        group: '调试',
        key: 'Shift+F11',
        debugOnly: true,
        run: () => debugCommand('stepOut')
    },
    {
        kind: 'app',
        id: 'debug.runToCursor',
        label: '执行到光标处',
        group: '调试',
        key: 'Ctrl+F10',
        run: () => runToCursor()
    },
    {
        kind: 'app',
        id: 'debug.continue',
        label: '继续执行',
        group: '调试',
        key: '',
        debugOnly: true,
        run: continueDebug
    },
    {
        kind: 'app',
        id: 'debug.pause',
        label: '中断',
        group: '调试',
        key: '',
        debugOnly: true,
        run: () => debugCommand('pause')
    },
    { kind: 'app', id: 'debug.addWatch', label: '添加监视', group: '调试', key: '', run: addWatchFromEditor },
    {
        kind: 'app',
        id: 'debug.breakpointProps',
        label: '断点属性',
        group: '调试',
        key: '',
        run: editBreakpointAtCursor
    },
    {
        kind: 'app',
        id: 'debug.clearBreakpoints',
        label: '清除全部断点',
        group: '调试',
        key: '',
        run: clearAllBreakpoints
    },

    { kind: 'app', id: 'file.new', label: '新建文件', group: '文件', key: 'Ctrl+N', run: () => newUntitled() },
    { kind: 'app', id: 'file.open', label: '打开文件', group: '文件', key: 'Ctrl+O', run: openFilesDialog },
    { kind: 'app', id: 'file.save', label: '保存', group: '文件', key: 'Ctrl+S', run: () => saveFile() },
    { kind: 'app', id: 'snapshot.save', label: '保存代码快照', group: '文件', key: 'Ctrl+Alt+S', run: saveSnapshot },
    {
        kind: 'app',
        id: 'file.close',
        label: '关闭标签',
        group: '文件',
        key: 'Ctrl+W',
        run: () => store.get().activePath && closeFile(store.get().activePath!)
    },
    {
        kind: 'app',
        id: 'app.settings',
        label: '设置',
        group: '文件',
        key: 'Ctrl+,',
        run: () => store.set({ dialog: { kind: 'settings' } })
    },
    {
        kind: 'app',
        id: 'app.problem',
        label: '评测设置',
        group: '文件',
        key: 'Ctrl+Shift+P',
        run: () => store.get().activePath && toggleIsland()
    },
    {
        kind: 'app',
        id: 'app.toggleSide',
        label: '显示 / 隐藏侧栏',
        group: '文件',
        key: 'Ctrl+B',
        run: () => store.set((s) => ({ sideCollapsed: !s.sideCollapsed }))
    },

    {
        kind: 'editor',
        id: 'edit.comment',
        label: '切换行注释',
        group: '编辑',
        key: 'Ctrl+/',
        action: 'editor.action.commentLine'
    },
    {
        kind: 'editor',
        id: 'edit.blockComment',
        label: '切换块注释',
        group: '编辑',
        key: 'Shift+Alt+A',
        action: 'editor.action.blockComment'
    },
    {
        kind: 'editor',
        id: 'edit.format',
        label: '格式化代码',
        group: '编辑',
        key: 'Shift+Alt+F',
        action: 'editor.action.formatDocument'
    },
    {
        kind: 'editor',
        id: 'edit.copyLineDown',
        label: '向下复制行',
        group: '编辑',
        key: 'Shift+Alt+Down',
        action: 'editor.action.copyLinesDownAction'
    },
    {
        kind: 'editor',
        id: 'edit.moveLineUp',
        label: '上移行',
        group: '编辑',
        key: 'Alt+Up',
        action: 'editor.action.moveLinesUpAction'
    },
    {
        kind: 'editor',
        id: 'edit.moveLineDown',
        label: '下移行',
        group: '编辑',
        key: 'Alt+Down',
        action: 'editor.action.moveLinesDownAction'
    },
    {
        kind: 'editor',
        id: 'edit.deleteLine',
        label: '删除行',
        group: '编辑',
        key: 'Ctrl+Shift+K',
        action: 'editor.action.deleteLines'
    },
    {
        kind: 'editor',
        id: 'edit.suggest',
        label: '触发补全',
        group: '编辑',
        key: 'Ctrl+Space',
        action: 'editor.action.triggerSuggest'
    },
    {
        kind: 'editor',
        id: 'edit.selectNext',
        label: '选中下一个相同词',
        group: '编辑',
        key: 'Ctrl+D',
        action: 'editor.action.addSelectionToNextFindMatch'
    },
    { kind: 'app', id: 'edit.find', label: '查找', group: '编辑', key: 'Ctrl+F', run: () => openSearch() },
    {
        kind: 'app',
        id: 'edit.replace',
        label: '替换',
        group: '编辑',
        key: 'Ctrl+H',
        run: () => openSearch('replace')
    },
    { kind: 'app', id: 'edit.findNext', label: '下一个匹配', group: '编辑', key: 'F3', run: () => nextSearchMatch(1) },
    {
        kind: 'app',
        id: 'edit.findPrevious',
        label: '上一个匹配',
        group: '编辑',
        key: 'Shift+F3',
        run: () => nextSearchMatch(-1)
    },
    {
        kind: 'editor',
        id: 'edit.gotoLine',
        label: '跳转到行',
        group: '编辑',
        key: 'Ctrl+G',
        action: 'editor.action.gotoLine'
    },
    {
        kind: 'editor',
        id: 'edit.rename',
        label: '重命名符号',
        group: '编辑',
        key: 'F2',
        action: 'editor.action.rename'
    },
    {
        kind: 'editor',
        id: 'edit.definition',
        label: '转到定义',
        group: '编辑',
        key: 'F12',
        action: 'editor.action.revealDefinition'
    }
]

/** The accelerator currently bound to a command (override, else default). */
export function bindingOf(
    cmd: Command,
    overrides: Record<string, string | null> = store.get().settings.keybindings
): string {
    const o = overrides[cmd.id]
    return normalize(o === null || o === undefined ? cmd.key : o)
}

/** Commands sharing `acc` with `except` (for conflict warnings). */
export function conflicts(acc: string, except: string): Command[] {
    if (!acc) return []
    return COMMANDS.filter((c) => c.id !== except && bindingOf(c) === acc)
}

/** Display label of a command's current shortcut ('' when unbound), e.g. for tooltips. */
export function keyLabel(id: string): string {
    const c = COMMANDS.find((x) => x.id === id)
    return c ? bindingOf(c).split('+').join(' ') : ''
}

/** "运行全部 (Ctrl Enter)" style tooltip. */
export const withKey = (label: string, id: string): string => (keyLabel(id) ? `${label} (${keyLabel(id)})` : label)

/** Key presets: a set of overrides applied in one click (settings → shortcuts). */
export const KEY_PRESETS: { id: string; label: string; keys: Record<string, string> }[] = [
    { id: 'default', label: `${APP_NAME} 默认`, keys: {} },
    {
        id: 'redpanda',
        label: '小熊猫 C++',
        keys: {
            'debug.start': 'F5',
            'debug.next': 'F8',
            'debug.in': 'F7',
            'debug.out': 'Ctrl+F8',
            'debug.runToCursor': 'Ctrl+F5',
            'debug.continue': 'F4',
            'debug.stop': 'F6',
            'debug.breakpoint': 'Ctrl+F4',
            'debug.back': 'Shift+F8',
            'run.all': 'F11'
        }
    }
]
