import { scanCpp } from './cppSource'

export interface CheckerSourceInfo {
    kind: 'testlib' | 'n-check' | 'unknown' | 'invalid'
    label: string
    usesTestlib: boolean
    message?: string
}

/** Source evidence only: filenames and quoted examples do not determine a checker's protocol. */
export function inspectCheckerSource(source: string): CheckerSourceInfo {
    const { body, includes } = scanCpp(source)
    const usesTestlib = includes.includes('testlib.h')
    if (/\bregisterInteraction\s*\(/.test(body))
        return { kind: 'invalid', label: '交互器', usesTestlib, message: '这是交互器，请在交互运行中选择它' }
    if (/\b(?:registerValidation|registerValidationFor|registerGen)\s*\(/.test(body))
        return {
            kind: 'invalid',
            label: '非 checker',
            usesTestlib,
            message: '这是数据校验器或生成器，不能用来检查解答输出'
        }
    if (usesTestlib && /\bregisterTestlibCmd\s*\(/.test(body)) return { kind: 'testlib', label: 'testlib', usesTestlib }
    if (!usesTestlib && /^\s*\/\/\s*n-check\s+1(?:\s|$)/.test(source))
        return { kind: 'n-check', label: 'n-check', usesTestlib }
    return {
        kind: 'unknown',
        label: '待核对',
        usesTestlib,
        message: '未识别出明确协议；默认依次传入输入、实际输出、答案文件，请核对 checker 的约定'
    }
}
