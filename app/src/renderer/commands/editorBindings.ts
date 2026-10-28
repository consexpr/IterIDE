import type { monaco } from '../editor/monaco'
import { toMonaco } from './accelerator'
import type { Command } from './registry'

const nativeFindBindings = [
    ['Ctrl+F', 'actions.find'],
    ['Ctrl+H', 'editor.action.startFindReplaceAction'],
    ['F3', 'editor.action.nextMatchFindAction'],
    ['Shift+F3', 'editor.action.previousMatchFindAction']
]

/** Rebuild disposable overrides; do not accumulate synthetic copies of Monaco's default bindings. */
export function editorBindingRules(
    commands: Command[],
    binding: (command: Command) => string
): monaco.editor.IKeybindingRule[] {
    const rules: monaco.editor.IKeybindingRule[] = nativeFindBindings.map(([key, command]) => ({
        keybinding: toMonaco(key)!,
        command: `-${command}`
    }))
    for (const command of commands) {
        if (command.kind !== 'editor') continue
        const value = binding(command)
        if (toMonaco(value) === toMonaco(command.key)) continue
        const original = toMonaco(command.key),
            next = toMonaco(value)
        if (original !== null) rules.push({ keybinding: original, command: `-${command.action}` })
        if (next !== null) rules.push({ keybinding: next, command: command.action, when: 'editorTextFocus' })
    }
    return rules
}
