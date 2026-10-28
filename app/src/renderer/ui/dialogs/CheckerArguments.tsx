import { useEffect, useState } from 'react'
import { CHECKER_ARGUMENTS, checkerArgumentSlots } from '../../../shared/checkerArguments'
import { Icon } from '../Icon'
import { CheckerArgumentPicker } from './CheckerArgumentPicker'

export function CheckerArguments({
    value,
    onChange,
    disabled,
    ariaLabel = 'Checker 参数顺序'
}: {
    value: string
    onChange(value: string): void
    disabled: boolean
    ariaLabel?: string
}) {
    const slots = checkerArgumentSlots(value)
    const [expanded, setExpanded] = useState<number | null>(null)
    useEffect(() => setExpanded(null), [value, disabled])
    return (
        <div className="nv-checker-args" data-count={slots?.length} role="group" aria-label={ariaLabel}>
            <span className="nv-faint">参数</span>
            {slots ? (
                <>
                    {slots.map((slot, index) => (
                        <div className="nv-checker-arg" key={index}>
                            <span className="nv-faint">{index + 1}</span>
                            <CheckerArgumentPicker
                                value={slot}
                                label={`第 ${index + 1} 个参数`}
                                disabled={disabled}
                                expanded={!disabled && expanded === index}
                                onExpandedChange={(open) =>
                                    setExpanded((current) => (open ? index : current === index ? null : current))
                                }
                                onChange={(value) =>
                                    onChange(slots.map((old, at) => (at === index ? value : old)).join(' '))
                                }
                            />
                            <button
                                className="nv-icon-btn"
                                disabled={disabled}
                                title={`移除第 ${index + 1} 个参数`}
                                aria-label={`移除第 ${index + 1} 个参数`}
                                onClick={() => onChange(slots.filter((_, at) => at !== index).join(' '))}
                            >
                                <Icon name="x" size={12} />
                            </button>
                        </div>
                    ))}
                    <button
                        className="nv-icon-btn"
                        disabled={disabled}
                        title="添加参数"
                        aria-label="添加参数"
                        onClick={() =>
                            onChange(
                                [
                                    ...slots,
                                    CHECKER_ARGUMENTS.find((arg) => !slots.includes(arg.value))?.value ?? '{input}'
                                ].join(' ')
                            )
                        }
                    >
                        <Icon name="plus" size={14} />
                    </button>
                </>
            ) : (
                <input
                    aria-label="参数模板"
                    disabled={disabled}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                />
            )}
        </div>
    )
}
