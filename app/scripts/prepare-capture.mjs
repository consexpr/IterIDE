// Test-only bootstrap for a restricted Windows worker: redirect appData before
// main starts, without editing the application's source or packaged JavaScript.
import path from 'node:path'

const port = Number(process.argv[2])
const profile = path.resolve(process.argv[3])
const timeout = setTimeout(() => {
    console.error('Capture inspector timed out')
    process.exit(1)
}, 15000)
let socket
try {
    let target
    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const targets = await fetch(`http://127.0.0.1:${port}/json/list`, {
                signal: AbortSignal.timeout(1000)
            }).then((r) => r.json())
            target = targets.find((entry) => entry.webSocketDebuggerUrl)
            if (target) break
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!target) throw new Error('Capture inspector did not start')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
        socket.onopen = resolve
        socket.onerror = reject
    })
    let id = 0
    const pending = new Map()
    let onPaused
    const paused = new Promise((resolve) => {
        onPaused = resolve
    })
    socket.onmessage = ({ data }) => {
        const message = JSON.parse(data)
        if (message.method === 'Debugger.paused') onPaused(message.params)
        if (message.id) {
            const handler = pending.get(message.id)
            pending.delete(message.id)
            if (message.error) handler.reject(new Error(JSON.stringify(message.error)))
            else handler.resolve(message.result)
        }
    }
    function send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const key = ++id
            pending.set(key, { resolve, reject })
            socket.send(JSON.stringify({ id: key, method, params }))
        })
    }
    await send('Runtime.enable')
    await send('Debugger.enable')
    await send('Runtime.runIfWaitingForDebugger')
    const stopped = await paused
    const result = await send('Debugger.evaluateOnCallFrame', {
        callFrameId: stopped.callFrames[0].callFrameId,
        expression: `process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.setPath('appData', ${JSON.stringify(profile)})`
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    console.log('Capture-only appData override:', profile)
    await send('Debugger.resume')
} finally {
    socket?.close()
    clearTimeout(timeout)
}
