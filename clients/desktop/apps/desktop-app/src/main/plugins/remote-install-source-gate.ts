import type { IPCResult } from '@canopy/execution-engine/types/pipeline';
import type { PluginInfo } from '@canopy/execution-engine/types/plugins';
import {
  assertSafeExternalPluginCloneUrl,
  UnsafeExternalPluginUrlError,
} from './external-plugin-url';

export const REMOTE_PLUGIN_SOURCE_REFUSAL =
  'Remote control can only install plugins from public https sources. Install it on this computer to use a private or local source.';

/** The install `plugins:install-plugin` runs, as `plugin-service` exposes it. */
export type PluginSourceInstall = (
  marketplaceId: string,
  pluginName: string,
  sourceUrl: string,
  options?: { disableRedirects?: boolean },
) => Promise<IPCResult<PluginInfo>>;

/**
 * Runs a renderer plugin install by who asked for it (CAN-5764). A remote
 * principal (a Remote Control bridge sender) gets the Portal's rule: the source
 * must pass {@link assertSafeExternalPluginCloneUrl} and the clone refuses
 * redirects. The local user keeps any source their own git can reach, such as
 * a private-network forge or an ssh remote.
 */
export async function installPluginForPrincipal(
  request: {
    remote: boolean;
    marketplaceId: string;
    pluginName: string;
    sourceUrl: string;
  },
  install: PluginSourceInstall,
): Promise<IPCResult<PluginInfo>> {
  const { marketplaceId, pluginName, sourceUrl } = request;
  if (!request.remote) return install(marketplaceId, pluginName, sourceUrl);
  try {
    await assertSafeExternalPluginCloneUrl(sourceUrl);
  } catch (error) {
    if (error instanceof UnsafeExternalPluginUrlError)
      return {
        success: false,
        error: `${REMOTE_PLUGIN_SOURCE_REFUSAL} ${error.message}`,
      };
    throw error;
  }
  return install(marketplaceId, pluginName, sourceUrl, {
    disableRedirects: true,
  });
}
