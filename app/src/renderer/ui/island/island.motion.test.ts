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
    'keeps island size stable and animates shrinking controls and closing content',
    async () => {
        const root = process.cwd()
        const temp = await mkdtemp(path.join(os.tmpdir(), 'iter-island-motion-'))
        const modulePath = (file: string) => JSON.stringify(path.join(root, 'src', file).replaceAll('\\', '/'))
        try {
            const fixture = `
            import {createElement} from 'react';import {createRoot} from 'react-dom/client';
            import {DynamicIsland} from ${modulePath('renderer/ui/island/DynamicIsland.tsx')};
            import {defaultProblem} from ${modulePath('shared/problem.ts')};
            import {store} from 'fixture-store';
            let pending=[], describes=0;
            window.iter={judge:{modes:async()=>[{id:'standard',name:'普通',source:'builtin'},{id:'interactive',name:'交互',source:'builtin'}],
                describe:()=>{describes++;return new Promise(resolve=>pending.push(resolve))}}};
            const problem=defaultProblem('sample');
            store.set({islandOpen:false,closing:false,files:[{path:'/sample.cpp',name:'sample.cpp',problem,tests:[],results:{},model:{getValue:()=>''},runId:null,lastVerdict:null}],
                activePath:'/sample.cpp',debug:{path:null,state:{status:'idle'}}});
            createRoot(document.getElementById('root')).render(createElement(DynamicIsland));
            const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
            const setMode=mode=>store.set(s=>({files:[{...s.files[0],problem:{...s.files[0].problem,mode}}]}));
            const snapshot=()=>{
                const shell=document.querySelector('.nvi'), panel=document.querySelector('.nvi-layer:not(.is-out) .nvi-panel');
                const group=panel?.querySelector('.nvi-run-kind'), button=group?.querySelector('button');
                return {w:shell.getBoundingClientRect().width,h:shell.getBoundingClientRect().height,
                    natural:panel?.offsetHeight,button:button?.getBoundingClientRect().width,
                    frozen:!!document.querySelector('.nvi-layer.is-panel.is-out[inert]'),
                    live:document.querySelectorAll('.nvi-layer:not(.is-out) .nvi-panel').length};
            };
            const sample=async(action,count=48)=>{
                const before=snapshot();action();const frames=[];
                for(let i=0;i<count;i++){await frame();frames.push(snapshot())}
                return {before,frames};
            };
            window.probe=async()=>{
                while(!document.querySelector('.nvi'))await frame();
                await frame();await frame();
                const open=await sample(()=>store.set({islandOpen:true}));
                const beforeCheck=snapshot();
                pending.splice(0).forEach(resolve=>resolve({modeId:'standard',modeName:'普通',badges:[]}));
                const check=await sample(()=>{},20);
                const grow=await sample(()=>setMode('interactive'));
                const shrink=await sample(()=>setMode('standard'));
                const rapid=await sample(()=>{setMode('interactive');setTimeout(()=>setMode('standard'),90)});
                const countBefore=describes;
                const close=await sample(()=>store.set({islandOpen:false}));
                const countAfter=describes;
                const reopen=await sample(()=>{store.set({islandOpen:true});setTimeout(()=>store.set({islandOpen:false}),70);setTimeout(()=>store.set({islandOpen:true}),140)},60);
                const observerErrors=window.observerErrors||[];
                return {open,beforeCheck,check,grow,shrink,rapid,close,reopen,countBefore,countAfter,observerErrors};
            };
            window.addEventListener('error',event=>{if(event.message.includes('ResizeObserver'))(window.observerErrors??=[]).push(event.message)});
        `
            const storeModule = `
            import {useSyncExternalStore} from 'react';let state={}, listeners=new Set();
            export const store={get:()=>state,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)},
                set:p=>{state={...state,...(typeof p==='function'?p(state):p)};listeners.forEach(f=>f())}};
            export const useApp=f=>useSyncExternalStore(store.subscribe,()=>f(state));
            export const activeFile=(s=state)=>s.files.find(f=>f.path===s.activePath);
            export const isDebugging=()=>false;export const toast=()=>{};
            export const updateFile=(p,patch)=>store.set(s=>({files:s.files.map(f=>f.path===p?{...f,...patch}:f)}));
        `
            const bundled = await build({
                configFile: false,
                root,
                logLevel: 'silent',
                plugins: [
                    {
                        name: 'island-motion-fixture',
                        enforce: 'pre',
                        resolveId(id) {
                            if (id === 'virtual:motion') return '\0entry'
                            if (id === 'fixture-store' || /(?:^|\/)state\/app$/.test(id)) return '\0store'
                            if (/(?:^|\/)actions\/tests$/.test(id)) return '\0tests'
                            if (/(?:^|\/)actions\/debug$/.test(id)) return '\0debug'
                            if (/(?:^|\/)commands\/registry$/.test(id)) return '\0keys'
                        },
                        load(id) {
                            if (id === '\0entry') return fixture
                            if (id === '\0store') return storeModule
                            if (id === '\0tests')
                                return 'export const editProblemSettings=()=>{};export const attachJudgeFile=async()=>{};'
                            if (id === '\0debug')
                                return 'export const debugCommand=()=>{};export const runToCursor=()=>{};'
                            if (id === '\0keys') return 'export const withKey=t=>t;'
                        }
                    },
                    react()
                ],
                build: {
                    write: false,
                    minify: false,
                    emptyOutDir: false,
                    rolldownOptions: { input: 'virtual:motion', output: { format: 'iife' } }
                }
            })
            const js = (Array.isArray(bundled) ? bundled : [bundled])
                .flatMap((r) => ('output' in r ? r.output : []))
                .filter((c) => c.type === 'chunk')
                .map((c) => c.code)
                .join('\n')
            const css = (
                await Promise.all(
                    ['base', 'panels', 'island'].map((name) =>
                        readFile(path.join(root, 'src/renderer/styles', name + '.css'), 'utf8')
                    )
                )
            ).join('\n')
            await writeFile(
                path.join(temp, 'index.html'),
                '<!doctype html><meta charset="utf-8"><style>' +
                    css +
                    'body{display:flex;justify-content:center} .nvi-slot{max-width:none}</style><div id="root"></div><script>' +
                    js.replaceAll('</script', '<\\/script') +
                    '</script>'
            )
            await writeFile(
                path.join(temp, 'main.cjs'),
                `
            const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
            for(const name of ['appData','userData','sessionData','logs','crashDumps']){
                const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir)
            }
            app.disableHardwareAcceleration();app.whenReady().then(async()=>{
                const w=new BrowserWindow({show:false,width:900,height:650,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false,offscreen:true}});
                w.webContents.setFrameRate(60);
                w.webContents.on('console-message',(_event,level,message)=>{if(level>=2)console.error(message)});
                await w.loadFile(path.join(__dirname,'index.html'));
                const result=await w.webContents.executeJavaScript('window.probe()');
                fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result));w.destroy();app.quit()
            }).catch(e=>{console.error(e);app.exit(1)})
        `
            )
            const env = { ...process.env }
            delete env.ELECTRON_RUN_AS_NODE
            await promisify(execFile)(
                createRequire(import.meta.url)('electron') as string,
                [path.join(temp, 'main.cjs')],
                { env, windowsHide: true, timeout: 25_000 }
            )
            const result = JSON.parse(await readFile(path.join(temp, 'result.json'), 'utf8'))
            for (const name of ['open', 'grow', 'shrink', 'rapid', 'reopen']) {
                const frames = result[name].frames,
                    tail = frames.slice(-8)
                expect(
                    Math.max(...tail.map((f: any) => f.h)) - Math.min(...tail.map((f: any) => f.h)),
                    name + ' height must settle'
                ).toBeLessThan(0.5)
                expect(tail.at(-1).h, name + ' natural height').toBeCloseTo(tail.at(-1).natural, 0)
                expect(
                    frames.every((f: any) => f.h > 0 && f.w > 0 && f.live <= 1),
                    name
                ).toBe(true)
                expect(tail.at(-1).live, name + ' must finish with one live panel').toBe(1)
            }
            expect(result.check.frames.at(-1).button).toBeCloseTo(result.beforeCheck.button, 1)
            for (const name of ['open', 'grow', 'shrink']) {
                const sizes = result[name].frames.slice(2).map((f: any) => f.natural)
                expect(
                    Math.max(...sizes) - Math.min(...sizes),
                    name + ' must not remeasure animated overflow'
                ).toBeLessThan(0.5)
            }
            const small = result.shrink.frames.at(-1).button,
                large = result.shrink.before.button
            expect(large - small).toBeGreaterThan(8)
            expect(
                result.shrink.frames.filter((f: any) => f.button > small + 1 && f.button < large - 1).length
            ).toBeGreaterThan(2)
            expect(result.close.frames.some((f: any) => f.frozen)).toBe(true)
            expect(
                result.close.frames.filter((f: any) => f.h > 31 && f.h < result.close.before.h - 1).length
            ).toBeGreaterThan(2)
            expect(result.close.frames.at(-1).h).toBeCloseTo(30, 1)
            expect(result.countAfter).toBe(result.countBefore)
            expect(result.observerErrors).toEqual([])
        } finally {
            if (
                path.dirname(temp) !== path.resolve(os.tmpdir()) ||
                !path.basename(temp).startsWith('iter-island-motion-')
            )
                throw Error('Unexpected test path')
            await rm(temp, { recursive: true, force: true, maxRetries: 5 })
        }
    },
    30_000
)
