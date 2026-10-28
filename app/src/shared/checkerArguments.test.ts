import { expect, it } from 'vitest'
import { checkerArgumentSlots } from './checkerArguments'

it('roundtrips selectable argument orders, subsets and empty argv without erasing advanced templates', () => {
    expect(checkerArgumentSlots()).toEqual(['{input}', '{output}', '{answer}'])
    expect(checkerArgumentSlots('{answer} {output}')).toEqual(['{answer}', '{output}'])
    expect(checkerArgumentSlots('')).toEqual([])
    expect(checkerArgumentSlots('{answer} {answer}')).toEqual(['{answer}', '{answer}'])
    expect(checkerArgumentSlots('--answer "{answer}" --score {score}')).toBeNull()
})
