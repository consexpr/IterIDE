import { useEffect, useState } from 'react'
import type { JudgeSourceFile } from '../../../shared/problem'
import { CPP_SOURCE, interactorFilesError, MAX_INTERACTOR_FILES } from '../../../shared/interactorSource'
import { DEFAULT_CHECKER_ARGUMENTS } from '../../../shared/checkerArguments'
import { saveInteractorCode } from '../../actions/tests'
import { store, toast, useApp } from '../../state/app'
import { Modal, close } from './Modal'
import { CheckerArguments } from './CheckerArguments'

export function InteractorCodeDialog({ sourcePath }: { sourcePath: string }) {
    const current = useApp((s) => s.files.find((f) => f.path === sourcePath)?.problem?.interactor)
    const [files, setFiles] = useState<JudgeSourceFile[]>([{ name: 'interactor.cpp', code: '' }])
    const [active, setActive] = useState(0)
    const [loading, setLoading] = useState(!!current?.path)
    const [loadError, setLoadError] = useState('')
    const [binary, setBinary] = useState(false)
    const [busy, setBusy] = useState(false)
    const [args, setArgs] = useState(() => current?.args ?? DEFAULT_CHECKER_ARGUMENTS)
    const error = interactorFilesError(files)
    const disabled = busy || loading || !!loadError
    const selected = files[active]

    useEffect(() => {
        if (!current?.path) return
        let live = true
        void window.iter.problem
            .readInteractor(sourcePath)
            .then((saved) => {
                if (!live) return
                if (saved?.length) setFiles(saved)
                else setBinary(true)
            })
            .catch((e: Error) => {
                if (live) setLoadError(e.message)
            })
            .finally(() => {
                if (live) setLoading(false)
            })
        return () => {
            live = false
        }
    }, [sourcePath])

    const edit = (patch: Partial<JudgeSourceFile>): void =>
        setFiles((items) => items.map((file, index) => (index === active ? { ...file, ...patch } : file)))
    const add = (header: boolean): void => {
        const extension = header ? 'h' : 'cpp'
        let name = `helper.${extension}`
        for (let i = 2; files.some((file) => file.name.toLowerCase() === name.toLowerCase()); i++)
            name = `helper${i}.${extension}`
        setFiles([...files, { name, code: '' }])
        setActive(files.length)
    }
    const remove = (): void => {
        setFiles(files.filter((_, index) => index !== active))
        setActive(Math.max(0, active - 1))
    }
    const confirm = async (): Promise<void> => {
        const owner = store.get().dialog
        setBusy(true)
        try {
            await saveInteractorCode(files, sourcePath, args)
            if (store.get().dialog === owner) close()
        } catch (e) {
            toast((e as Error).message, 'error', 6000)
            setBusy(false)
        }
    }

    return (
        <Modal
            className="nv-checker-dialog nv-interactor-dialog"
            title="交互器"
            width={760}
            footer={
                <>
                    <button className="nv-btn is-quiet" onClick={close}>
                        取消
                    </button>
                    <button className="nv-btn is-primary" disabled={disabled || !!error} onClick={() => void confirm()}>
                        使用此交互器
                    </button>
                </>
            }
        >
            {(loadError || loading || binary) && (
                <p className={loadError ? 'nv-checker-error' : 'nv-faint'} role={loadError ? 'alert' : 'status'}>
                    {loadError || (loading ? '正在读取…' : '当前使用可执行文件，保存源码后将替换它。')}
                </p>
            )}
            <div className="nv-interactor-files" role="group" aria-label="交互器文件">
                {files.map((file, index) => (
                    <button
                        key={index}
                        className={`nv-btn is-quiet ${index === active ? 'is-active' : ''}`}
                        aria-pressed={index === active}
                        disabled={disabled}
                        onClick={() => setActive(index)}
                    >
                        {file.name || '未命名'}
                    </button>
                ))}
            </div>
            <fieldset className="nv-interactor-tools" disabled={disabled}>
                <label>
                    文件名
                    <input
                        aria-label="交互器文件名"
                        value={selected.name}
                        onChange={(e) => edit({ name: e.target.value })}
                    />
                </label>
                <button
                    className="nv-btn is-quiet"
                    disabled={files.length >= MAX_INTERACTOR_FILES}
                    onClick={() => add(false)}
                >
                    添加 CPP
                </button>
                <button
                    className="nv-btn is-quiet"
                    disabled={files.length >= MAX_INTERACTOR_FILES}
                    onClick={() => add(true)}
                >
                    添加头文件
                </button>
                <button className="nv-btn is-quiet" disabled={files.length === 1} onClick={remove}>
                    移除
                </button>
            </fieldset>
            <textarea
                aria-label="交互器源码"
                className="nv-mono-input nv-ncheck-code"
                spellCheck={false}
                disabled={disabled}
                value={selected.code}
                placeholder={CPP_SOURCE.test(selected.name) ? '在此粘贴 C++ 源码…' : '在此粘贴头文件内容…'}
                onChange={(e) => edit({ code: e.target.value })}
            />
            {error && !loading && !loadError && (
                <p className="nv-checker-error" role="status">
                    {error}
                </p>
            )}
            <CheckerArguments value={args} onChange={setArgs} disabled={disabled} ariaLabel="交互器参数顺序" />
        </Modal>
    )
}
