import type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import {
  discoverInheritedCursorCapabilities,
  emptyInheritedCursorCapabilities,
  type InheritedCursorCapabilities,
} from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
import { resolveInheritedCursorRoots } from '../cursor/inherited-roots';
import {
  inheritedClaudePluginRefs,
  type InheritedPluginRef,
} from './inherited-cursor-plugins';
import { readClaudeEnabledPlugins } from './claude-enabled-plugins';
import { loadMarketplacesCacheOnly } from './plugin-service';
import { readInstalledItemPolicy } from '../installed-items/installed-item-policy';

export interface HomeCapabilities {
  inherited: InheritedCursorCapabilities;
  inheritedPluginRefs: InheritedPluginRef[];
}

/**
 * The user's home-folder skills and commands, and the Claude Code plugins
 * enabled for `cwd`, that a Copilot or OpenCode chat inherits the way a
 * Cursor chat does. Discovered from trusted host roots; the native runtime
 * never reads ambient config.
 */
export async function discoverHomeCapabilities(input: {
  cwd: string;
  selections: ChatTabPluginSelections;
  tombstones?: PluginSelectionTombstones;
  signal?: AbortSignal;
}): Promise<HomeCapabilities> {
  input.signal?.throwIfAborted();
  const roots = resolveInheritedCursorRoots();
  let inherited = emptyInheritedCursorCapabilities();
  try {
    inherited = await discoverInheritedCursorCapabilities(roots);
  } catch (error) {
    input.signal?.throwIfAborted();
    // eslint-disable-next-line no-console
    console.error('[inherited-capabilities] discovery failed:', error);
  }
  input.signal?.throwIfAborted();
  const marketplaces = await loadMarketplacesCacheOnly()
    .then((result) =>
      result.success && result.data ? result.data.marketplaces : [],
    )
    .catch(() => []);
  input.signal?.throwIfAborted();
  const inheritedPluginRefs = inheritedClaudePluginRefs(
    marketplaces,
    input.selections,
    input.tombstones,
    readClaudeEnabledPlugins(roots.claudeConfigDir, input.cwd),
    (await readInstalledItemPolicy()).disabledPluginRefs,
  );
  return { inherited, inheritedPluginRefs };
}
