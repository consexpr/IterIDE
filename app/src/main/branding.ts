import { app } from 'electron'
import path from 'node:path'

/** The same icon is available to main and terminal windows in development and packaged builds. */
export const appIcon = (): string =>
    app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../../build/icon.png')
