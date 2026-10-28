import { lazy, Suspense } from 'react'
import { useApp } from '../state/app'
import { Dialogs } from './dialogs/Dialogs'
import { EditorPane } from './EditorPane'
import { EditorTabs } from './EditorTabs'
import { useFileDrop } from './shell/drop'
import { useGlobalShortcuts } from './shell/keymap'
import { Resizer } from './shell/Resizer'
import { SidePanel } from './SidePanel'
import { StatusBar } from './StatusBar'
import { TitleBar } from './TitleBar'
import { Toasts } from './Toasts'
import { store } from '../state/app'

const AccountPage = lazy(() => import('./account/AccountPage').then((module) => ({ default: module.AccountPage })))

export function App() {
    useGlobalShortcuts()
    const drop = useFileDrop()
    const dragOver = useApp((s) => s.dragOver)
    const debug = useApp((s) => s.debug.state.status)
    const sideCollapsed = useApp((s) => s.sideCollapsed)
    const accountOpen = useApp((s) => s.accountOpen)
    const closing = useApp((s) => s.closing)
    return (
        <div
            className="nv-app"
            inert={closing}
            data-debug={debug}
            data-side={sideCollapsed ? 'collapsed' : 'open'}
            {...drop}
        >
            <TitleBar />
            <main className="nv-main">
                <section className="nv-center">
                    <EditorTabs />
                    <EditorPane />
                </section>
                <Resizer />
                <SidePanel />
            </main>
            <StatusBar />
            {dragOver && (
                <div className="nv-drop">
                    <b>松开以导入</b>
                </div>
            )}
            <Dialogs />
            {accountOpen && (
                <Suspense
                    fallback={
                        <div className="nv-backdrop">
                            <section className="nv-loading-account" role="status">
                                正在加载账号页面…{' '}
                                <button className="nv-btn" onClick={() => store.set({ accountOpen: false })}>
                                    取消
                                </button>
                            </section>
                        </div>
                    }
                >
                    <AccountPage />
                </Suspense>
            )}
            <Toasts />
        </div>
    )
}
