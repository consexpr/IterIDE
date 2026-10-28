// A local-only preview of real renderer components; all file/judge actions use synthetic data.
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, '.cache', 'judge-preview')
const modulePath = (name) => JSON.stringify(path.join(root, 'src', 'renderer', name).replaceAll('\\', '/'))
const actions = new Map([
    ['debug', 'startDebug'],
    ['judge', 'runTests,stopRun'],
    ['terminal', 'runTerminal,stopTerminal'],
    ['folders', 'importFolderIntoActive,importFolder'],
    ['files', 'openFile,closeFile,newUntitled,openFilesDialog,saveFile'],
    [
        'tests',
        'addTest,importDirect,acceptOutput,deleteTests,editTest,loadIntoTest,setCompareOutput,toggleTest,attachJudgeFile,importPaths'
    ],
    ['testPreviews', 'loadTestPreview']
])
const entry = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {JudgePanel} from ${modulePath('ui/JudgePanel.tsx')};
import {store,updateFile} from ${modulePath('state/app.ts')};
import ${modulePath('styles/base.css')}; import ${modulePath('styles/panels.css')}; import ${modulePath('styles/dialogs.css')};
window.__store=store; window.__update=updateFile; window.__runs=[];
window.iter={judge:{describe:async()=>null}};
const tests=Array.from({length:1000},(_,i)=>({id:String(i),name:String(i+1),enabled:true,input:'3\\n1 2 3',answer:'alpha\\nbeta\\ngamma',previewLoaded:true,inputSize:7,answerSize:16,truncated:false}));
store.set({activePath:'/sample.cpp',files:[{path:'/sample.cpp',name:'sample.cpp',model:{},problem:{mode:'standard',checker:{kind:'builtin',builtin:'tokens'}},tests,results:{'500':{testId:'500',verdict:'WA',output:'alpha\\nextra\\nbeta\\ngamma',stderr:'',timeMs:3,exitCode:0}},runId:null,terminalRunId:null,terminalPending:false,compile:null}]});
createRoot(document.getElementById('root')).render(React.createElement(JudgePanel));
const metrics=document.getElementById('metrics');
const report=()=>{metrics.textContent='已挂载 '+document.querySelectorAll('.nv-test').length+' / 1000 张卡片；运行项 '+window.__runs.join(',')};
new MutationObserver(report).observe(document.getElementById('root'),{childList:true,subtree:true});
document.getElementById('narrow').onchange=e=>{document.getElementById('root').style.width=e.target.checked?'340px':'540px'};
document.getElementById('check').onclick=async()=>{
 const button=document.getElementById('check'),result=document.getElementById('result');button.disabled=true;
 const until=async test=>{for(let i=0;i<100;i++){if(test())return;await new Promise(r=>setTimeout(r,20))}throw Error('界面未更新')};
 try{
  await until(()=>document.querySelectorAll('.nv-test').length>0);
  if(document.querySelectorAll('.nv-test').length>45)throw Error('初始卡片过多');
  document.querySelector('.nv-tests').scrollTop=500*44;
  await until(()=>document.querySelector('[data-test-id="500"] [data-test-toggle]'));
  document.querySelector('[data-test-id="500"] [data-test-toggle]').click();
  await until(()=>document.querySelector('[data-test-id="500"] textarea'));
  const input=document.querySelector('[data-test-id="500"] textarea');input.focus();
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'保留编辑内容');input.dispatchEvent(new Event('input',{bubbles:true}));
  await until(()=>store.get().files[0].tests[500].input==='保留编辑内容');
  document.querySelector('.nv-tests').scrollTop=0;await new Promise(r=>setTimeout(r,120));
  if(!document.querySelector('[data-test-id="500"] textarea'))throw Error('编辑卡片被卸载');
  document.querySelector('[data-test-id="500"] [title="只运行这个"]').click();
  if(window.__runs.join(',')!=='500')throw Error('运行范围错误');
  input.focus();input.setSelectionRange(0,input.value.length);
  const large='9'.repeat(120_000),clipboard=new DataTransfer();clipboard.setData('text/plain',large);
  const paste=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:clipboard});input.dispatchEvent(paste);
  if(!paste.defaultPrevented)throw Error('大段粘贴未接管');
  await until(()=>store.get().files[0].tests[500].input===large && input.readOnly && input.value.length===100_000);
  input.blur();
  result.textContent='通过：可见区域挂载、样例展开、编辑保留、单项运行和大段粘贴预览';report();
 }catch(error){result.textContent='失败：'+error.message}finally{button.disabled=false}
};
`
await mkdir(output, { recursive: true })
if (path.dirname(output) !== path.join(root, '.cache')) throw Error('Unexpected preview output directory')
await build({
    configFile: false,
    root,
    logLevel: 'warn',
    plugins: [
        {
            name: 'synthetic-judge',
            enforce: 'pre',
            resolveId(id) {
                if (id === 'virtual:preview') return '\0preview'
                if (/(?:^|\/)commands\/registry$/.test(id)) return '\0keys'
                const action = /(?:^|\/)actions\/([^/]+)$/.exec(id)?.[1]
                if (actions.has(action)) return `\0action:${action}`
            },
            load(id) {
                if (id === '\0preview') return entry
                if (id === '\0keys') return 'export const withKey=label=>label;'
                if (id.startsWith('\0action:'))
                    return actions
                        .get(id.slice(8))
                        .split(',')
                        .map((name) => {
                            if (name === 'editTest')
                                return `export const editTest=(id,patch)=>window.__update('/sample.cpp',f=>({tests:f.tests.map(t=>t.id===id?{...t,...patch}:t)}));`
                            if (name === 'runTests') return `export const runTests=async(ids)=>{window.__runs=ids||[]};`
                            return `export const ${name}=async()=>{};`
                        })
                        .join('\n')
            }
        },
        react()
    ],
    build: {
        outDir: output,
        emptyOutDir: true,
        minify: false,
        rolldownOptions: { input: 'virtual:preview', output: { entryFileNames: 'fixture.js' } }
    }
})
// Vite's generated entry imports CSS via HTML only; attach its emitted stylesheet explicitly.
const { readdir } = await import('node:fs/promises')
const styles = (await readdir(path.join(output, 'assets'))).filter((name) => name.endsWith('.css'))
await writeFile(
    path.join(output, 'index.html'),
    `<!doctype html><meta charset="utf-8"><title>ITER 测试列表预览</title>${styles.map((name) => `<link rel="stylesheet" href="assets/${name}">`).join('')}
