import { useEffect, useState } from 'react'

/** Range slider with an editable number next to it; the two stay in sync. */
export function Slider(props: {
    label: string
    value: number
    min: number
    max: number
    step?: number
    unit?: string
    /** Shown as a tick the user can return to by double-clicking the slider. */
    defaultValue?: number
    format?: (v: number) => string
    onChange: (v: number) => void
}) {
    const step = props.step ?? 1
    const [text, setText] = useState(String(props.value))
    useEffect(() => {
        setText(String(props.value))
    }, [props.value])
    const decimals = (String(step).split('.')[1] ?? '').length
    const clamp = (v: number): number => Math.min(props.max, Math.max(props.min, Number(v.toFixed(decimals))))
    const pct = ((props.value - props.min) / (props.max - props.min)) * 100

    return (
        <div className="nv-slider">
            <span className="nv-slider-label">{props.label}</span>
            <input
                type="range"
                min={props.min}
                max={props.max}
                step={step}
                value={props.value}
                style={{ '--pct': `${pct}%` } as React.CSSProperties}
                onChange={(e) => props.onChange(clamp(+e.target.value))}
                onDoubleClick={() => props.defaultValue !== undefined && props.onChange(props.defaultValue)}
                title={props.defaultValue !== undefined ? `双击恢复 ${props.defaultValue}` : undefined}
            />
            <span className="nv-slider-value">
                <input
                    type="text"
                    inputMode="decimal"
                    value={text}
                    onChange={(e) => {
                        setText(e.target.value)
                        const v = parseFloat(e.target.value)
                        if (Number.isFinite(v) && v >= props.min && v <= props.max) props.onChange(clamp(v))
                    }}
                    onBlur={() => setText(String(props.value))}
                />
                {props.unit && <span className="nv-faint">{props.unit}</span>}
            </span>
        </div>
    )
}
