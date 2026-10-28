// Global key handling driven by the command registry + user overrides (settings.keybindings).
import { useEffect } from 'react'
import { openExternalFiles } from '../../actions/startup'
import { fromEvent } from '../../commands/accelerator'
import { bindingOf, COMMANDS } from '../../commands/registry'
import { editorBindingRules } from '../../commands/editorBindings'
import { monaco } from '../../editor/monaco'
import { isDebugging, store, toast } from '../../state/app'

export function useGlobalShortcuts(): void {
    useEffect(() => {
        let lastApplied: Record<string, string | null> | undefined
        let bindings: monaco.IDisposable | undefined
        const applyBindings = (): void => {
            lastApplied = store.get().settings.keybindings
            bindings?.dispose()
            bindings = monaco.editor.addKeybindingRules(
                editorBindingRules(COMMANDS, (command) => bindingOf(command, lastApplied))
            )
        }
        const onKey = (e: KeyboardEvent): void => {
            if (store.get().closing) {
                e.preventDefault()
                return
            }
            if (e.isComposing || e.keyCode === 229 || (e.target as HTMLElement | null)?.closest?.('[data-key-capture]'))
                return
            const acc = fromEvent(e)
            if (!acc) return
            const cmd = COMMANDS.find(
                (c) => c.kind === 'app' && bindingOf(c) === acc && (!c.debugOnly || isDebugging())
            )
            if (!cmd || cmd.kind !== 'app') return
            const search = cmd.id.startsWith('edit.find') || cmd.id === 'edit.replace'
            if (search && (store.get().dialog || store.get().accountOpen)) return
            if (!search && (e.target as HTMLElement | null)?.closest?.('.nv-find')) return
            e.preventDefault()
            e.stopPropagation()
            if ((cmd.id === 'completion.fim' || cmd.id === 'snapshot.save' || search) && e.repeat) return
            try {
                void Promise.resolve(cmd.run()).catch((error: Error) => toast(error.message, 'error'))
            } catch (error) {
                toast((error as Error).message, 'error')
            }
        }
        // capture phase so Monaco's own bindings (e.g. Ctrl+Enter) don't win
        window.addEventListener('keydown', onKey, true)
        const offOpen = window.iter.app.onOpenFiles(openExternalFiles)
        const offNotify = window.iter.app.onNotify((m) => toast(m, 'info', 5000))
        applyBindings()
        const off = store.subscribe(() => {
            const kb = store.get().settings.keybindings
            if (kb !== lastApplied) applyBindings()
        })
        return () => {
            window.removeEventListener('keydown', onKey, true)
            offOpen()
            offNotify()
            off()
            bindings?.dispose()
        }
    }, [])
}
