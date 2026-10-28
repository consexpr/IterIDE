import { contextBridge, ipcRenderer } from 'electron'

export interface TerminalBridge {
    ready(size: { cols: number; rows: number }): void
    input(data: string): void
    resize(size: { cols: number; rows: number }): void
    close(): void
    acknowledge(sequence: number): void
    onData(listener: (data: Uint8Array, sequence: number) => void): void
    onExit(listener: (code: number) => void): void
}

const bridge: TerminalBridge = {
    ready: (size) => ipcRenderer.send('terminal:ready', size),
    input: (data) => ipcRenderer.send('terminal:input', data),
    resize: (size) => ipcRenderer.send('terminal:resize', size),
    close: () => ipcRenderer.send('terminal:close'),
    acknowledge: (sequence) => ipcRenderer.send('terminal:ack', sequence),
    onData: (listener) =>
        void ipcRenderer.on('terminal:data', (_e, data: Uint8Array, sequence: number) => listener(data, sequence)),
    onExit: (listener) => void ipcRenderer.on('terminal:exit', (_e, code: number) => listener(code))
}

contextBridge.exposeInMainWorld('terminalHost', bridge)
