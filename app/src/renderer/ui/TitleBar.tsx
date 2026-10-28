import { withKey } from '../commands/registry'
import { newUntitled, openFilesDialog, showHome } from '../actions/files'
import { store, useApp } from '../state/app'
import { APP_WORDMARK } from '../../shared/brand'
import { AccountButton } from './account/AccountButton'
import { DynamicIsland } from './island/DynamicIsland'
import { Icon, Logo } from './Icon'

export function TitleBar() {
    const isMac = window.iter.app.platform === 'darwin'
    const expanded = useApp((s) => s.islandOpen)
    return (
        <header className={`nv-titlebar ${isMac ? 'is-mac' : ''}`}>
            <div className="nv-titlebar-left">
                <button className="nv-brand" onClick={showHome} title="返回主页" aria-label="返回主页">
                    <Logo size={20} expanded={expanded} />
                    <span className="nv-wordmark">{APP_WORDMARK}</span>
                </button>
                <button
                    className="nv-ghost"
                    onClick={() => void openFilesDialog()}
                    title={withKey('打开文件', 'file.open')}
                >
                    <Icon name="folder" size={14} />
                    <span>打开文件</span>
                </button>
                <button className="nv-ghost" onClick={() => void newUntitled()} title={withKey('新建文件', 'file.new')}>
                    <Icon name="plus" size={14} />
                    <span>新建文件</span>
                </button>
            </div>
            <DynamicIsland />
            <div className="nv-titlebar-right">
                <AccountButton />
                <button
                    className="nv-ghost nv-icon-btn"
                    onClick={() => store.set({ dialog: { kind: 'settings' } })}
                    title={withKey('设置', 'app.settings')}
                >
                    <Icon name="settings" size={15} />
                </button>
            </div>
        </header>
    )
}
