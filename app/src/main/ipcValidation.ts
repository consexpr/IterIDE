import type { IpcChannel } from '../shared/ipc'
import { interactorFilesError } from '../shared/interactorSource'

type Check = (value: unknown) => boolean
const text: Check = (value) => typeof value === 'string'
const filename: Check = (value) => text(value) && (value as string).length > 0 && !(value as string).includes('\0')
const bool: Check = (value) => typeof value === 'boolean'
const object: Check = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const arrayOf =
    (check: Check): Check =>
    (value) =>
        Array.isArray(value) && value.every(check)
const optional =
    (check: Check): Check =>
    (value) =>
        value === undefined || check(value)
const oneOf =
    (...values: unknown[]): Check =>
    (value) =>
        values.includes(value)
const integer: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0
const sourceRequest: Check = (value) =>
    object(value) &&
    filename((value as Record<string, unknown>).sourcePath) &&
    text((value as Record<string, unknown>).source)
const testEdit: Check = (value) =>
    object(value) && text((value as Record<string, unknown>).input) && text((value as Record<string, unknown>).answer)

/** Validate transport shapes here; domain modules validate field contents and ownership. */
const argumentsByChannel = {
    'snapshots:list': [filename],
    'snapshots:create': [filename, text, optional(text)],
    'snapshots:read': [filename, text],
    'snapshots:rename': [filename, text, text],
    'snapshots:delete': [filename, text],
    'config:export': [optional(filename)],
    'config:import': [optional(filename)],
    'toolchain:status': [],
    'toolchain:healthState': [],
    'toolchain:check': [],
    'toolchain:cancelCheck': [],
    'format:run': [filename, text, optional(object)],
    'dev:capture': [filename],
    'apiHistory:list': [],
    'apiHistory:delete': [text],
    'apiHistory:clear': [],
    'inline:complete': [object],
    'model:rank': [object],
    'model:warmup': [],
    'fs:readText': [filename],
    'fs:writeText': [
        filename,
        text,
        optional((value) => {
            if (!object(value)) return false
            const options = value as Record<string, unknown>
            return (
                (options.expected === null || optional(text)(options.expected)) &&
                optional(bool)(options.confirmOverwrite)
            )
        })
    ],
    'fs:exists': [filename],
    'fs:createUntitled': [(value) => integer(value) && (value as number) > 0, text],
    'fs:discardUntitled': [filename],
    'fs:sweepUntitled': [arrayOf(filename)],
    'fs:openFileDialog': [optional(object)],
    'fs:saveFileDialog': [optional(text)],
    'problem:load': [filename],
    'problem:save': [filename, object],
    'problem:patch': [filename, object],
    'problem:updateTest': [filename, filename, object],
    'problem:listTests': [filename],
    'problem:readTest': [filename, filename],
    'problem:readTests': [filename],
    'problem:writeTest': [filename, testEdit],
    'problem:deleteTests': [filename, arrayOf(filename)],
    'problem:attachFile': [filename, filename, oneOf('checker', 'interactor')],
    'problem:attachCode': [filename, text],
    'problem:readAttached': [filename, filename],
    'problem:readChecker': [filename],
    'problem:readInteractor': [filename],
    'problem:writeInteractor': [filename, (value) => interactorFilesError(value) === undefined, optional(text)],
    'problem:saved': [filename, text],
    'problem:moveSource': [filename, filename],
    'problem:remove': [filename],
    'importer:preview': [(value) => filename(value) || arrayOf(filename)(value)],
    'importer:apply': [object],
    'importer:previewFolder': [filename],
    'importer:applyFolder': [object],
    'importer:detectForSource': [filename],
    'judge:compile': [filename, text, optional(bool)],
    'judge:run': [sourceRequest],
    'judge:stop': [optional(filename)],
    'judge:syntaxCheck': [filename, text],
    'judge:modes': [],
    'judge:describe': [filename],
    'terminal:run': [sourceRequest],
    'terminal:stop': [optional(filename)],
    'debug:start': [sourceRequest],
    'debug:command': [
        oneOf('continue', 'stepOver', 'next', 'stepIn', 'stepOut', 'stepBack', 'pause', 'stop', 'restart')
    ],
    'debug:setBreakpoints': [filename, arrayOf(object)],
    'debug:evaluate': [text],
    'debug:inspect': [text],
    'debug:locals': [],
    'debug:children': [text],
    'debug:stack': [],
    'debug:runToCursor': [filename, (value) => integer(value) && (value as number) > 0],
    'debug:selectFrame': [integer],
    'debug:breakpoints': [],
    'debug:seek': [integer],
    'lsp:start': [filename],
    'lsp:restart': [],
    'lsp:stop': [],
    'lsp:refreshCompileFlags': [filename],
    'plugins:list': [],
    'plugins:openFolder': [],
    'plugins:panels': [],
    'plugins:invoke': [filename, filename, Array.isArray],
    'plugins:reload': [],
    'sync:state': [],
    'sync:loginDevice': [],
    'sync:loginToken': [filename],
    'sync:logout': [],
    'sync:syncNow': [],
    'settings:get': [],
    'settings:set': [object],
    'settings:userDirs': [],
    'settings:listUserThemes': [],
    'settings:listUserFonts': [],
    'settings:openUserDir': [oneOf('themes', 'fonts', 'plugins')],
    'session:load': [],
    'session:save': [object],
    'app:confirmUnsaved': [text],
    'app:resolveClose': [filename, oneOf('ready', 'cancel')],
    'app:recover': [oneOf('restart', 'exit')],
    'app:rendererStatus': [oneOf('ready', 'failed')],
    'app:openExternal': [filename]
} satisfies Record<IpcChannel, readonly Check[]>

export function validateIpcArguments(channel: IpcChannel, args: readonly unknown[]): void {
    const checks: readonly Check[] = argumentsByChannel[channel]
    if (args.length > checks.length || !checks.every((check, index) => check(args[index]))) {
        // Do not interpolate argument values: some calls contain credentials or source code.
        throw new Error(`Invalid arguments for ${channel}`)
    }
}
