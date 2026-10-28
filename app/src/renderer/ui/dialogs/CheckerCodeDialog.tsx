import { useEffect, useMemo, useState } from 'react'
import { N_CHECK_TEMPLATE } from '../../../shared/nCheck'
import { inspectCheckerSource } from '../../../shared/checkerSource'
import { DEFAULT_CHECKER_ARGUMENTS } from '../../../shared/checkerArguments'
import { saveCheckerCode } from '../../actions/tests'
import { toast, useApp } from '../../state/app'
import { Modal, close } from './Modal'
import { CheckerArguments } from './CheckerArguments'

/** Pasted checker code shares the same automatic recognition as attached source files. */
export function CheckerCodeDialog({ sourcePath }: { sourcePath: string }) {
    const current = useApp((s) => s.files.find((f) => f.path === sourcePath)?.problem?.checker)
    const [code, setCode] = useState<string | null>(current?.path ? '' : N_CHECK_TEMPLATE)
    const [loading, setLoading] = useState(!!current?.path)
    const [loadError, setLoadError] = useState('')
    const [busy, setBusy] = useState(false)
    const [args, setArgs] = useState(() => current?.args ?? DEFAULT_CHECKER_ARGUMENTS)
    const protocol = useMemo(() => inspectCheckerSource(code ?? ''), [code])

    useEffect(() => {
        if (!current?.path) return
        let live = true
        void window.iter.problem
            .readChecker(sourcePath)
            .then((saved) => {
                if (live) setCode(saved)
            })
            .catch((error: Error) => {
                if (live) setLoadError(error.message)
            })
            .finally(() => {
                if (live) setLoading(false)
            })
        return () => {
            live = false
        }
        // only the first read matters: the textarea owns the text afterwards
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const confirm = async (): Promise<void> => {
        setBusy(true)
        try {
            await saveCheckerCode(code, sourcePath, args)
            close()
        } catch (e) {
            toast((e as Error).message, 'error', 6000)
            setBusy(false)
        }
    }

    return (
        <Modal
            className="nv-checker-dialog"
            title="checker"
            width={640}
            footer={
                <>
                    <button className="nv-btn is-quiet" onClick={close}>
                        取消
                    </button>
                    <button
                        className="nv-btn is-primary"
                        disabled={
                            busy ||
                            loading ||
                            !!loadError ||
                            (code !== null && (!code.trim() || protocol.kind === 'invalid'))
                        }
                        onClick={() => void confirm()}
                    >
                        使用此 checker
                    </button>
                </>
            }
        >
            {loadError ? (
                <p className="nv-checker-error" role="alert">
                    {loadError}
                </p>
            ) : (
                <p className="nv-faint" role="status">
                    {loading
                        ? '正在读取…'
                        : code === null
                          ? current?.path?.split(/[\\/]/).pop()
                          : protocol.kind === 'testlib' || protocol.kind === 'n-check'
                            ? `已识别：${protocol.label}`
                            : protocol.message}
                </p>
            )}
            <CheckerArguments value={args} onChange={setArgs} disabled={busy || loading || !!loadError} />
            <textarea
                aria-label="Checker 源码"
                className="nv-mono-input nv-ncheck-code"
                spellCheck={false}
                disabled={busy || loading || !!loadError}
                value={code ?? ''}
                onChange={(e) => setCode(e.target.value)}
            />
        </Modal>
    )
}
