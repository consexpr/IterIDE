import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { expect, it } from 'vitest'

it.skipIf(process.env.ITER_TEST_RENDERER_LAYOUT !== '1')(
    'expands checker arguments inline without height jumps and keeps focus and Escape local',
    async () => {
        const root = process.cwd()
        const temp = await mkdtemp(path.join(os.tmpdir(), 'iter-checker-picker-'))
        const modulePath = (file: string): string => JSON.stringify(path.join(root, 'src', file).replaceAll('\\', '/'))
        try {
            const entry = `
            import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
            import {CheckerArguments} from ${modulePath('renderer/ui/dialogs/CheckerArguments.tsx')};
            import {Modal} from ${modulePath('renderer/ui/dialogs/Modal.tsx')};
            import {applyComponentTokens} from ${modulePath('renderer/themes/components.ts')};
            import {N_CHECK_TEMPLATE} from ${modulePath('shared/nCheck.ts')};
            function App(){const [value,setValue]=useState('{input} {output} {answer}');window.argumentsValue=value;
                const [disabled,setDisabled]=useState(false);window.disableArguments=setDisabled;
                return React.createElement(Modal,{title:'checker',className:'nv-checker-dialog',width:440},
                    React.createElement(CheckerArguments,{value,onChange:setValue,disabled}),
                    React.createElement('textarea',{className:'nv-ncheck-code',value:N_CHECK_TEMPLATE,readOnly:true}));}
            createRoot(document.getElementById('root')).render(React.createElement(App));
            const pause=(ms=360)=>new Promise(done=>setTimeout(done,ms));
            const check=(value,message)=>{if(!value)throw Error(message)};
            const key=(element,value)=>element.dispatchEvent(new KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
            window.checkPicker=async()=>{
                await pause();check(!document.querySelector('select,[popover],[role="listbox"],[role="combobox"]'),'Dropdown remains');
                const pickers=[...document.querySelectorAll('.nv-checker-picker')],first=pickers[0],second=pickers[1];
                const selected=(picker)=>picker.querySelector('[aria-pressed="true"]');
                const width=()=>first.getBoundingClientRect().width;
                const row=document.querySelector('.nv-checker-args'),height=row.getBoundingClientRect().height;
                const closedWidth=width();
                applyComponentTokens(document.documentElement.style,{checker:{argumentSelection:'#284a3b',argumentDuration:'320ms',argumentEasing:'linear'}});
                selected(first).click();await pause(100);const midway=width();
                check(midway>closedWidth+2&&midway<closedWidth*3-2,'Expansion snapped instead of animating');
                check(row.getBoundingClientRect().height===height,'Expansion changed row height');
                await pause();check(Math.abs(width()-closedWidth*3)<1,'Choices did not expand horizontally');
                check(getComputedStyle(selected(first)).backgroundColor==='rgb(40, 74, 59)','Selection ignored theme API');
                key(document.activeElement,'ArrowRight');
                check(document.activeElement===first.children[1],'Arrow key did not move option focus');
                document.activeElement.click();await pause(100);
                check(width()>closedWidth+2&&width()<closedWidth*3-2,'Collapse snapped instead of animating');
                await pause();check(window.argumentsValue==='{output} {output} {answer}','Choice changed the wrong slot');
                check(document.activeElement===selected(first),'Choice lost focus');
                check(first.children[0].inert&&first.children[2].inert,'Collapsed choices remain interactive');
                selected(first).click();await pause(80);const beforeReverse=width();
                key(document.activeElement,'Escape');await pause(16);
                check(Math.abs(width()-beforeReverse)<10,'Rapid reversal jumped');
                check(!window.modalCloses,'Escape closed the checker dialog');
                selected(first).click();await pause();
                selected(second).click();await pause();
                check(document.querySelectorAll('.nv-checker-picker[data-expanded="true"]').length===1,'Multiple capsules remained expanded');
                second.children[2].click();await pause();
                check(window.argumentsValue==='{output} {answer} {answer}','Mouse choice changed the wrong slot');
                selected(first).click();await pause();
                check(document.activeElement===selected(first),'Opening did not focus the selected choice: '+document.activeElement.outerHTML);
                const leaving=document.activeElement,textarea=document.querySelector('textarea');textarea.focus();
                // Hidden offscreen windows have no OS focus, so explicitly deliver the browser's focusout event.
                leaving.dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:textarea}));await pause();
                check(first.dataset.expanded==='false','Leaving the capsule did not collapse it');
                selected(first).click();await pause();window.disableArguments(true);await pause();
                check(first.dataset.expanded==='false'&&selected(first).disabled,'Disabled capsule remained open');
                window.disableArguments(false);await pause();
                document.querySelector('[aria-label="移除第 2 个参数"]').click();await pause();
                check(window.argumentsValue==='{output} {answer}','Removing a parameter changed its neighbors');
                document.querySelector('[aria-label="添加参数"]').click();await pause();
                check(window.argumentsValue==='{output} {answer} {input}','Adding a parameter failed');
                applyComponentTokens(document.documentElement.style,{});
                selected(first).click();await pause();
                const bounds=first.getBoundingClientRect();
                return {count:first.children.length,height:bounds.height,rowHeight:row.getBoundingClientRect().height,
                    originalRowHeight:height,withinWindow:bounds.left>=0&&bounds.right<=innerWidth,closed:window.modalCloses||0};
            };
        `
            const result = await build({
                configFile: false,
                root,
                logLevel: 'silent',
                plugins: [
                    {
                        name: 'checker-picker-fixture',
                        enforce: 'pre',
                        resolveId(id) {
                            if (id === 'fixture-picker') return '\0fixture-picker'
                            if (/(?:^|\/)state\/app$/.test(id)) return '\0fixture-store'
                        },
                        load(id) {
                            if (id === '\0fixture-picker') return entry
                            if (id === '\0fixture-store')
                                return 'export const store={get:()=>({dialog:{kind:"checkerCode"}}),set:()=>{window.modalCloses=(window.modalCloses||0)+1}};'
                        }
                    },
                    react()
                ],
                build: {
                    write: false,
                    minify: false,
                    rolldownOptions: { input: 'fixture-picker', output: { format: 'iife', name: 'PickerFixture' } }
                }
            })
            const outputs = (Array.isArray(result) ? result : [result]).flatMap((part) =>
                'output' in part ? part.output : []
            )
            const js = outputs
                .filter((chunk) => chunk.type === 'chunk')
                .map((chunk) => chunk.code)
                .join('\n')
            const css = (
                await Promise.all(
                    ['base', 'dialogs'].map((name) =>
                        readFile(path.join(root, `src/renderer/styles/${name}.css`), 'utf8')
                    )
                )
            ).join('\n')
            await writeFile(
                path.join(temp, 'index.html'),
                `<!doctype html><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${js.replaceAll('</script', '<\\/script')}</script>`
            )
            await writeFile(
                path.join(temp, 'main.cjs'),
                `
            const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
            for(const key of ['appData','userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,key);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir)}
            app.disableHardwareAcceleration();app.whenReady().then(async()=>{
                const win=new BrowserWindow({show:false,width:640,height:720,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true}});
                await win.loadFile(path.join(__dirname,'index.html'));
                fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(await win.webContents.executeJavaScript('window.checkPicker()')));
                if(process.env.ITER_CHECKER_SCREENSHOT)fs.writeFileSync(process.env.ITER_CHECKER_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
                win.destroy();app.quit();
            }).catch(error=>{console.error(error);app.exit(1)});
        `
            )
            const env = { ...process.env }
            delete env.ELECTRON_RUN_AS_NODE
            await promisify(execFile)(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs')], {
                env,
                windowsHide: true,
                timeout: 20_000
            })
            const measured = JSON.parse(await readFile(path.join(temp, 'result.json'), 'utf8'))
            expect(measured).toMatchObject({ count: 3, height: 26, withinWindow: true, closed: 0 })
            expect(measured.rowHeight).toBe(measured.originalRowHeight)
        } finally {
            if (
                path.dirname(temp) !== path.resolve(os.tmpdir()) ||
                !path.basename(temp).startsWith('iter-checker-picker-')
            )
                throw Error('Unexpected test path')
            await rm(temp, { recursive: true, force: true, maxRetries: 5 })
        }
    },
    30_000
)
