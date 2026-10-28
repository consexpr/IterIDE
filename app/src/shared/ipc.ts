import type { IterApi } from './api'

type MethodContract<Method> = Method extends (...args: infer Args) => Promise<infer Result>
    ? { args: Args; result: Result }
    : never

type GroupChannels<Group extends string, Api> = {
    [Method in keyof Api & string as MethodContract<Api[Method]> extends never
        ? never
        : `${Group}:${Method}`]: MethodContract<Api[Method]>
}

type Groups = {
    [Group in keyof IterApi & string]-?: GroupChannels<Group, NonNullable<IterApi[Group]>>
}[keyof IterApi & string]

type Intersection<Union> = (Union extends unknown ? (value: Union) => void : never) extends (
    value: infer Result
) => void
    ? Result
    : never

/** Derived from the renderer API so main and preload cannot silently drift apart. */
export type IpcContract = Intersection<Groups>
export type IpcChannel = keyof IpcContract
export type IpcArgs<Channel extends IpcChannel> = IpcContract[Channel] extends { args: infer Args extends unknown[] }
    ? Args
    : never
export type IpcResult<Channel extends IpcChannel> = IpcContract[Channel] extends { result: infer Result }
    ? Result
    : never
export type IpcHandler<Channel extends IpcChannel> = (
    ...args: IpcArgs<Channel>
) => IpcResult<Channel> | Promise<IpcResult<Channel>>