<style>:root{--v-wa:#e99188;--v-ac:#9cc99d;--v-tle:#d8b673;--v-re:#df8bac}body{padding:24px;overflow:auto}#root{width:540px;height:720px;display:flex;border:1px solid var(--border);margin-top:16px}header{display:flex;align-items:center;gap:16px}#metrics,#result{color:var(--text-muted);margin:8px 0}</style>
<header><b>ITER 测试列表预览</b><label><input id="narrow" type="checkbox">较窄面板</label><button class="nv-btn" id="check">检查交互</button></header><p id="metrics"></p><p id="result" role="status"></p><div id="root"></div><script type="module" src="fixture.js"></script>`
)
const server = createServer(async (request, response) => {
    try {
        const requested = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
        const target = path.resolve(output, '.' + (requested === '/' ? '/index.html' : requested))
        if (!target.startsWith(output + path.sep)) {
            response.writeHead(403).end()
            return
        }
        const content = await readFile(target)
        response.setHeader(
            'Content-Type',
            target.endsWith('.html')
                ? 'text/html; charset=utf-8'
                : target.endsWith('.css')
                  ? 'text/css'
                  : 'text/javascript'
        )
        response.end(content)
    } catch {
        response.writeHead(404).end()
    }
})
server.listen(0, '127.0.0.1', () => console.log(`PREVIEW http://127.0.0.1:${server.address().port}`))
