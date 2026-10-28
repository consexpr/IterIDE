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

async function fixtureBundle(): Promise<string> {
    const entryId = 'virtual:iter-panel-layout'
    const sources: Record<string, string> = {
        '\0fixture-store': `
      import { useSyncExternalStore } from 'react';
      let state = {}, listeners = new Set();
      export const store = { get: () => state, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
        set: patch => { state = {...state, ...(typeof patch === 'function' ? patch(state) : patch)}; listeners.forEach(listener => listener()) } };
      export const useApp = selector => useSyncExternalStore(store.subscribe, () => selector(store.get()));
      export const activeFile = (current = store.get()) => current.files[0];
      export const updateFile = (path, patch) => store.set(current => ({files: current.files.map(file => file.path === path
        ? {...file, ...(typeof patch === 'function' ? patch(file) : patch)} : file)}));
      export const isDebugging = () => false;
      export const toast = () => {};
    `,
        '\0fixture-tests':
            'export const attachJudgeFile = async () => {}; export const editProblemSettings = () => {}; export const flushProblemWrites = async () => {};',
        '\0fixture-debug':
            'export const debugSessionToken = () => 1; export const scheduleDebugSeek = () => () => {}; export const setDebugTab = () => {};',
        '\0fixture-pages':
            'export const VariablesTab = () => null; export const WatchTab = () => null; export const StackTab = () => null; export const BreakpointsTab = () => null; export const OutputDock = () => null;'
    }
    const entry = `
    import { createElement } from 'react';
    import { createRoot } from 'react-dom/client';
    import { EvalPanel } from ${JSON.stringify(modulePath('src/renderer/ui/island/EvalPanel.tsx'))};
    import { DebugPanel } from ${JSON.stringify(modulePath('src/renderer/ui/debug/DebugPanel.tsx'))};
    import { ModeBadges } from ${JSON.stringify(modulePath('src/renderer/ui/island/ModeBadges.tsx'))};
    import { panelDescription } from ${JSON.stringify(modulePath('src/renderer/ui/island/description.ts'))};
    import { defaultProblem } from ${JSON.stringify(modulePath('src/shared/problem.ts'))};
    import { store } from 'fixture-store';
    const pending = [];
    window.iter = { judge: {
      modes: async () => [{id:'standard', name:'普通比较', source:'builtin'}],
      describe: () => new Promise((resolve, reject) => pending.push({resolve,reject}))
    } };
    const problem = {...defaultProblem('main'), timeLimit:2500, memoryLimit:256,
      fileIO:{enabled:true, input:'main.in', output:'main.out'}};
    const paused = {status:'paused', mode:'live', totalSteps:590, stepIndex:100, frame:0, reason:'seek', line:6,
      canStepBack:true, recordingComplete:true, recordingEnded:false, recordingMs:30000, recordingLimit:'time',
      recordingLimits:{maxSteps:20000,maxDurationMs:30000}};
    store.set({files:[{path:'/sample.cpp',name:'sample.cpp',problem,tests:[],model:{getValue:()=>''}}],
      debug:{tab:'variables',state:paused,path:'/sample.cpp',testId:null},breakpoints:{}});
    createRoot(document.getElementById('eval')).render(createElement(EvalPanel));
    createRoot(document.getElementById('debug')).render(createElement(DebugPanel));
    // EvalPanel exposes direct controls; asynchronous file checks must not move them.
    // Badges now have their own wrapping presentation; test that real component separately.
    const badgeRoot = createRoot(document.getElementById('badges'));
    let described;
    const renderBadges = () => badgeRoot.render(createElement(ModeBadges, {
      info: panelDescription(store.get().files[0].problem, [], described)
    }));
    renderBadges();
    const settle = async (ready = () => true) => {
      for(let n=0;n<100;n++) {
        await new Promise(resolve=>setTimeout(resolve,10));
        if(ready()) { document.documentElement.getBoundingClientRect(); return }
      }
      throw Error('Panel did not commit the expected asynchronous state');
    };
    window.__panelLayout = async () => {
      for(let n=0;!document.querySelector('.nvi-params input') || !document.querySelector('#badges .nv-badges') || pending.length !== 1;n++) {
        if(n>100) throw Error('Real panel/hooks did not mount'); await new Promise(resolve=>setTimeout(resolve,10));
      }
      await settle();
      const requireElement = (scope, selector) => {
        const element = scope.querySelector(selector);
        if(!element) throw Error('Missing real layout element: ' + selector);
        return element;
      };
      if(document.querySelector('.nvi-panel select, .nvi-panel [aria-label="返回"]')) throw Error('Island controls must be direct');
      if(!document.querySelector('[aria-label="空白处理"] button')) throw Error('Comparison choices must be directly accessible');
      const isPending = () => Boolean(document.querySelector('.nvi-bar .nv-loading-mark'));
      const snapshot = () => {
        const panel=requireElement(document,'.nvi-panel'), header=requireElement(panel,'.nvi-bar');
        const badges=requireElement(document,'#badges .nv-badges'), input=requireElement(panel,'input');
        const [time,memory]=panel.querySelectorAll('.nvi-params input[type=number]');
        const [inputFile,outputFile]=panel.querySelectorAll('.nvi-io > input');
        return {height:panel.getBoundingClientRect().height,inputY:input.getBoundingClientRect().y,
          buttonWidth:panel.querySelector('.nvi-run-kind button').getBoundingClientRect().width,
          headerHeight:header.getBoundingClientRect().height,pending:String(isPending()),
          limits: Number(time.value)/1000 + ' s · ' + memory.value + ' MB',
          fileIO: inputFile.value + ' → ' + outputFile.value,
          text:badges.textContent,width:badges.clientWidth,scrollWidth:badges.scrollWidth,
          error:header.querySelector('.nvi-description-error')?.getAttribute('title')};
      };
      const before = snapshot();
      described={modeId:'standard',modeName:'普通比较',badges:[
        {label:'限制',value:'stale limit'}, {label:'文件 IO',value:'stale IO'},
        {label:'检查器',value:'checker-with-a-very-long-source-path.cpp'}, {label:'数据',value:'内置 12345 组'}]};
      renderBadges();
      pending.shift().resolve(described);
      await settle(() => !isPending() && document.querySelector('#badges').textContent.includes('checker-with-a-very-long-source-path.cpp'));
      const after = snapshot();
      store.set(current=>({files:[{...current.files[0],problem:{...current.files[0].problem,timeLimit:3000}}]}));
      renderBadges();
      await settle(() => pending.length === 1 && isPending() && document.querySelector('#badges').textContent.includes('3 s · 256 MB'));
      const refresh = snapshot();
      if(pending.length !== 1) throw Error('Settings did not refresh the real describe hook');
      pending.shift().reject(Error('delayed metadata failure'));
      await settle(() => Boolean(document.querySelector('.nvi-description-error')));
      const failed = snapshot();
      store.set(current=>({files:[{...current.files[0],path:'/other.cpp'}]}));
      await settle(() => document.querySelector('.nvi-params input'));
      if(!document.querySelector('[aria-label="空白处理"] button')) throw Error('Another file must expose its controls directly');
      const timeline = document.querySelector('.nv-timeline input');
      const histories = [];
      for(const status of ['paused','running','exited']) {
        store.set(current=>({debug:{...current.debug,state:{...paused,status,exitCode:0,stdout:'',stderr:'',recordingEnded:status==='exited'}}}));
        await settle(() => document.querySelector('.nv-timeline input')?.disabled === (status === 'running')
          && document.querySelector('.nv-debug-status').textContent.includes(status === 'paused' ? '第 6 行' : status === 'running' ? '运行中' : '已退出'));
        const slider = document.querySelector('.nv-timeline input');
        histories.push({status,sameNode:slider===timeline,disabled:slider?.disabled,max:slider?.max,value:slider?.value,
          count:document.querySelector('.nv-timeline-at')?.textContent,
          notice:document.querySelector('.nv-debug-note[role=status]')?.textContent});
      }
      return {before,after,refresh,failed,histories};
    };
  `
    const result = await build({
        configFile: false,
        root: appRoot,
        logLevel: 'silent',
        plugins: [
            {
                name: 'isolated-panel-fixture',
                enforce: 'pre',
                resolveId(source) {
                    if (source === entryId) return '\0' + entryId
                    if (source === 'fixture-store' || /(?:^|\/)state\/app$/.test(source)) return '\0fixture-store'
                    if (/(?:^|\/)actions\/tests$/.test(source)) return '\0fixture-tests'
                    if (/(?:^|\/)actions\/debug$/.test(source)) return '\0fixture-debug'
                    if (/^\.\/(?:VariablesTab|WatchTab|StackTab|BreakpointsTab|OutputDock)$/.test(source))
                        return '\0fixture-pages'
                },
                load(id) {
                    if (id === '\0' + entryId) return entry
                    return sources[id]
                }
            },
            react()
        ],
        build: {
            write: false,
            minify: false,
            emptyOutDir: false,
            rolldownOptions: { input: entryId, output: { format: 'iife', name: 'IterPanelLayout' } }
        }
    })
    const outputs = Array.isArray(result) ? result : [result]
    return outputs
        .flatMap((output) => ('output' in output ? output.output : []))
        .filter((chunk) => chunk.type === 'chunk')
        .map((chunk) => chunk.code)
        .join('\n')
}

