import path from 'node:path'
import {
    defaultProblem,
    resolveBuiltin,
    type CheckerLayout,
    type CheckerValue,
    type ProblemConfig,
    type TestCaseMeta
} from '../../shared/problem'
import { validId } from './identity'
import { relocateLegacyProblem } from '../legacyStorage'

export function validPath(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && !value.includes('\0')
}

/** Stored comparator as its two choices; older combined ids such as 'float6' are split on the way in. */
function builtinChecker(checker: ProblemConfig['checker'] | undefined): {
    builtin: CheckerLayout
    value?: CheckerValue
} {
    const { layout, value } = resolveBuiltin(checker?.builtin, checker?.value)
    return { builtin: layout, ...(value === 'text' ? {} : { value }) }
}

export function normalize(src: string, value: unknown): ProblemConfig {
    const base = defaultProblem(path.parse(src).name)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return base
    const raw = value as Partial<ProblemConfig>
    const positive = (n: unknown, fallback: number): number =>
        typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback
    const checker = raw.checker
    const seen = new Set<string>()
    const tests: TestCaseMeta[] = []
    for (const t of Array.isArray(raw.tests) ? raw.tests : []) {
        if (!t || !validId(t.id) || seen.has(t.id)) continue
        if (t.link && (!validPath(t.link.input) || (t.link.answer !== undefined && !validPath(t.link.answer)))) continue
        seen.add(t.id)
        tests.push({
            id: t.id,
            name: typeof t.name === 'string' ? t.name : t.id,
            enabled: t.enabled !== false,
            ...(typeof t.compareOutput === 'boolean' ? { compareOutput: t.compareOutput } : {}),
            ...(typeof t.sample === 'boolean' ? { sample: t.sample } : {}),
            ...(t.link
                ? {
                      link: {
                          input: path.resolve(path.dirname(src), t.link.input),
                          ...(t.link.answer !== undefined
                              ? { answer: path.resolve(path.dirname(src), t.link.answer) }
                              : {})
                      }
                  }
                : {}),
            ...(typeof t.timeLimit === 'number' && t.timeLimit > 0 ? { timeLimit: t.timeLimit } : {})
        })
    }
    return relocateLegacyProblem({
        ...base,
        title: typeof raw.title === 'string' ? raw.title : base.title,
        ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
        ...(Array.isArray(raw.tags) ? { tags: raw.tags.filter((t): t is string => typeof t === 'string') } : {}),
        timeLimit: positive(raw.timeLimit, base.timeLimit),
        memoryLimit: positive(raw.memoryLimit, base.memoryLimit),
        // Availability belongs to judge dispatch. Persist plugin-owned ids/options even when unloaded.
        mode: typeof raw.mode === 'string' && raw.mode.length > 0 ? raw.mode : base.mode,
        ...(raw.modeOptions && typeof raw.modeOptions === 'object' && !Array.isArray(raw.modeOptions)
            ? { modeOptions: raw.modeOptions }
            : {}),
        checker: {
            kind: checker?.kind === 'custom' ? 'custom' : 'builtin',
            ...builtinChecker(checker),
            ...(typeof checker?.path === 'string' ? { path: checker.path } : {}),
            ...(typeof checker?.args === 'string' ? { args: checker.args } : {}),
            ...(checker?.relativeTo === 'source' ? { relativeTo: 'source' as const } : {})
        },
        ...(typeof raw.interactor?.path === 'string'
            ? {
                  interactor: {
                      path: raw.interactor.path,
                      ...(Array.isArray(raw.interactor.files) ? { files: raw.interactor.files.filter(validPath) } : {}),
                      args: typeof raw.interactor.args === 'string' ? raw.interactor.args : undefined,
                      ...(raw.interactor.relativeTo === 'source' ? { relativeTo: 'source' as const } : {})
                  }
              }
            : {}),
        ...(Array.isArray(raw.grader?.sources)
            ? {
                  grader: {
                      sources: raw.grader.sources.filter(validPath),
                      ...(Array.isArray(raw.grader.includeDirs)
                          ? { includeDirs: raw.grader.includeDirs.filter(validPath) }
                          : {})
                  }
              }
            : {}),
        fileIO: {
            enabled: raw.fileIO?.enabled === true,
            input: typeof raw.fileIO?.input === 'string' ? raw.fileIO.input : base.fileIO.input,
            output: typeof raw.fileIO?.output === 'string' ? raw.fileIO.output : base.fileIO.output,
            ...(['freopen', 'manual'].includes(raw.fileIO?.origin ?? '') ? { origin: raw.fileIO!.origin } : {})
        },
        ...(typeof raw.extraFlags === 'string' ? { extraFlags: raw.extraFlags } : {}),
        ...(Array.isArray(raw.cachedIncludes)
            ? {
                  cachedIncludes: raw.cachedIncludes.filter(
                      (value): value is string =>
                          typeof value === 'string' &&
                          value.startsWith('resources/') &&
                          !value.split(/[\\/]/).includes('..') &&
                          !value.includes('\0')
                  )
              }
            : {}),
        ...(typeof raw.cachedSourceKey === 'string' ? { cachedSourceKey: raw.cachedSourceKey } : {}),
        ...(raw.cachedHeaders && typeof raw.cachedHeaders === 'object' && !Array.isArray(raw.cachedHeaders)
            ? {
                  cachedHeaders: Object.fromEntries(
                      Object.entries(raw.cachedHeaders).filter(
                          ([name, target]) =>
                              !['__proto__', 'constructor', 'prototype'].includes(name) &&
                              typeof target === 'string' &&
                              target.startsWith('resources/') &&
                              !target.split(/[\\/]/).includes('..')
                      )
                  )
              }
            : {}),
        ...(raw.cachedRuntime && typeof raw.cachedRuntime === 'object' && !Array.isArray(raw.cachedRuntime)
            ? {
                  cachedRuntime: Object.fromEntries(
                      Object.entries(raw.cachedRuntime).filter(
                          ([name, target]) =>
                              !['__proto__', 'constructor', 'prototype'].includes(name) &&
                              typeof target === 'string' &&
                              target.startsWith('resources/') &&
                              !target.split(/[\\/]/).includes('..')
                      )
                  )
              }
            : {}),
        tests
    })
}
