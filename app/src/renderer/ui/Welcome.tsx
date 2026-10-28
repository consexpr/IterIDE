import { APP_WORDMARK } from '../../shared/brand'
import wordmark from '../../shared/branding/iter-logo.svg'
import { keyLabel } from '../commands/registry'
import { newUntitled, openFile, openFilesDialog } from '../actions/files'
import { updateSettings } from '../actions/settings'
import { useApp } from '../state/app'
import { Icon } from './Icon'

const setRecent = (recentFiles: string[]): void => void updateSettings({ recentFiles })

export function Welcome() {
    const recent = useApp((s) => s.settings.recentFiles)
    return (
        <div className="nv-welcome">
            <div className="nv-welcome-inner">
                <div className="nv-welcome-brand">
                    <h1 className="nv-welcome-wordmark">
                        <img src={wordmark} width={250} height={121} alt={APP_WORDMARK} draggable={false} />
                    </h1>
                </div>
                <div className="nv-welcome-actions">
                    <button className="nv-tile" onClick={() => void newUntitled()}>
                        <Icon name="plus" size={18} />
                        <span>新建文件</span>
                        {keyLabel('file.new') && <kbd>{keyLabel('file.new')}</kbd>}
                    </button>
                    <button className="nv-tile" onClick={() => void openFilesDialog()}>
                        <Icon name="folder" size={18} />
                        <span>打开文件</span>
                        {keyLabel('file.open') && <kbd>{keyLabel('file.open')}</kbd>}
                    </button>
                </div>
                {recent.length > 0 && (
                    <div className="nv-welcome-recent">
                        <div className="nv-welcome-recent-head">
                            <h2>最近</h2>
                            <button className="nv-recent-clear" onClick={() => setRecent([])}>
                                清空
                            </button>
                        </div>
                        {recent.slice(0, 8).map((p) => (
                            <div
                                key={p}
                                className="nv-recent"
                                role="button"
                                tabIndex={0}
                                onClick={() => void openFile(p)}
                                title={p}
                            >
                                <Icon name="file" size={14} />
                                <span className="nv-recent-name">{p.split(/[\\/]/).pop()}</span>
                                <span className="nv-recent-path">{p.replace(/[\\/][^\\/]*$/, '')}</span>
                                <button
                                    className="nv-icon-btn nv-recent-remove"
                                    title="从列表移除"
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setRecent(recent.filter((x) => x !== p))
                                    }}
                                >
                                    <Icon name="x" size={11} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}
