import { activate, closeFile } from '../actions/files'
import { store, useApp } from '../state/app'
import { withKey } from '../commands/registry'
import { Icon } from './Icon'
import { useTabReorder } from './useTabReorder'

export function EditorTabs() {
    const files = useApp((s) => s.files)
    const active = useApp((s) => s.activePath)
    const reorder = useTabReorder()
    if (!files.length)
        return (
            <div className="nv-tabs is-empty">
                <SideToggle />
            </div>
        )
    return (
        <div className="nv-tabs" ref={reorder.ref} {...reorder.handlers}>
            {files.map((f) => (
                <div
                    key={f.path}
                    className={`nv-tab ${f.path === active ? 'is-active' : ''}`}
                    data-path={f.path}
                    data-dragging={reorder.dragging === f.path}
                    onClick={() => activate(f.path)}
                    onAuxClick={(e) => e.button === 1 && void closeFile(f.path)}
                    title={f.path}
                >
                    <span className="nv-tab-name">{f.name}</span>
                    <button
                        className={`nv-tab-close ${f.dirty || f.missing ? 'is-dirty' : ''}`}
                        onClick={(e) => {
                            e.stopPropagation()
                            void closeFile(f.path)
                        }}
                    >
                        <span className="nv-tab-dot" />
                        <Icon name="x" size={12} />
                    </button>
                </div>
            ))}
            {reorder.marker !== null && <span className="nv-tab-insert" style={{ left: reorder.marker }} />}
            <SideToggle />
        </div>
    )
}

/** Collapse / restore the side panel; also bound to a shortcut (Ctrl+B by default). */
function SideToggle() {
    const collapsed = useApp((s) => s.sideCollapsed)
    return (
        <div className="nv-tabs-tools">
            <button
                className="nv-icon-btn"
                onClick={() => store.set({ sideCollapsed: !collapsed })}
                title={withKey(collapsed ? '显示侧栏' : '隐藏侧栏', 'app.toggleSide')}
            >
                <Icon name={collapsed ? 'panelOpen' : 'panelClose'} size={15} />
            </button>
        </div>
    )
}
