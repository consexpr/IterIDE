import type { PluginHost } from '../../shared/plugin'

/** Runtime additions kept here while the shared-contract owner adds dataDir to PluginHost. */
export interface RuntimePluginHost extends PluginHost {
    readonly dataDir: string
}
