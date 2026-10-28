/** Prefix offsets include the row gap; binary search makes viewport lookup independent of list length. */
export function visibleRows(offsets: number[], top: number, height: number, overscan = 220): [number, number] {
    const count = offsets.length - 1
    if (!count) return [0, 0]
    const lower = (value: number): number => {
        let lo = 0,
            hi = count
        while (lo < hi) {
            const mid = (lo + hi) >>> 1
            if (offsets[mid] < value) lo = mid + 1
            else hi = mid
        }
        return lo
    }
    return [Math.max(0, lower(Math.max(0, top - overscan)) - 1), Math.min(count, lower(top + height + overscan))]
}
