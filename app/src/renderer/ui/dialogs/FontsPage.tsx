import type { AppSettings, EditorSettings } from '../../../shared/settings'
import { defaultSettings } from '../../../shared/settings'
import { updateSettings } from '../../actions/settings'
import { FontPicker } from '../controls/FontPicker'
import { Slider } from '../controls/Slider'
import { Field, Switch } from './Modal'

const D = defaultSettings()
const setEditor = (p: Partial<EditorSettings>): void => void updateSettings({ editor: p as EditorSettings })

const SAMPLE = `for (int i = 0; i < n; i++) {
    if (a[i] != b[i]) ans += 0x3f;
}
cout << ans << "\\n";  // => O(n)`

export function FontsPage({ s }: { s: AppSettings }) {
    const e = s.editor
    return (
        <div className="nv-form">
            <pre
                className="nv-font-preview"
                style={{
                    fontFamily: e.fontFamily,
                    fontSize: e.fontSize,
                    lineHeight: e.lineHeight,
                    letterSpacing: e.letterSpacing,
                    fontWeight: e.fontWeight,
                    fontVariantLigatures: e.ligatures ? 'normal' : 'none'
                }}
            >
                {SAMPLE}
            </pre>

            <Field label="代码字体">
                <FontPicker value={e.fontFamily} onChange={(fontFamily) => setEditor({ fontFamily })} monospaceFirst />
            </Field>
            <div className="nv-sliders">
                <Slider
                    label="字号"
                    value={e.fontSize}
                    min={9}
                    max={32}
                    step={0.5}
                    unit="px"
                    defaultValue={D.editor.fontSize}
                    onChange={(fontSize) => setEditor({ fontSize })}
                />
                <Slider
                    label="行高"
                    value={e.lineHeight}
                    min={1}
                    max={2.4}
                    step={0.05}
                    unit="×"
                    defaultValue={D.editor.lineHeight}
                    onChange={(lineHeight) => setEditor({ lineHeight })}
                />
                <Slider
                    label="字间距"
                    value={e.letterSpacing}
                    min={-1}
                    max={3}
                    step={0.1}
                    unit="px"
                    defaultValue={D.editor.letterSpacing}
                    onChange={(letterSpacing) => setEditor({ letterSpacing })}
                />
                <Slider
                    label="字重"
                    value={e.fontWeight}
                    min={100}
                    max={900}
                    step={100}
                    defaultValue={D.editor.fontWeight}
                    onChange={(fontWeight) => setEditor({ fontWeight })}
                />
            </div>
            <Switch checked={e.ligatures} onChange={(v) => setEditor({ ligatures: v })} label="连字" />

            <Field label="界面字体">
                <FontPicker value={s.uiFontFamily} onChange={(uiFontFamily) => void updateSettings({ uiFontFamily })} />
            </Field>
            <div className="nv-sliders">
                <Slider
                    label="界面字号"
                    value={s.uiFontSize}
                    min={11}
                    max={18}
                    step={0.5}
                    unit="px"
                    defaultValue={D.uiFontSize}
                    onChange={(uiFontSize) => void updateSettings({ uiFontSize })}
                />
            </div>
            <div className="nv-row is-tight">
                <button className="nv-btn is-quiet" onClick={() => void window.iter.settings.openUserDir('fonts')}>
                    打开字体目录
                </button>
            </div>
        </div>
    )
}
