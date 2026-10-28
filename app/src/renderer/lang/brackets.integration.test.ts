import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { build } from 'vite'
import { expect, it } from 'vitest'

it.skipIf(process.env.ITER_TEST_RENDERER_LAYOUT !== '1')(
    'accepts callable parentheses with native overtype, deletion and undo in Chromium',
    async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'iter-completion-brackets-'))
        const root = process.cwd()
        const file = (name: string): string => JSON.stringify(path.join(root, 'src', name).replaceAll('\\', '/'))
        try {
            const fixture = `
                import { monaco, editorOptions } from ${file('renderer/editor/monaco.ts')};
                import { defaultSettings } from ${file('shared/settings.ts')};
                import { createCppLanguageService } from ${file('renderer/lang/index.ts')};
                const settings = defaultSettings().editor;
                settings.completion = {...settings.completion, model:false, showKeywords:false};
                const model = monaco.editor.createModel('', 'cpp');
                const options = editorOptions(settings);
                const editor = monaco.editor.create(document.getElementById('editor'), {
                    ...options, model, quickSuggestions:false,
                    suggest:{...options.suggest, localityBonus:false}
                });
                const listeners = new Set();
                let item = {label:'query', kind:3};
                const api = {lsp:{
                    start:async()=>true, stop:async()=>{},
                    onMessage:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},
                    send:message=>{
                        if (!('id' in message)) return;
                        const result = message.method === 'initialize' ? {capabilities:{}}
                            : message.method === 'textDocument/completion' ? {items:[item]} : null;
                        queueMicrotask(()=>{for(const listener of listeners)listener({jsonrpc:'2.0',id:message.id,result})});
                    }
                }};
                const service = createCppLanguageService(monaco, api, {getSettings:()=>({
                    semanticCompletion:true, liveDiagnostics:false, flags:'-std=c++20', completion:settings.completion
                })});
                service.attach(model, '/tmp/brackets.cpp');
                const pause = () => new Promise(done=>setTimeout(done,0));
                const type = text => editor.trigger('keyboard','type',{text});
                const reset = (text, positions=[{lineNumber:1,column:text.length+1}]) => {
                    model.setValue(text);
                    editor.setSelections(positions.map(p=>new monaco.Selection(p.lineNumber,p.column,p.lineNumber,p.column)));
                    editor.focus();
                };
                const state = () => ({text:model.getValue(),positions:editor.getSelections().map(s=>[s.positionLineNumber,s.positionColumn])});
                async function suggest() {
                    const suggest=editor.getContribution('editor.contrib.suggestController');
                    await new Promise((resolve,reject)=>{
                        const timer=setTimeout(()=>{listener.dispose();reject(Error('Suggestions did not arrive'))},2000);
                        const listener=suggest.model.onDidSuggest(()=>{clearTimeout(timer);listener.dispose();resolve()});
                        editor.trigger('keyboard','editor.action.triggerSuggest',{});
                    });
                    editor.trigger('keyboard','acceptSelectedSuggestion',{});
                    await pause();
                }
                async function accept(text='qu', positions, semantic={label:'query',kind:3}) {
                    item=semantic;reset(text,positions);await suggest();
                }
                window.runBracketChecks = async () => {
                    await pause();
                    const results={};
                    await accept();results.accept=state();type(')');results.close=state();
                    await accept();type('1');type(')');results.argument=state();
                    await accept();type('qu');await suggest();type('1');type(')');type(')');results.nested=state();
                    await accept();editor.trigger('keyboard','deleteLeft',{});results.backspace=state();
                    await accept();await model.undo();results.undo=state();await model.redo();results.redo=state();
                    await accept('qu\\nqu',[{lineNumber:1,column:3},{lineNumber:2,column:3}]);
                    results.multipleAccept=state();type(')');results.multipleClose=state();
                    await accept('qu\\nqu',[{lineNumber:1,column:3},{lineNumber:2,column:3}]);
                    editor.trigger('keyboard','deleteLeft',{});results.multipleBackspace=state();
                    await accept('qu(1)',[{lineNumber:1,column:3}]);results.existingCall=state();
                    editor.setPosition({lineNumber:1,column:8});type(')');results.existingClose=state();
                    await accept('qu',[{lineNumber:1,column:3}],{label:'query',kind:3,labelDetails:{detail:'()'}});
                    results.zeroArguments=state();
                    await accept('(qu)',[{lineNumber:1,column:4}],{label:'query',kind:6});
                    type(')');results.variableClose=state();
                    settings.completion.appendFunc=false;
                    await accept();results.disabled=state();settings.completion.appendFunc=true;
                    reset('');type('(');type(')');results.typedClose=state();
                    reset('');type('(');editor.trigger('keyboard','deleteLeft',{});results.typedBackspace=state();
                    reset('()',[{lineNumber:1,column:2}]);editor.trigger('keyboard','deleteLeft',{});results.manualBackspace=state();
                    const contexts=['"abc','// abc','/* abc'];
                    results.contexts=[];
                    for(const context of contexts)for(const char of ['(','[','{']) {
                        reset(context);type(char);results.contexts.push(model.getValue());
                    }
                    service.dispose();editor.dispose();model.dispose();
                    return results;
                };
            `
            await build({
                configFile: false,
                root,
                base: './',
                logLevel: 'silent',
                plugins: [
                    {
                        name: 'completion-brackets-fixture',
                        resolveId: (id) => (id === 'fixture-brackets' ? '\0fixture-brackets' : undefined),
                        load: (id) => (id === '\0fixture-brackets' ? fixture : undefined)
                    }
                ],
                build: {
                    outDir: path.join(temp, 'web'),
                    emptyOutDir: false,
                    rolldownOptions: { input: 'fixture-brackets', output: { entryFileNames: 'index.js' } }
                }
            })
            const styles = (await readdir(path.join(temp, 'web/assets')))
                .filter((name) => name.endsWith('.css'))
                .map((name) => `<link rel="stylesheet" href="assets/${name}">`)
                .join('')
            await writeFile(
                path.join(temp, 'web/index.html'),
                `<!doctype html>${styles}<div id="editor" style="width:800px;height:500px"></div><script type="module" src="index.js"></script>`
            )
            await writeFile(
                path.join(temp, 'main.cjs'),
                `
                    const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
                    for(const key of ['appData','userData','sessionData','logs','crashDumps']) {
                        const folder=path.join(__dirname,key);fs.mkdirSync(folder,{recursive:true});app.setPath(key,folder);
                    }
                    app.disableHardwareAcceleration();app.whenReady().then(async()=>{
                        const win=new BrowserWindow({show:false,width:900,height:650,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true}});
                        await win.loadFile(path.join(__dirname,'web/index.html'));
                        const result=await win.webContents.executeJavaScript('window.runBracketChecks()');
                        fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result));
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
            const single = (text: string, column: number) => ({ text, positions: [[1, column]] })
            expect(result).toEqual({
                accept: single('query()', 7),
                close: single('query()', 8),
                argument: single('query(1)', 9),
                nested: single('query(query(1))', 16),
                backspace: single('query', 6),
                undo: single('qu', 3),
                redo: single('query()', 7),
                multipleAccept: {
                    text: 'query()\nquery()',
                    positions: [
                        [1, 7],
                        [2, 7]
                    ]
                },
                multipleClose: {
                    text: 'query()\nquery()',
                    positions: [
                        [1, 8],
                        [2, 8]
                    ]
                },
                multipleBackspace: {
                    text: 'query\nquery',
                    positions: [
                        [1, 6],
                        [2, 6]
                    ]
                },
                existingCall: single('query(1)', 6),
                existingClose: single('query(1))', 9),
                zeroArguments: single('query()', 8),
                variableClose: single('(query))', 8),
                disabled: single('query', 6),
                typedClose: single('()', 3),
                typedBackspace: single('', 1),
                manualBackspace: single(')', 1),
                contexts: ['"abc(', '"abc[', '"abc{', '// abc(', '// abc[', '// abc{', '/* abc(', '/* abc[', '/* abc{']
            })
        } finally {
            if (
                path.dirname(temp) !== path.resolve(os.tmpdir()) ||
                !path.basename(temp).startsWith('iter-completion-brackets-')
            )
                throw Error('Unexpected test path')
            await rm(temp, { recursive: true, force: true, maxRetries: 5 })
        }
    },
    45_000
)
