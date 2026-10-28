import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const modulePath = (relative: string): string => path.join(appRoot, relative).replaceAll('\\', '/')

// Uses the real store, selector hooks, panel and cards. Only backend actions are replaced.
describe.skipIf(process.env.ITER_TEST_RENDERER_LAYOUT !== '1')('judge result render isolation', () => {
    it('mounts only visible cards and updates one result without rendering its neighbors', async () => {
        const temporary = await mkdtemp(path.join(os.tmpdir(), 'iter-judge-render-'))
        try {
            const actions = new Map<string, string>([
                ['debug', 'startDebug'],
                ['judge', 'runTests,stopRun'],
                ['terminal', 'runTerminal,stopTerminal'],
                ['folders', 'importFolderIntoActive,importFolder'],
                [
                    'tests',
                    'addTest,importDirect,acceptOutput,deleteTests,editTest,loadIntoTest,setCompareOutput,toggleTest,attachJudgeFile,importPaths'
                ],
                ['testPreviews', 'loadTestPreview'],
                ['files', 'openFile,closeFile,newUntitled,openFilesDialog,saveFile']
            ])
            const entryId = 'virtual:iter-judge-render'
            const entry = `
        import {createElement} from 'react';
        import {createRoot} from 'react-dom/client';
        import {JudgePanel} from ${JSON.stringify(modulePath('src/renderer/ui/JudgePanel.tsx'))};
        import {store,updateFile} from ${JSON.stringify(modulePath('src/renderer/state/app.ts'))};
        window.__cardRenders={};window.__panelRenders=0;
        window.iter={judge:{describe:async()=>null}};
        const tests=Array.from({length:1000},(_,i)=>({id:String(i),name:String(i+1),enabled:true,input:'',answer:'',truncated:false}));
        store.set({activePath:'/sample.cpp',files:[{path:'/sample.cpp',name:'sample.cpp',model:{},problem:{mode:'standard'},tests,results:{},runId:'run',terminalRunId:null,terminalPending:false,compile:null}]});
        createRoot(document.getElementById('root')).render(createElement(JudgePanel));
        const settle=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,10))}throw Error('Render did not settle')};
        window.__verify=async()=>{
          await settle(()=>document.querySelectorAll('.nv-test').length>0 && document.querySelectorAll('.nv-test').length<50);
          const before={panel:window.__panelRenders,cards:{...window.__cardRenders}};
          updateFile('/sample.cpp',file=>({results:{...file.results,'5':{testId:'5',verdict:'AC',output:'',stderr:'',timeMs:1,exitCode:0}}}));
          await settle(()=>document.querySelector('[data-test-id="5"] .nv-test')?.dataset.verdict==='AC');
          return {panelDelta:window.__panelRenders-before.panel,changedDelta:window.__cardRenders['5']-before.cards['5'],
            untouchedDeltas:Object.keys(before.cards).filter(id=>id!=='5').map(id=>window.__cardRenders[id]-before.cards[id])};
        };
      `
            const bundle = await build({
                configFile: false,
                root: appRoot,
                logLevel: 'silent',
                plugins: [
                    {
                        name: 'judge-render-fixture',
                        enforce: 'pre',
                        resolveId(id) {
                            if (id === entryId) return '\0entry'
                            if (/(?:^|\/)commands\/registry$/.test(id)) return '\0keybindings'
                            const action = /(?:^|\/)actions\/([^/]+)$/.exec(id)?.[1]
                            if (action && actions.has(action)) return `\0action:${action}`
                            return undefined
                        },
                        load(id) {
                            if (id === '\0entry') return entry
                            if (id === '\0keybindings') return 'export const withKey=label=>label;'
                            if (id.startsWith('\0action:'))
                                return actions
                                    .get(id.slice(8))!
                                    .split(',')
                                    .map((name) => `export const ${name}=async()=>{};`)
                                    .join('\n')
                            return undefined
                        },
                        transform(code, id) {
                            if (id.endsWith('/ui/TestCard.tsx'))
                                return code.replace(
                                    'const key = `${file.path}#${test.id}`',
                                    'window.__cardRenders[test.id]=(window.__cardRenders[test.id]??0)+1; const key = `${file.path}#${test.id}`'
                                )
                            if (id.endsWith('/ui/JudgePanel.tsx'))
                                return code.replace(
                                    'export function JudgePanel() {',
                                    'export function JudgePanel() { window.__panelRenders++;'
                                )
                            return undefined
                        }
                    },
                    react()
                ],
                build: {
                    write: false,
                    minify: false,
                    emptyOutDir: false,
                    rolldownOptions: {
                        input: entryId,
                        output: { format: 'iife', name: 'JudgeRenderFixture', inlineDynamicImports: true }
                    }
                }
            })
            if (!Array.isArray(bundle) && !('output' in bundle)) throw new Error('Unexpected watch-mode fixture build')
            const output = Array.isArray(bundle) ? bundle[0].output : bundle.output
            const script = output.find((item) => item.type === 'chunk')
            if (!script || script.type !== 'chunk') throw new Error('Missing judge render test bundle')
            await writeFile(path.join(temporary, 'fixture.js'), script.code)
            const css = (
                await Promise.all(
                    ['base', 'panels', 'dialogs'].map((name) =>
                        readFile(modulePath(`src/renderer/styles/${name}.css`), 'utf8')
                    )
                )
            ).join('\n')
            await writeFile(
                path.join(temporary, 'index.html'),
                `<!doctype html><style>${css} #root{height:700px;width:540px;display:flex}</style><div id="root"></div><script src="fixture.js"></script>`
            )
            await writeFile(
                path.join(temporary, 'main.cjs'),
                `
        const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
        for(const name of ['appData','userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir)}
        app.disableHardwareAcceleration();
        app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
          await win.loadFile(path.join(__dirname,'index.html'));const result=await win.webContents.executeJavaScript('window.__verify()');
          fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result));win.destroy();app.quit();
        }).catch(error=>{console.error(error);app.exit(1)});
      `
            )
            const env = { ...process.env }
            delete env.ELECTRON_RUN_AS_NODE
            await promisify(execFile)(
                createRequire(import.meta.url)('electron') as string,
                ['--no-sandbox', path.join(temporary, 'main.cjs')],
                { env, timeout: 30_000, windowsHide: true }
            )
            const result = JSON.parse(await readFile(path.join(temporary, 'result.json'), 'utf8'))
            expect(result.panelDelta).toBe(0)
            expect(result.changedDelta).toBe(1)
            expect(result.untouchedDeltas.length).toBeLessThan(50)
            expect(result.untouchedDeltas.length).toBeGreaterThan(0)
            expect(result.untouchedDeltas.every((delta: number) => delta === 0)).toBe(true)
        } finally {
            const target = path.resolve(temporary)
            if (
                path.dirname(target) !== path.resolve(os.tmpdir()) ||
                !path.basename(target).startsWith('iter-judge-render-')
            )
                throw new Error(`Refusing to remove unexpected judge render test directory: ${target}`)
            await rm(target, { recursive: true, force: true })
        }
    }, 40_000)
})
