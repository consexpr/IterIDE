import { expect, it } from 'vitest'
import { visibleRows } from './testListModel'

it('bounds mounted rows for 1000 tests and includes an expanded row intersecting the viewport', () => {
    const offsets = Array.from({ length: 1001 }, (_, i) => i * 44)
    const [start, end] = visibleRows(offsets, 500 * 44, 600)
    expect(start).toBeLessThanOrEqual(500)
    expect(end).toBeGreaterThan(500)
    expect(end - start).toBeLessThan(30)
    expect(visibleRows([0, 44, 1044, 1088], 600, 200, 0)).toEqual([1, 2])
    expect(visibleRows([0], 0, 600)).toEqual([0, 0])
})
