import {
  codexContextWindowThreadConfig,
  resolveCodexContextWindowSupport,
  type CodexContextWindowSetting,
  type CodexContextWindowThreadConfig,
} from '@canopy/desktop-shared/lib/codex-context-window';
import {
  isCodexSpeedRouteCatalogBacked,
  type CodexSpeedRouteFacts,
} from '@canopy/desktop-shared/lib/codex-speed-availability';
import { readCodexSpeedCatalog } from '../model-routing/codex-account-models';

export interface CodexContextWindowResolution {
  /** Undefined sends nothing, so Codex uses the model's own window. */
  config: CodexContextWindowThreadConfig | undefined;
  /**
   * False when the setting needed bounds that couldn't be read yet (the
   * catalog was unknown or still loading), so a later turn should retry.
   */
  resolved: boolean;
}

/**
 * The thread config for a chat's requested context window on the route its
 * thread actually runs. Nothing is sent for the model default, a route other
 * than native Codex or the account proxy, a model that can't change, or
 * bounds that couldn't be read.
 */
export async function resolveCodexContextWindowConfig(
  setting: CodexContextWindowSetting | undefined,
  route: CodexSpeedRouteFacts,
): Promise<CodexContextWindowResolution> {
  if (
    setting === undefined ||
    setting === 'model-default' ||
    !isCodexSpeedRouteCatalogBacked(route)
  ) {
    return { config: undefined, resolved: true };
  }
  const catalog = await readCodexSpeedCatalog(
    route.routeProfile === 'account-proxy' ? { route: 'account-proxy' } : {},
  );
  const support = resolveCodexContextWindowSupport(catalog, route);
  return {
    config: codexContextWindowThreadConfig(setting, support),
    resolved: support.kind !== 'unavailable' || support.reason !== 'catalog',
  };
}