interface PanelMeasurement {
    buttonWidth: number
    height: number
    inputY: number
    headerHeight: number
    pending: string
    limits: string
    fileIO: string
    text: string
    width: number
    scrollWidth: number
    error?: string
}
interface PanelResult {
    before: PanelMeasurement
    after: PanelMeasurement
    refresh: PanelMeasurement
    failed: PanelMeasurement
    histories: {
        status: string
        sameNode: boolean
        disabled: boolean
        max: string
        value: string
        count: string
        notice: string
    }[]
}

describe.skipIf(process.env.ITER_TEST_RENDERER_LAYOUT !== '1')(
    'real panel Chromium layout and asynchronous wiring',
    () => {
        it('keeps limits/IO and geometry stable through delayed describe, and preserves live-prefix timeline/notice', async () => {
            const temp = await mkdtemp(path.join(os.tmpdir(), 'iter-panels-layout-'))
            try {
                const [bundle, css] = await Promise.all([
                    fixtureBundle(),
                    Promise.all(
                        ['base', 'panels', 'island'].map((name) =>
                            readFile(new URL(`../styles/${name}.css`, import.meta.url), 'utf8')
                        )
                    ).then((parts) => parts.join('\n'))
                ])
                await writeFile(
                    path.join(temp, 'index.html'),
                    `<!doctype html><meta charset="utf-8"><style>${css}
        body{overflow:auto} #eval{position:relative;transform:none;left:auto;top:auto;width:640px} #debug{width:460px}
        #badges{width:640px}
        </style><section id="eval" class="nvi is-open"></section><section id="debug"></section><section id="badges"></section><script>${bundle.replaceAll('</script', '<\\/script')}</script>`
                )
                await writeFile(
                    path.join(temp, 'main.cjs'),
                    `
        const {app,BrowserWindow}=require('electron'), fs=require('node:fs'), path=require('node:path');
        for(const name of ['appData','userData','sessionData','logs','crashDumps']) {
          const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);
        }
        app.disableHardwareAcceleration();
        app.whenReady().then(async()=>{
          const window=new BrowserWindow({show:false,width:1200,height:900,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
          await window.loadFile(path.join(__dirname,'index.html'));
          const result=await window.webContents.executeJavaScript('window.__panelLayout()');
          fs.writeFileSync(path.join(__dirname,'result.json'),JSON.stringify(result));window.destroy();app.quit();
        }).catch(error=>{console.error(error);app.exit(1)});
      `
                )
                const env = { ...process.env }
                delete env.ELECTRON_RUN_AS_NODE
                const electron = createRequire(import.meta.url)('electron') as string
                await promisify(execFile)(electron, ['--no-sandbox', path.join(temp, 'main.cjs')], {
                    env,
                    timeout: 30_000,
                    windowsHide: true
                })
                const result = JSON.parse(await readFile(path.join(temp, 'result.json'), 'utf8')) as PanelResult
                if (process.env.ITER_DEBUG_REPORT_ROOT)
                    await writeFile(
                        path.join(process.env.ITER_DEBUG_REPORT_ROOT, 'test-results', 'panels-layout.json'),
                        JSON.stringify(result, null, 2)
                    )
                expect(result.before.pending).toBe('true')
                expect(result.before.text).toContain('2.5 s · 256 MB')
                expect(result.before.text).toContain('main.in → main.out')
                expect(result.before.limits).toBe('2.5 s · 256 MB')
                expect(result.before.fileIO).toBe('main.in → main.out')
                expect(result.after.pending).toBe('false')
                expect(result.after.text).toContain('checker-with-a-very-long-source-path.cpp')
                expect(result.after.text).not.toContain('stale')
                expect(result.after.scrollWidth).toBeLessThanOrEqual(result.after.width)
                expect(result.refresh.pending).toBe('true')
                expect(result.refresh.text).toContain('3 s · 256 MB')
                expect(result.refresh.limits).toBe('3 s · 256 MB')
                expect(result.refresh.fileIO).toBe(result.before.fileIO)
                expect(result.failed.error).toBe('delayed metadata failure')
                for (const row of [result.after, result.refresh, result.failed]) {
                    expect(row.buttonWidth).toBeCloseTo(result.before.buttonWidth, 1)
                    expect(row.height).toBeCloseTo(result.before.height, 1)
                    expect(row.inputY).toBeCloseTo(result.before.inputY, 1)
                    expect(row.headerHeight).toBeCloseTo(result.before.headerHeight, 1)
                }
                for (const row of result.histories) {
                    expect(row.sameNode, row.status).toBe(true)
                    expect(row.disabled, row.status).toBe(row.status === 'running')
                    expect(row.max, row.status).toBe('589')
                    expect(row.count, row.status).toBe('101 / 590')
                    expect(row.notice, row.status).toContain('30 秒上限')
                    expect(row.notice, row.status).toContain('590 步仍可回放')
                }
                expect(result.histories[0].notice).toContain('实时调试')
                expect(result.histories[2].notice).toContain('程序已结束')
            } finally {
                const target = path.resolve(temp)
                if (
                    path.dirname(target) !== path.resolve(os.tmpdir()) ||
                    !path.basename(target).startsWith('iter-panels-layout-')
                )
                    throw Error('Unexpected panel layout cleanup path')
                await rm(target, { recursive: true, force: true })
            }
        }, 45_000)
    }
)
