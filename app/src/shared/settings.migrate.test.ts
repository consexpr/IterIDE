import { expect, it } from 'vitest'
import { migrateSettings } from './settings'

it('moves the old completion `cnn` flag to `model` without overriding a newer value', () => {
    expect(migrateSettings({ editor: { completion: { cnn: true } } })).toEqual({
        editor: { completion: { model: true } }
    })
    expect(migrateSettings({ editor: { completion: { cnn: true, model: false } } })).toEqual({
        editor: { completion: { model: false } }
    })
    expect(migrateSettings({ editor: {} })).toEqual({ editor: {} })
    expect(migrateSettings({})).toEqual({})
})
