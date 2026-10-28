import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { expect, it } from 'vitest'

it.skipIf(process.env.ITER_TEST_RENDERER_LAYOUT !== '1')(
    'owns find focus, IME, rebinding, model changes and undoable replacements in Chromium',
    async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'iter-search-'))
        const root = process.cwd()
        const file = (name: string): string => JSON.stringify(path.join(root, 'src', name).replaceAll('\\', '/'))
        try {
            const fixture = `
        import React from 'react';import {createRoot} from 'react-dom/client';
        import {monaco,editorOptions} from ${file('renderer/editor/monaco.ts')};
        import {defaultSettings} from ${file('shared/settings.ts')};
        import {applyTheme,findTheme} from ${file('renderer/themes/apply.ts')};
        import {editorRef} from ${file('renderer/editor/instance.ts')};
        import {installSearch,searchState,updateSearch,replaceSearchMatch} from ${file('renderer/editor/search.ts')};
        import {FindPanel} from ${file('renderer/ui/FindPanel.tsx')};
        import {useGlobalShortcuts} from ${file('renderer/ui/shell/keymap.ts')};
        import {store} from 'fixture-store';
        window.iter={app:{onOpenFiles:()=>()=>{},onNotify:()=>()=>{}}};
        const settings=defaultSettings();applyTheme(monaco,findTheme(settings.theme));
        const model=monaco.editor.createModel('int cat;\\ncat += 1;\\n// 中文','cpp');
        const editor=monaco.editor.create(document.getElementById('editor'),{...editorOptions(settings.editor),model});
        editorRef.editor=editor;installSearch(editor);
        const original=editor.getModel();
        function Harness(){useGlobalShortcuts();return React.createElement(FindPanel)}
        createRoot(document.getElementById('find-root')).render(React.createElement(Harness));
        const pause=()=>new Promise(done=>setTimeout(done,250));
        const check=(yes,message)=>{if(!yes)throw Error(message)};
        const key=(element,value,extra={})=>element.dispatchEvent(new KeyboardEvent('keydown',{key:value,code:value.length===1?'Key'+value.toUpperCase():value,bubbles:true,cancelable:true,...extra}));
        const type=(element,text)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,text);element.dispatchEvent(new Event('input',{bubbles:true}));};
        const query=()=>document.querySelector('[aria-label="查找内容"]');
        const replacement=()=>document.querySelector('[aria-label="替换内容"]');
        window.runFindChecks=async()=>{
            await pause();document.getElementById('side').focus();key(document.activeElement,'f',{ctrlKey:true});await pause();
            check(document.activeElement===query(),'Ctrl+F from a side control must focus our field');
            check(!document.querySelector('.find-widget.visible'),'Native find must remain closed');
            type(query(),'cat');await pause();check(searchState.get().count===2,'Find count');
            const before=original.getValue();const first=editor.getSelection().startColumn;
            key(query(),'Enter');await pause();check(document.activeElement===query(),'Next match stole input focus');
            check(original.getValue()===before,'Typing in find modified source');
            key(query(),'f',{ctrlKey:true});await pause();check(query().selectionStart===0&&query().selectionEnd===3,'Repeated Ctrl+F must select the query');
            query().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
            type(query(),'中文');key(query(),'Enter',{isComposing:true});key(query(),'Escape',{isComposing:true});await pause();
            check(searchState.get().open,'IME Escape closed find');
            query().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));await pause();
            check(searchState.get().count===1,'IME commit was lost');
            const liveForm=document.querySelector('.nv-find');
            key(query(),'Escape');await new Promise(done=>setTimeout(done,35));
            check(liveForm.inert&&liveForm.getAnimations().length>0,'Closing must animate without accepting input');
            key(editor.getDomNode(),'f',{ctrlKey:true});await pause();
            check(document.querySelector('.nv-find')===liveForm&&document.activeElement===query(),'Rapid reopen must retain the form and focus');
            key(query(),'Escape');await pause();check(!searchState.get().open&&editor.hasTextFocus(),'Escape must close and return editor focus');
            editor.setSelection(new monaco.Range(1,1,1,1));
            store.set({settings:{keybindings:{'edit.find':'Ctrl+L'}}});
            key(editor.getDomNode(),'f',{ctrlKey:true});await pause();check(!searchState.get().open&&!document.querySelector('.find-widget.visible'),'Disabled native shortcut returned');
            key(editor.getDomNode(),'l',{ctrlKey:true});await pause();check(document.activeElement===query(),'Custom find shortcut');
            store.set({settings:{keybindings:{}}});key(query(),'Escape');await pause();key(editor.getDomNode(),'f',{ctrlKey:true});await pause();
            type(query(),'cat');await pause();
            const second=monaco.editor.createModel('cat cat cat','cpp');editor.setModel(second);await pause();check(searchState.get().count===3,'Tab switch kept old results');
            key(query(),'h',{ctrlKey:true});await pause();check(document.activeElement===replacement(),'Ctrl+H focus');
            type(replacement(),'dog');key(replacement(),'Enter',{ctrlKey:true});await pause();
            check(second.getValue()==='dog dog dog','Replace all did not use current file');check(!window.runs,'Ctrl+Enter leaked to Run');
            await second.undo();await pause();check(second.getValue()==='cat cat cat','Replace all must be one undo');
            editor.updateOptions({readOnly:true});replaceSearchMatch(true);check(second.getValue()==='cat cat cat','Readonly source changed');editor.updateOptions({readOnly:false});
            updateSearch({regex:true,query:'['});await pause();check(!!searchState.get().error,'Invalid regex not surfaced');
            updateSearch({regex:false,query:'cat'});await pause();
            editor.setModel(null);await pause();check(!searchState.get().open,'Last closed tab left find open');
            editor.setModel(original);key(editor.getDomNode(),'f',{ctrlKey:true});await pause();
            type(query(),'cat');await pause();
            const rect=document.querySelector('.nv-find').getBoundingClientRect();
            applyTheme(monaco,{...findTheme('iter-paper'),components:{search:{background:'#eeeeeeaa',backdropFilter:'blur(4px)'}}});
            check(getComputedStyle(document.querySelector('.nv-find')).backgroundColor.includes('0.667'),'Light theme alpha');
            applyTheme(monaco,findTheme('iter-dusk'));
            check(!document.documentElement.style.getPropertyValue('--search-background'),'Old component overrides leaked across themes');
            applyTheme(monaco,{...findTheme('iter-dusk'),editor:{...findTheme('iter-dusk').editor,background:'#00000000'},components:{search:{background:'#18293699',backdropFilter:'blur(6px)',inputBackground:'#10182066'}}});
            document.getElementById('pane').style.background='linear-gradient(135deg,#243849,#202a38 35%,#263d35 72%,#27313e)';
            await pause();
            return {focus:true,ime:true,rebind:true,tabs:true,undo:true,height:rect.height,width:rect.width,nativeVisible:!!document.querySelector('.find-widget.visible')};
        };
        `
            const sources: Record<string, string> = {
                '\0fixture-store': `import {Store,useStore} from ${file('renderer/state/store.ts')};export const store=new Store({settings:{keybindings:{}},closing:false,dialog:null,accountOpen:false});export const isDebugging=()=>false;export const toast=message=>{throw Error(message)};`,
                '\0fixture-startup': 'export const openExternalFiles=()=>{};',
                '\0fixture-registry': `import {openSearch,nextSearchMatch} from ${file('renderer/editor/search.ts')};import {normalize} from ${file('renderer/commands/accelerator.ts')};import {store} from 'fixture-store';export const COMMANDS=[{kind:'app',id:'edit.find',key:'Ctrl+F',run:()=>openSearch()},{kind:'app',id:'edit.replace',key:'Ctrl+H',run:()=>openSearch('replace')},{kind:'app',id:'run.all',key:'Ctrl+Enter',run:()=>{window.runs=(window.runs||0)+1}}];export const bindingOf=(c,bindings=store.get().settings.keybindings)=>normalize(bindings[c.id]??c.key);`
            }
            await build({
                configFile: false,
                root,
                base: './',
                logLevel: 'silent',
                plugins: [
                    {
                        name: 'search-fixture',
                        enforce: 'pre',
                        resolveId(id) {
                            if (id === 'fixture-search') return '\0fixture-search'
                            if (id === 'fixture-store' || /(?:^|\/)state\/app$/.test(id)) return '\0fixture-store'
                            if (/(?:^|\/)commands\/registry$/.test(id)) return '\0fixture-registry'
                            if (/(?:^|\/)actions\/startup$/.test(id)) return '\0fixture-startup'
                        },
                        load: (id) => (id === '\0fixture-search' ? fixture : sources[id])
                    },
                    react()
                ],
                build: {
                    outDir: path.join(temp, 'web'),
                    emptyOutDir: false,
                    rolldownOptions: { input: 'fixture-search', output: { entryFileNames: 'index.js' } }
                }
            })
            const styles = (await readdir(path.join(temp, 'web/assets')))
                .filter((name) => name.endsWith('.css'))
                .map((name) => `<link rel="stylesheet" href="assets/${name}">`)
                .join('')
            const css = await readFile(path.join(root, 'src/renderer/styles/base.css'), 'utf8')
            await writeFile(
                path.join(temp, 'web/index.html'),
                `<!doctype html><meta charset="utf-8">${styles}<style>${css}#pane{position:relative;width:700px;height:560px}#editor{height:100%}#find-root{position:absolute;inset:0;pointer-events:none}#find-root>*{pointer-events:auto}</style><div id="pane"><div id="editor"></div><div id="find-root"></div></div><button id="side">Side</button><script type="module" src="index.js"></script>`
            )
            await writeFile(
                path.join(temp, 'main.cjs'),
                `
            const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
            for(const key of ['appData','userData','sessionData','logs','crashDumps']){const folder=path.join(__dirname,key);fs.mkdirSync(folder,{recursive:true});app.setPath(key,folder)}
            app.disableHardwareAcceleration();app.whenReady().then(async()=>{
                const win=new BrowserWindow({show:false,width:760,height:650,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true}});
                await win.loadFile(path.join(__dirname,'web/index.html'));
                const result=await win.webContents.executeJavaScript('window.runFindChecks()');
                fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result));
                if(process.env.ITER_FIND_SCREENSHOT)fs.writeFileSync(process.env.ITER_FIND_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
                win.destroy();app.quit();
            }).catch(error=>{console.error(error);app.exit(1)});
        `
            )
            const env = { ...process.env }
            delete env.ELECTRON_RUN_AS_NODE
            await promisify(execFile)(createRequire(import.meta.url)('electron'), [path.join(temp, 'main.cjs')], {
                env,
                windowsHide: true,
                timeout: 30_000
            })
            const result = JSON.parse(await readFile(path.join(temp, 'result.json'), 'utf8'))
            expect(result).toMatchObject({
                focus: true,
                ime: true,
                rebind: true,
                tabs: true,
                undo: true,
                nativeVisible: false
            })
            expect(result.height).toBeLessThan(120)
            expect(result.width).toBe(440)
        } finally {
            if (path.dirname(temp) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('iter-search-'))
                throw Error('Unexpected test path')
            await rm(temp, { recursive: true, force: true, maxRetries: 5 })
        }
    },
    45_000
)
