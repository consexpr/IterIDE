import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeContentHeight, playMotion } from './motion'

class FakeAnimation extends EventTarget {
    cancel = vi.fn(() => this.dispatchEvent(new Event('cancel')))
    finish = vi.fn(() => this.dispatchEvent(new Event('finish')))
}

let resized: () => void, disconnected: ReturnType<typeof vi.fn>, observed: ReturnType<typeof vi.fn>
let reduced = false
const preference = new EventTarget()
const mediaListeners = new Set<EventListenerOrEventListenerObject>()
const windowResize = new Set<() => void>()
beforeEach(() => {
    reduced = false
    mediaListeners.clear()
    windowResize.clear()
    observed = vi.fn()
    disconnected = vi.fn()
    vi.stubGlobal('getComputedStyle', () => ({ paddingTop: '8px', paddingBottom: '18px' }))
    vi.stubGlobal(
        'ResizeObserver',
        class {
            constructor(callback: () => void) {
                resized = callback
            }
            observe = observed
            disconnect = disconnected
        }
    )
    vi.stubGlobal('window', {
        matchMedia: () => ({
            get matches() {
                return reduced
            },
            addEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
                mediaListeners.add(listener)
                preference.addEventListener('change', listener)
            },
            removeEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => {
                mediaListeners.delete(listener)
                preference.removeEventListener('change', listener)
            }
        }),
        addEventListener: (_event: string, listener: () => void) => windowResize.add(listener),
        removeEventListener: (_event: string, listener: () => void) => windowResize.delete(listener)
    })
})
afterEach(() => {
    for (const listener of mediaListeners) preference.removeEventListener('change', listener)
    vi.unstubAllGlobals()
})

function fixture() {
    const animations: FakeAnimation[] = []
    const viewport = {
        style: { height: '' },
        offsetHeight: 100,
        animate: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
            const animation = new FakeAnimation()
            animations.push(animation)
            return animation
        })
    }
    const content = { offsetHeight: 200 }
    return { viewport, content, animations }
}

describe('persistent panel motion', () => {
    it('measures natural layout, includes padding, and observes only the inner content', () => {
        const f = fixture()
        const stop = observeContentHeight(f.viewport as any, f.content as any, () => 500)
        expect(observed).toHaveBeenCalledExactlyOnceWith(f.content)
        expect(f.viewport.style.height).toBe('226px')
        expect(f.viewport.animate).not.toHaveBeenCalled()
        f.viewport.offsetHeight = 226
        f.content.offsetHeight = 350
        resized()
        expect(f.viewport.style.height).toBe('376px')
        expect(f.viewport.animate.mock.calls[0][0]).toEqual([{ height: '226px' }, { height: '376px' }])
        stop()
        expect(disconnected).toHaveBeenCalledOnce()
        expect(windowResize.size).toBe(0)
        expect(mediaListeners.size).toBe(0)
        expect(f.viewport.style.height).toBe('')
    })

    it('retargets rapid changes from the visible height and cancels the superseded animation', () => {
        const f = fixture(),
            stop = observeContentHeight(f.viewport as any, f.content as any, () => 500)
        f.content.offsetHeight = 400
        resized()
        f.viewport.offsetHeight = 300
        f.content.offsetHeight = 100
        resized()
        expect(f.animations[0].cancel).toHaveBeenCalledOnce()
        expect(f.viewport.animate.mock.calls[1][0]).toEqual([{ height: '300px' }, { height: '126px' }])
        expect(mediaListeners.size).toBe(1)
        stop()
        expect(f.animations[1].cancel).toHaveBeenCalledOnce()
    })

    it('clamps long pages on window resize and reuses the natural target when room grows', () => {
        const f = fixture()
        let max = 150
        const stop = observeContentHeight(f.viewport as any, f.content as any, () => max)
        expect(f.viewport.style.height).toBe('150px')
        max = 500
        windowResize.forEach((callback) => callback())
        expect(f.viewport.style.height).toBe('226px')
        resized()
        expect(f.viewport.animate).toHaveBeenCalledOnce()
        stop()
    })

    it('honors reduced motion initially and finishes an active animation when the preference changes', () => {
        const f = fixture()
        reduced = true
        expect(playMotion(f.viewport as any, [{ opacity: 0 }, { opacity: 1 }])).toBeNull()
        expect(f.viewport.animate).not.toHaveBeenCalled()
        reduced = false
        const animation = playMotion(f.viewport as any, [{ opacity: 0 }, { opacity: 1 }])
        reduced = true
        preference.dispatchEvent(new Event('change'))
        expect(animation?.finish).toHaveBeenCalledOnce()
        expect(mediaListeners.size).toBe(0)
    })
})
