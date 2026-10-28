import { lazy, Suspense, type ReactNode } from 'react'
import { useApp } from '../../state/app'
import { Modal } from './Modal'

const ImportDialog = lazy(() => import('./ImportDialog').then((module) => ({ default: module.ImportDialog })))
const CheckerCodeDialog = lazy(() =>
    import('./CheckerCodeDialog').then((module) => ({ default: module.CheckerCodeDialog }))
)
const InteractorCodeDialog = lazy(() =>
    import('./InteractorCodeDialog').then((module) => ({ default: module.InteractorCodeDialog }))
)
const PickSourceDialog = lazy(() =>
    import('./PickSourceDialog').then((module) => ({ default: module.PickSourceDialog }))
)
const SettingsDialog = lazy(() => import('./SettingsDialog').then((module) => ({ default: module.SettingsDialog })))

/** At most one modal at a time, chosen by `state.dialog`. */
export function Dialogs() {
    const d = useApp((s) => s.dialog)
    let content: ReactNode
    switch (d?.kind) {
        case 'import':
            content = <ImportDialog preview={d.preview} sourcePath={d.sourcePath} />
            break
        case 'settings':
            content = <SettingsDialog />
            break
        case 'pickSource':
            content = <PickSourceDialog problem={d.problem} />
            break
        case 'checkerCode':
            content = <CheckerCodeDialog sourcePath={d.sourcePath} />
            break
        case 'interactorCode':
            content = <InteractorCodeDialog sourcePath={d.sourcePath} />
            break
        default:
            return null
    }
    return (
        <Suspense
            fallback={
                <Modal title="正在打开">
                    <p role="status">正在加载…</p>
                </Modal>
            }
        >
            {content}
        </Suspense>
    )
}
