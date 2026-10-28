import { createRoot } from 'react-dom/client'
import { listenDebug, registerDebugHover } from './actions/debug'
import { listenJudge } from './actions/judge'
import { listenTerminal } from './actions/terminal'
import { listenAppClose } from './actions/lifecycle'
import { loadAppearance } from './actions/settings'
import { restoreSession, startSession } from './actions/session'
import { finishStartup } from './actions/startup'
import { editorRef } from './editor/instance'
import { monaco } from './editor/monaco'
import { createCppLanguageService } from './lang'
import { registerInlineCompletion } from './lang/inline'
import { store } from './state/app'
import './styles/base.css'
import './styles/layout.css'
import './styles/brand.css'
import './styles/panels.css'
import './styles/dialogs.css'
import './styles/island.css'
import { App } from './ui/App'
import { RecoveryBoundary, RecoveryScreen } from './ui/RecoveryScreen'
import { isRecovering } from './actions/recovery'

const root = createRoot(document.getElementById('root')!)

async function boot(): Promise<void> {
    await loadAppearance()

    const lang = createCppLanguageService(monaco, window.iter, {
        getSettings: () => {
            const s = store.get().settings
            return {
                semanticCompletion: s.editor.semanticCompletion,
                liveDiagnostics: s.editor.liveDiagnostics,
                flags: s.toolchain.flags,
                completion: s.editor.completion
            }
        }
    })
    editorRef.lang = lang
    registerInlineCompletion(monaco, window.iter, () => store.get().settings.editor.completion)
    store.set({ lspStatus: lang.status() })
    lang.onStatus((lspStatus) => store.set({ lspStatus }))

    listenJudge()
    listenTerminal()
    listenAppClose()
    listenDebug()
    registerDebugHover()

    root.render(
        <RecoveryBoundary>
            <App />
        </RecoveryBoundary>
    )
    if (window.iter.dev) (await import('./dev')).exposeDevHooks()
    await restoreSession()
    if (isRecovering()) return
    await finishStartup()
    await window.iter.app.rendererStatus('ready')
    if (isRecovering()) return
    startSession()
}

void boot().catch((error) => {
    console.error('[iter] renderer startup failed', error)
    root.render(<RecoveryScreen error={error} />)
})
