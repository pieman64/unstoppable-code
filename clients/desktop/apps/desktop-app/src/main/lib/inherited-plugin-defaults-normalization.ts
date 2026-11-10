import type {
  ChatTabPluginSelections,
  ChatTabsFile,
  PersistedChatTab,
  PluginSelectionTombstones,
} from '@canopy/desktop-shared/types';
import { hasAnySelections } from '@canopy/desktop-shared/types';
import {
  effectiveChatPluginSelections,
  INHERITED_PLUGIN_DEFAULTS_VERSION,
  normalizePluginSelectionTombstones,
  pluginSelectionsEqual,
  subtractPluginSelections,
  unionPluginSelections,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import {
  chatStorageScopeIds,
  readChatStorageDiscoveryIndex,
} from './chat-storage-discovery';
import { logMainProcessWarn } from './main-process-logging';
import { getWorkspaceDir } from './paths';
import {
  hasPersistedPreferencesFile,
  readPreferencesFileDetailed,
} from './preferences-store';
import { inMcpRefRewritePhase } from '../mcp/server-ref-rewrite-outcome';

function needsNormalization(tab: {
  kind?: unknown;
  inheritedPluginDefaultsVersion?: unknown;
}): boolean {
  return (
    tab.kind !== 'file' &&
    !(
      typeof tab.inheritedPluginDefaultsVersion === 'number' &&
      tab.inheritedPluginDefaultsVersion >= INHERITED_PLUGIN_DEFAULTS_VERSION
    )
  );
}

/** The layers a legacy chat was already inheriting before normalization. */
interface LegacyInheritedLayers {
  global?: ChatTabPluginSelections;
  projectTombstones?: PluginSelectionTombstones;
}

function asTombstones(
  selections: ChatTabPluginSelections,
): PluginSelectionTombstones {
  return {
    collectionIds: selections.collectionIds,
    skillRefs: selections.skillRefs,
    pluginRefs: selections.pluginRefs,
    mcpServerRefs: selections.mcpServerRefs ?? [],
  };
}

/**
 * One-time move of a legacy chat to live project defaults, against the
 * defaults it has been running under (`projectDefaults`, the ones about to be
 * replaced). The chat keeps exactly the selection it had: copies of those
 * defaults leave its own selection, since the project layer supplies them
 * now, and each of those defaults it didn't have becomes a tombstone, so only
 * defaults added later reach it. What it "had" includes the global layer it
 * already inherited (`inherited`); without it, every default missing from its
 * own selection is turned off. The chat is stamped so this never runs for it
 * again. Returns `null` when the chat is already current.
 */
export function normalizeTabForInheritedPluginDefaults(
  tab: PersistedChatTab,
  projectDefaults: ChatTabPluginSelections | undefined,
  inherited: LegacyInheritedLayers = {},
): PersistedChatTab | null {
  if (!needsNormalization(tab)) return null;
  const next: PersistedChatTab = {
    ...tab,
    inheritedPluginDefaultsVersion: INHERITED_PLUGIN_DEFAULTS_VERSION,
  };
  const defaults = normalizePluginSelections(projectDefaults);
  if (!hasAnySelections(defaults)) return next;
  const own = normalizePluginSelections(tab.pluginSelections);
  const tombstones = normalizePluginSelectionTombstones(
    tab.disabledGlobalPluginSelections,
  );
  const had = effectiveChatPluginSelections({
    local: own,
    global: inherited.global,
    projectTombstones: inherited.projectTombstones,
    chatTombstones: tombstones,
  });
  const stripped = subtractPluginSelections(own, defaults);
  if (tab.pluginSelections && !pluginSelectionsEqual(own, stripped)) {
    next.pluginSelections = stripped;
  }
  // A default the chat chose itself stays on once the project layer
  // supplies it, even where the chat had turned off its global copy.
  const chosenDefaults = subtractPluginSelections(own, stripped);
  const nextTombstones = normalizePluginSelectionTombstones(
    asTombstones(
      unionPluginSelections(
        subtractPluginSelections(
          {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [],
            ...tombstones,
          },
          chosenDefaults,
        ),
        subtractPluginSelections(defaults, had),
      ),
    ),
  );
  if (nextTombstones) next.disabledGlobalPluginSelections = nextTombstones;
  else delete next.disabledGlobalPluginSelections;
  return next;
}

/**
 * The global layer legacy chats inherited, from the preferences file itself.
 * Only a data directory without any preferences has no global layer: a file
 * that can't be read, or one missing while its last good copy remains, would
 * make every global default a chat inherited look like one it lacked.
 */
async function readInheritedGlobalLayer(): Promise<
  ChatTabPluginSelections | undefined
> {
  const { preferences, authority } = await readPreferencesFileDetailed();
  if (
    authority === 'unreadable' ||
    (authority === 'absent' && (await hasPersistedPreferencesFile()))
  )
    return inMcpRefRewritePhase(
      'normalization',
      () =>
        Promise.reject(new Error('Could not read the global plugin defaults')),
      'rewriteFailed',
    );
  return preferences.globalPluginSelections
    ? normalizePluginSelections(preferences.globalPluginSelections)
    : undefined;
}

function normalizeTabsFile(
  tabsFile: ChatTabsFile,
  projectDefaults: ChatTabPluginSelections | undefined,
  inherited: LegacyInheritedLayers,
): ChatTabsFile {
  let changed = false;
  const tabs = tabsFile.tabs.map((tab) => {
    const next = normalizeTabForInheritedPluginDefaults(
      tab,
      projectDefaults,
      inherited,
    );
    if (!next) return tab;
    changed = true;
    return next;
  });
  return changed ? { ...tabsFile, tabs } : tabsFile;
}

/**
 * Normalizes every legacy chat of a workspace against the project defaults
 * (and project tombstones) that are about to be replaced. Runs before
 * `workspace.json` changes its `defaultPluginSelections`, so each legacy chat
 * keeps exactly the selection it had and only the new defaults reach it,
 * while chats that are already current keep their own selections untouched. Writes go through the chat
 * state service, the single writer of canonical chat storage; the read-only
 * discovery index keeps scopes without legacy chats from being loaded, and a
 * scope whose index can't be read is loaded in full instead of skipped.
 * Rejects without touching any chat when the global layer can't be read, and
 * after trying every scope when any could not be normalized: once the
 * defaults change, a legacy chat's seeded copies can no longer be told apart
 * from its own picks, so the caller must keep the old defaults.
 */
export async function normalizeWorkspaceChatsForInheritedPluginDefaults(
  workspaceId: string,
  previousDefaults: ChatTabPluginSelections | undefined,
  previousProjectTombstones?: PluginSelectionTombstones,
): Promise<void> {
  const root = getWorkspaceDir(workspaceId);
  const global = await readInheritedGlobalLayer();
  const inherited: LegacyInheritedLayers = {
    ...(global ? { global } : {}),
    ...(previousProjectTombstones
      ? { projectTombstones: previousProjectTombstones }
      : {}),
  };
  // Lazy import breaks the workspace-persistence/chat-state projection cycle
  // (same pattern as chat-tabs-reader.ts).
  const { getChatStateService } =
    await import('../services/chat-state-service');
  let failedScopes = 0;
  for (const scopeId of await chatStorageScopeIds(root)) {
    try {
      const index = await readChatStorageDiscoveryIndex(root, scopeId).catch(
        (): null => null,
      );
      if (index && !index.tabs.some(needsNormalization)) continue;
      await inMcpRefRewritePhase('normalization', () =>
        getChatStateService().updateCompatibilityTabs(
          { projectId: workspaceId, worktreeId: scopeId },
          (tabsFile) =>
            normalizeTabsFile(tabsFile, previousDefaults, inherited),
        ),
      );
    } catch (error) {
      failedScopes += 1;
      logMainProcessWarn(
        '[inherited-plugin-defaults] chat normalization failed',
        { workspaceId, scopeId, error },
      );
    }
  }
  if (failedScopes > 0)
    throw new Error(
      `Could not normalize ${failedScopes} chat scope${failedScopes === 1 ? '' : 's'} of workspace ${workspaceId}`,
    );
}
