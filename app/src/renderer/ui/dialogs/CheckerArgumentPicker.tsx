import { useEffect, useLayoutEffect, useRef } from 'react'
import { CHECKER_ARGUMENTS } from '../../../shared/checkerArguments'

/** The same three buttons expand in place; CSS preserves motion when an interaction reverses it. */
export function CheckerArgumentPicker({
    value,
    onChange,
    expanded,
    onExpandedChange,
    disabled,
    label
}: {
    value: string
    onChange(value: string): void
    expanded: boolean
    onExpandedChange(expanded: boolean): void
    disabled: boolean
    label: string
}) {
    const root = useRef<HTMLDivElement>(null)
    const buttons = useRef<Array<HTMLButtonElement | null>>([])
    const selected = CHECKER_ARGUMENTS.findIndex((item) => item.value === value)
    const collapse = (): void => {
        buttons.current[selected]?.focus()
        onExpandedChange(false)
    }

    useLayoutEffect(() => {
        if (expanded) buttons.current[selected]?.focus()
    }, [expanded, selected])
    useEffect(() => {
        if (!expanded) return
        const outside = (event: PointerEvent): void => {
            if (event.target instanceof Node && !root.current?.contains(event.target)) onExpandedChange(false)
        }
        document.addEventListener('pointerdown', outside)
        return () => document.removeEventListener('pointerdown', outside)
    }, [expanded, onExpandedChange])

    return (
        <div
            ref={root}
            className="nv-checker-picker"
            role="group"
            aria-label={label}
            data-expanded={expanded}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) onExpandedChange(false)
            }}
            onKeyDown={(event) => {
                if (disabled || event.nativeEvent.isComposing || event.keyCode === 229) return
                if (event.key === 'Escape' && expanded) {
                    event.preventDefault()
                    event.stopPropagation()
                    collapse()
                } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault()
                    event.stopPropagation()
                    if (!expanded) {
                        onExpandedChange(true)
                        return
                    }
                    const at = buttons.current.indexOf(document.activeElement as HTMLButtonElement)
                    const next =
                        event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? CHECKER_ARGUMENTS.length - 1
                              : (at + (event.key === 'ArrowRight' ? 1 : -1) + CHECKER_ARGUMENTS.length) %
                                CHECKER_ARGUMENTS.length
                    buttons.current[next]?.focus()
                }
            }}
        >
            {CHECKER_ARGUMENTS.map((item, index) => (
                <button
                    ref={(node) => {
                        buttons.current[index] = node
                    }}
                    type="button"
                    key={item.value}
                    aria-pressed={item.value === value}
                    aria-expanded={item.value === value ? expanded : undefined}
                    aria-hidden={!expanded && item.value !== value}
                    inert={!expanded && item.value !== value}
                    tabIndex={item.value === value ? 0 : -1}
                    disabled={disabled}
                    onClick={() => {
                        if (!expanded) return onExpandedChange(true)
                        buttons.current[index]?.focus()
                        onChange(item.value)
                        onExpandedChange(false)
                    }}
                >
                    <span>{item.label}</span>
                </button>
            ))}
        </div>
    )
}
