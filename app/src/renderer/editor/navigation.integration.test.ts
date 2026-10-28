import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'

describe.skipIf(process.env.ITER_TEST_RENDERER_LAYOUT !== '1')('editor indentation navigation in Chromium', () => {
    it('preserves navigation and applies explicit indentation to existing and newly opened models', async () => {
        const temp = await mkdtemp(path.join(os.tmpdir(), 'iter-editor-navigation-'))
        try {
            const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
            const entryId = 'virtual:iter-navigation'
            const originalLines = [
                'int main() {',
                '    int a =  1;  // keep  inner  spaces',
                '        a +=  2;',
                '    ',
                '\t  int mixed =  2;',
                '    const char* raw = R"tag(first',
                '        raw  body',
                '    )tag";',
                "    const int character = '\\",
                "    ';",
                '    #define KEEP(value) \\',
                '        value +  1',
                '    return a;',
                '}'
            ]
            const convertedLines = [
                'int main() {',
                '  int a =  1;  // keep  inner  spaces',
                '    a +=  2;',
                '  ',
                '    int mixed =  2;',
                '  const char* raw = R"tag(first',
                '        raw  body',
                '    )tag";',
                "  const int character = '\\",
                "    ';",
                '  #define KEEP(value) \\',
                '        value +  1',
                '  return a;',
                '}'
            ]
            const entry = String.raw`
        import { monaco, editorOptions } from ${JSON.stringify(path.join(root, 'src/renderer/editor/monaco.ts').replaceAll('\\', '/'))};
        import { applyModelIndentation } from ${JSON.stringify(path.join(root, 'src/renderer/editor/indentation.ts').replaceAll('\\', '/'))};
        import { defaultSettings } from ${JSON.stringify(path.join(root, 'src/shared/settings.ts').replaceAll('\\', '/'))};
        const settings=defaultSettings().editor;
        const editor=monaco.editor.create(document.getElementById('editor'), {...editorOptions(settings),model:null});
        const options=model=>{
          const {tabSize,indentSize,insertSpaces,trimAutoWhitespace}=model.getOptions();
          return {tabSize,indentSize,insertSpaces,trimAutoWhitespace};
        };
        window.runNavigation=async()=>{
          const navigation=[];
          for(const insertSpaces of [true,false]) for(const eol of [0,1]) {
            editor.updateOptions(editorOptions({...settings,insertSpaces,tabSize:4}));
            const model=monaco.editor.createModel('', 'cpp');model.setEOL(eol);editor.setModel(model);
            editor.setPosition({lineNumber:1,column:1});editor.trigger('keyboard','tab',null);
            const indentation=model.getLineContent(1);
            editor.trigger('keyboard','type',{text:'\n'});editor.trigger('keyboard','tab',null);
            editor.trigger('keyboard','cursorUp',null);
            navigation.push({insertSpaces,eol,indentation,firstLine:model.getLineContent(1),position:editor.getPosition()});
            model.setValue('\t\n\t');editor.setPosition({lineNumber:2,column:2});editor.trigger('keyboard','cursorUp',null);
            navigation.push({existing:true,firstLine:model.getLineContent(1),indentation:'\t',position:editor.getPosition()});
            editor.setModel(null);model.dispose();
          }

          const four={...settings,tabSize:4,insertSpaces:true};
          const two={...settings,tabSize:2,insertSpaces:true};
          editor.updateOptions(editorOptions(four));
          const model=monaco.editor.createModel(${JSON.stringify(originalLines)}.join('\r\n'),'cpp');
          model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
          applyModelIndentation(model,four);editor.setModel(model);
          const before=model.getValue();
          applyModelIndentation(model,two,true,editor);
          const conversion={text:model.getValue(),eol:model.getEOL(),lines:model.getLineCount(),options:options(model)};
          await model.undo();conversion.undone=model.getValue();
          editor.setModel(null);model.dispose();

          const switchModel=monaco.editor.createModel('    first(  1);\n        second();','cpp');
          applyModelIndentation(switchModel,four);
          applyModelIndentation(switchModel,{...two,insertSpaces:false},true,editor);
          const spaceToTabs={text:switchModel.getValue(),options:options(switchModel)};
          applyModelIndentation(switchModel,two,true,editor);
          const tabsToSpaces={text:switchModel.getValue(),options:options(switchModel)};
          switchModel.dispose();

          const models=[monaco.editor.createModel('    first();','cpp'),monaco.editor.createModel('        second();','cpp')];
          for(const opened of models)applyModelIndentation(opened,four);
          editor.setModel(models[0]);
          for(const opened of models)applyModelIndentation(opened,two,true,editor);
          const opened=models.map(opened=>({text:opened.getValue(),options:options(opened)}));
          editor.updateOptions(editorOptions(two));
          const typing=[];
          for(const opened of [models[0],models[1],models[0]]){
            editor.setModel(opened);opened.setValue('');editor.setPosition({lineNumber:1,column:1});
            editor.trigger('keyboard','tab',null);
            const tab=opened.getLineContent(1);
            editor.trigger('keyboard','type',{text:'\n'});
            const enter=opened.getLineContent(2);
            editor.trigger('keyboard','tab',null);
            typing.push({tab,enter,nextTab:opened.getLineContent(2),options:options(opened)});
          }
          editor.setModel(null);for(const opened of models)opened.dispose();

          const newlyOpened=monaco.editor.createModel('    existing(  1);\n        indentation();','cpp');
          const original=newlyOpened.getValue();
          applyModelIndentation(newlyOpened,two);editor.setModel(newlyOpened);
          const opening={before:original,after:newlyOpened.getValue(),options:options(newlyOpened)};
          editor.setModel(null);newlyOpened.dispose();
          editor.dispose();return {navigation,indentation:{before,conversion,spaceToTabs,tabsToSpaces,opened,typing,opening}};
        };
      `
            await build({
                configFile: false,
                root,
                base: './',
                logLevel: 'silent',
                plugins: [
                    {
                        name: 'navigation-fixture',
                        resolveId: (id) => (id === entryId ? '\0' + entryId : undefined),
                        load: (id) => (id === '\0' + entryId ? entry : undefined)
                    }
                ],
                build: {
                    outDir: path.join(temp, 'web'),
                    emptyOutDir: false,
                    rolldownOptions: { input: entryId, output: { entryFileNames: 'index.js' } }
                }
            })
            const styles = (await readdir(path.join(temp, 'web/assets')))
                .filter((name) => name.endsWith('.css'))
                .map((name) => `<link rel="stylesheet" href="assets/${name}">`)
                .join('')
            await writeFile(
                path.join(temp, 'web/index.html'),
                `<!doctype html><meta charset="utf-8">${styles}<div id="editor" style="height:600px;width:800px"></div><script type="module" src="index.js"></script>`
            )
            await mkdir(path.join(temp, 'shell'))
            await writeFile(
                path.join(temp, 'shell/main.cjs'),
                `
        const {app,BrowserWindow}=require('electron'),fs=require('node:fs'),path=require('node:path');
        for(const name of ['appData','userData','sessionData','logs','crashDumps']){const dir=path.join(__dirname,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir);}
        app.disableHardwareAcceleration();app.whenReady().then(async()=>{
          const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
          await window.loadFile(path.join(__dirname,'../web/index.html'));
          const result=await window.webContents.executeJavaScript('window.runNavigation()');
          fs.writeFileSync(path.join(__dirname,'../result.json'),JSON.stringify(result));window.destroy();app.quit();
        }).catch(error=>{console.error(error);app.exit(1)});
      `
            )
            const env = { ...process.env }
            delete env.ELECTRON_RUN_AS_NODE
            await promisify(execFile)(
                createRequire(import.meta.url)('electron'),
                ['--no-sandbox', path.join(temp, 'shell/main.cjs')],
                { env, timeout: 30_000, windowsHide: true }
            )
            type Options = { tabSize: number; indentSize: number; insertSpaces: boolean; trimAutoWhitespace: boolean }
            const results = JSON.parse(await readFile(path.join(temp, 'result.json'), 'utf8')) as {
                navigation: {
                    indentation: string
                    firstLine: string
                    position: { lineNumber: number; column: number }
                }[]
                indentation: {
                    before: string
                    conversion: { text: string; eol: string; lines: number; options: Options; undone: string }
                    spaceToTabs: { text: string; options: Options }
                    tabsToSpaces: { text: string; options: Options }
                    opened: { text: string; options: Options }[]
                    typing: { tab: string; enter: string; nextTab: string; options: Options }[]
                    opening: { before: string; after: string; options: Options }
                }
            }
            expect(results.navigation).toHaveLength(8)
            for (const result of results.navigation) {
                expect(result.firstLine, JSON.stringify(result)).toBe(result.indentation)
                expect(result.position).toEqual({ lineNumber: 1, column: result.indentation.length + 1 })
            }
            const indentation = results.indentation
            const twoSpaces = { tabSize: 2, indentSize: 2, insertSpaces: true, trimAutoWhitespace: false }
            expect(indentation.before).toBe(originalLines.join('\r\n'))
            expect(indentation.conversion).toEqual({
                text: convertedLines.join('\r\n'),
                eol: '\r\n',
                lines: originalLines.length,
                options: twoSpaces,
                undone: originalLines.join('\r\n')
            })
            expect(indentation.spaceToTabs).toEqual({
                text: '\tfirst(  1);\n\t\tsecond();',
                options: { ...twoSpaces, insertSpaces: false }
            })
            expect(indentation.tabsToSpaces).toEqual({ text: '  first(  1);\n    second();', options: twoSpaces })
            expect(indentation.opened).toEqual([
                { text: '  first();', options: twoSpaces },
                { text: '    second();', options: twoSpaces }
            ])
            expect(indentation.typing).toEqual(
                Array.from({ length: 3 }, () => ({ tab: '  ', enter: '  ', nextTab: '    ', options: twoSpaces }))
            )
            expect(indentation.opening).toEqual({
                before: '    existing(  1);\n        indentation();',
                after: '    existing(  1);\n        indentation();',
                options: twoSpaces
            })
        } finally {
            if (
                path.dirname(path.resolve(temp)) !== path.resolve(os.tmpdir()) ||
                !path.basename(temp).startsWith('iter-editor-navigation-')
            )
                throw Error('Unexpected navigation cleanup path')
            await rm(temp, { recursive: true, force: true })
        }
    }, 45_000)
})
