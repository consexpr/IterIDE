import { APP_NAME } from '../../shared/brand'
import { statSync } from 'node:fs'
import path from 'node:path'
import type { ResolvedTool } from '../../shared/judge'

const operandOptions = new Set([
    '-I',
    '-L',
    '-l',
    '-D',
    '-U',
    '-include',
    '-imacros',
    '-isystem',
    '-iquote',
    '-idirafter',
    '-iprefix',
    '-iwithprefix',
    '-iwithprefixbefore'
])
const resolution = `请将 ${APP_NAME} 安装到仅含 ASCII 字符的路径，或用 -fuse-ld=... 显式选择兼容的链接器。`

/** WinLibs GCC accepts Unicode paths, but its GNU ld cannot open forward-slash
 * Unicode library paths. The bundled lld handles ordinary native objects; GCC
 * LTO and GNU-specific configuration must retain the user's linker semantics. */
export function compilerFlags(
    tool: ResolvedTool,
    flags: readonly string[],
    platform: NodeJS.Platform = process.platform
): string[] {
    if (
        platform !== 'win32' ||
        tool.source !== 'bundled' ||
        path.basename(tool.command).toLowerCase() !== 'g++.exe' ||
        !/[^\x00-\x7f]/.test(tool.command) ||
        flags.some((flag) => /^-fuse-ld(?:=|$)/.test(flag))
    )
        return [...flags]

    for (let i = 0; i < flags.length; i++) {
        const flag = flags[i]
        if (operandOptions.has(flag)) {
            i++
            continue
        }
        if (
            flag.startsWith('@') ||
            /^-(?:flto|fwhole-program|fuse-linker-plugin)(?:=|$)/.test(flag) ||
            /^(?:-Wl(?:,|$)|-Xlinker(?:=|$)|-T|--script(?:=|$)|--?specs(?:=|$)|--sysroot(?:=|$)|-isysroot(?:=|$)|-B|-fplugin(?:=|$)|-wrapper(?:=|$))/.test(
                flag
            ) ||
            /\.(?:a|o|obj|so(?:\.\d+)*|dylib|lib|dll|ld|lds|def|res|exp)$/i.test(flag)
        ) {
            throw new Error(`内置 GCC 安装路径含非 ASCII 字符，无法为参数 ${flag} 安全地自动选择链接器。${resolution}`)
        }
    }
    const linker = path.join(path.dirname(tool.command), 'ld.lld.exe')
    let available = false
    try {
        available = statSync(linker).isFile()
    } catch {
        /* An incomplete bundle must produce an actionable error. */
    }
    if (!available)
        throw new Error(
            `内置 ld.lld.exe 缺失或无效，无法处理含非 ASCII 字符的安装路径。请重新安装完整工具链。${resolution}`
        )
    return [...flags, '-fuse-ld=lld']
}
