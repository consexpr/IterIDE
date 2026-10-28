/* ITER panel bridge. Load with <script src="iter://sdk/panel.js"></script>. */
;(function () {
    'use strict'
    const pending = new Map()
    const subscribers = new Set()
    const themeKeys = new Set()
    // Numeric ids match the renderer contract; a random base avoids reuse after iframe reloads.
    let sequence = Math.floor(Math.random() * 1e12)
    let state

    function request(method, args) {
        return new Promise((resolve, reject) => {
            const id = ++sequence
            const timer = setTimeout(() => {
                pending.delete(id)
                reject(new Error('ITER 面板请求超时: ' + method))
            }, 35000)
            pending.set(id, { resolve, reject, timer })
            try {
                window.parent.postMessage({ type: 'iter:request', id, method, args }, '*')
            } catch (error) {
                clearTimeout(timer)
                pending.delete(id)
                reject(error)
            }
        })
    }

    function deliver(callback) {
        try {
            callback(state)
        } catch (error) {
            console.error('[iter:panel] onState callback failed', error)
        }
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window.parent) return
        const message = event.data
        if (!message || typeof message !== 'object') return
        if (message.type === 'iter:state' && message.state && typeof message.state === 'object') {
            state = message.state
            const root = document.documentElement
            for (const key of themeKeys) root.style.removeProperty(key)
            themeKeys.clear()
            const theme = state.theme
            if (theme && typeof theme === 'object') {
                for (const [key, value] of Object.entries(theme.vars || {})) {
                    if (/^--[a-zA-Z0-9_-]+$/.test(key) && typeof value === 'string') {
                        root.style.setProperty(key, value)
                        themeKeys.add(key)
                    }
                }
                root.dataset.theme = String(theme.id || '')
                root.dataset.themeKind = theme.kind === 'light' ? 'light' : 'dark'
                root.style.colorScheme = root.dataset.themeKind
            }
            for (const callback of subscribers) deliver(callback)
        } else if (message.type === 'iter:reply' && typeof message.id === 'number' && typeof message.ok === 'boolean') {
            const task = pending.get(message.id)
            if (!task) return
            clearTimeout(task.timer)
            pending.delete(message.id)
            if (message.ok) task.resolve(message.value)
            else
                task.reject(
                    new Error(
                        typeof message.error?.message === 'string'
                            ? message.error.message
                            : String(message.error || 'ITER 请求失败')
                    )
                )
        }
    })

    window.iter = Object.freeze({
        onState(callback) {
            if (typeof callback !== 'function') throw new TypeError('onState 需要函数')
            subscribers.add(callback)
            if (state) deliver(callback)
            return () => subscribers.delete(callback)
        },
        invoke: (channel, ...args) => request('invoke', [channel, ...args]),
        getSource: () => request('getSource', []),
        insertText: (text) => request('insertText', [text]),
        openFile: (path) => request('openFile', [path]),
        runTests: (ids) => request('runTests', ids === undefined ? [] : [ids]),
        toast: (text, kind) => request('toast', kind === undefined ? [text] : [text, kind]),
        setBadge: (text) => request('setBadge', [text])
    })
    // Existing plugin scripts can use the current bridge without editing their own code.
    window.naven = window.iter
})()
