export const showWhitespace = (text: string): string =>
    text.replace(/ /g, '·').replace(/\t/g, '⇥').replace(/\r/g, '␍').replace(/\n/g, '↵\n')
