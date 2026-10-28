export const CHECKER_ARGUMENTS = [
    { value: '{input}', label: '输入' },
    { value: '{output}', label: '输出' },
    { value: '{answer}', label: '答案' }
] as const

export const DEFAULT_CHECKER_ARGUMENTS = '{input} {output} {answer}'

/** Return null for existing advanced templates so editing code never silently rewrites their arguments. */
export function checkerArgumentSlots(template = DEFAULT_CHECKER_ARGUMENTS): string[] | null {
    const parts = template.trim() ? template.trim().split(/\s+/) : []
    return parts.every((part) => CHECKER_ARGUMENTS.some((arg) => arg.value === part)) ? parts : null
}
