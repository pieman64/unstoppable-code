import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeCapabilityName } from '@canopy/protocol/capability-name';
import { buildProviderConnectorRows } from '@canopy/ui-app/capability';
import { useCuratedMcpServers } from '@/hooks/useCuratedMcpServers';
import { useDetectedMcpServers } from '@/hooks/useDetectedMcpServers';
import { useProviderConnectors } from '@/hooks/useProviderConnectors';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import type { DetectedMcpServerInfo } from '@canopy/desktop-shared/types/mcp-servers';
import type { PluginsCache } from '@canopy/desktop-shared/types/plugins';
import type { ShareablePluginRef } from '@canopy/protocol';
import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';
import {
  curatedPluginKey,
  mergeCuratedPluginSelections,
  selectBlueprintOnboardingPlugins,
  selectBundledOnboardingPlugins,
  type CuratedOnboardingPlugin,
} from '@/lib/onboarding/curatedOnboardingPlugins';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import {
  MCP_PROMPT_INDEX,
  synthesizedPromptForServer,
} from '@/components/suggestions/mcpPromptIndex';
import type { OnboardingPluginSuggestionInput } from './queue';
import {
  orderedRolePluginNames,
  ROLE_PLUGIN_PROMPT_OVERRIDES,
} from './rolePluginRecommendations';

import { UNIVERSAL_PLUGIN_SUGGESTIONS } from '@canopy/ui-shared/lib/onboarding-recommendations';
export {
  UNIVERSAL_PLUGIN_SUGGESTIONS,
  type UniversalPluginSuggestionDef,
} from '@canopy/ui-shared/lib/onboarding-recommendations';

/**
 * Pure composition of the queue's plugin tail: universal entries first,
 * available matches for every selected role next, and then other plugins the
 * server marked `recommended`. A missing catalog entry is never advertised.
 * `enabledNames` is the lowercased plugin names in global selections.
 */
export function composePluginSuggestions(
  catalog: readonly CuratedOnboardingPlugin[],
  enabledNames: ReadonlySet<string>,
  selectedRoles: readonly ProfileRoleId[] | null = null,
): OnboardingPluginSuggestionInput[] {
  const universal = UNIVERSAL_PLUGIN_SUGGESTIONS.flatMap((def) => {
    const matches = catalog.filter((plugin) =>
      def.pluginNames.includes(plugin.name.toLowerCase()),
    );
    if (matches.length === 0) return [];
    const promptTexts = promptTextsFor(
      def.logoName,
      def.displayName,
      def.promptText,
    );
    return [
      {
        key: `universal:${def.id}`,
        name: def.logoName,
        displayName: def.displayName,
        description: def.description,
        promptText: promptTexts[0],
        promptTexts,
        enabled: (def.promptPluginNames ?? def.pluginNames).some((name) =>
          enabledNames.has(name),
        ),
        enableKeys: matches.map((plugin) => plugin.key),
        searchQuery: def.searchQuery,
      },
    ];
  });

  const coveredNames = new Set([
    'github',
    'linear',
    ...UNIVERSAL_PLUGIN_SUGGESTIONS.flatMap((def) => def.pluginNames),
  ]);
  const catalogByName = new Map<string, CuratedOnboardingPlugin>();
  for (const plugin of catalog) {
    const name = plugin.name.toLowerCase();
    if (!catalogByName.has(name)) catalogByName.set(name, plugin);
  }
  const shownNames = new Set(coveredNames);
  const picks: CuratedOnboardingPlugin[] = [];
  const roleNames = orderedRolePluginNames(selectedRoles, coveredNames);
  for (const name of roleNames) {
    const plugin = catalogByName.get(name);
    if (!plugin) continue;
    picks.push(plugin);
    shownNames.add(name);
  }
  // Preserve catalog-admin recommendations as an extensible second tier.
  for (const plugin of catalog) {
    const name = plugin.name.toLowerCase();
    if (
      (!plugin.recommended && !enabledNames.has(name)) ||
      shownNames.has(name)
    )
      continue;
    picks.push(plugin);
    shownNames.add(name);
  }
  const roleNameSet = new Set(roleNames);
  const catalogPicks = picks.map((plugin) => {
    const promptKey = plugin.name.toLowerCase();
    // Own-property lookup only: a plugin name colliding with an inherited
    // Object.prototype member must take the synthesized path.
    const indexed = Object.prototype.hasOwnProperty.call(
      MCP_PROMPT_INDEX,
      promptKey,
    )
      ? MCP_PROMPT_INDEX[promptKey]
      : undefined;
    const primaryPrompt =
      roleNameSet.has(promptKey) && ROLE_PLUGIN_PROMPT_OVERRIDES[promptKey]
        ? ROLE_PLUGIN_PROMPT_OVERRIDES[promptKey]
        : indexed && indexed.length > 0
          ? indexed[0].text
          : synthesizedPromptForServer(promptKey, plugin.displayName).text;
    const promptTexts = promptTextsFor(
      promptKey,
      plugin.displayName,
      primaryPrompt,
    );
    return {
      key: plugin.key,
      name: plugin.name,
      displayName: plugin.displayName,
      description: plugin.description,
      ...(roleNameSet.has(promptKey)
        ? { recommendationTier: 'role' as const }
        : {}),
      promptText: promptTexts[0],
      promptTexts,
      enabled: enabledNames.has(promptKey),
      enableKeys: [plugin.key],
      searchQuery: plugin.name,
    };
  });

  return [...universal, ...catalogPicks];
}

/**
 * The plugins a curated project template bundles, as checklist inputs
 * (CAN-3032). Unlike {@link composePluginSuggestions} this is not a
 * recommendation: every row the device could resolve is listed in template
 * order, and `enabled` reflects the same selection + connection reading the
 * general shortlist uses, so a project seeded with its template's plugins
 * starts with those reflected as done.
 */
export function composeBlueprintPluginSuggestions(
  rows: readonly CuratedOnboardingPlugin[],
  enabledNames: ReadonlySet<string>,
): OnboardingPluginSuggestionInput[] {
  return rows.map((plugin) => {
    const promptKey = plugin.name.toLowerCase();
    const indexed = Object.prototype.hasOwnProperty.call(
      MCP_PROMPT_INDEX,
      promptKey,
    )
      ? MCP_PROMPT_INDEX[promptKey]
      : undefined;
    const primaryPrompt =
      indexed && indexed.length > 0
        ? indexed[0].text
        : synthesizedPromptForServer(promptKey, plugin.displayName).text;
    const promptTexts = promptTextsFor(
      promptKey,
      plugin.displayName,
      primaryPrompt,
    );
    return {
      key: plugin.key,
      name: plugin.name,
      displayName: plugin.displayName,
      description: plugin.description,
      promptText: promptTexts[0],
      promptTexts,
      enabled: enabledNames.has(promptKey),
      enableKeys: [plugin.key],
      searchQuery: plugin.name,
    };
  });
}

function promptTextsFor(
  pluginName: string,
  displayName: string,
  primary: string,
): readonly string[] {
  const indexed = MCP_PROMPT_INDEX[pluginName.toLowerCase()]?.map(
    (prompt) => prompt.text,
  );
  const candidates = [
    primary,
    ...(indexed ?? []),
    ...(pluginName === 'gmail-gmailmcp'
      ? ['Draft an email announcement using the context in my Gmail threads']
      : []),
    ...(pluginName === 'google-drive-drivemcp'
      ? [
          'Turn rough notes from my Google Drive into a polished document',
          'Compare two proposals in my Google Drive and explain their tradeoffs',
        ]
      : []),
    ...(pluginName === 'notion'
      ? [
          'Turn a project brief from Notion into milestones and next steps',
          'Research a topic in my Notion workspace and write up what matters',
        ]
      : []),
    `Summarize the most important recent activity in ${displayName}`,
    `Find something actionable in ${displayName} and recommend next steps`,
  ];
  return Array.from(new Set(candidates));
}

/** Context for a chat project seeded from a curated project template (CAN-3032). */
export interface PluginSuggestionsOptions {
  /** Plugin refs the active project's template bundles (skills excluded). */
  blueprintPluginRefs?: readonly ShareablePluginRef[];
  /**
   * The project's own default selections. A template's resolved refs land
   * here at seed time, so its checklist reads them as enabled unless a
   * known connector reports them disconnected — the same reading the global
   * selections get. They never reach the general checklist's state.
   */
  projectSelections?: ChatTabPluginSelections | null;
}

const NO_PLUGIN_REFS: readonly ShareablePluginRef[] = [];

/**
 * Selection state is only half the answer for a plugin the device can
 * connect: a known connector or detected server that is disconnected takes
 * the plugin back out, and a connected one puts it in even without a
 * selection. Applied to the general and the template sets alike.
 */
function reconcileWithConnections(
  names: ReadonlySet<string>,
  plugins: readonly CuratedOnboardingPlugin[],
  connectorRows: ReturnType<typeof buildProviderConnectorRows>,
  detectedServers: readonly DetectedMcpServerInfo[],
): ReadonlySet<string> {
  const enabledNames = new Set(names);
  for (const plugin of plugins) {
    const name = plugin.name.toLowerCase();
    const normalized = normalizeCapabilityName(plugin.displayName);
    const connector = connectorRows.find(
      (row) => normalizeCapabilityName(row.displayName) === normalized,
    );
    const servers = detectedServers.filter(
      (server) =>
        server.pluginName?.toLowerCase() === name ||
        server.curatedKey === name ||
        normalizeCapabilityName(server.displayName) === normalized,
    );
    const connectorConnected = connector?.providers.some(
      (provider) => provider.connected || provider.alternateRoute,
    );
    const serverConnected = servers.some(
      (server) =>
        server.enabled &&
        ['connected', 'not_configured', 'unsupported'].includes(
          server.authStatus,
        ),
    );
    if (connectorConnected || serverConnected) enabledNames.add(name);
    else if (connector || servers.length > 0) enabledNames.delete(name);
  }
  return enabledNames;
}

export interface PluginSuggestionsResult {
  /** Universal + role-recommended plugins as queue-entry inputs. */
  suggestions: OnboardingPluginSuggestionInput[];
  /**
   * The active project template's bundled plugins, in template order, with
   * live enablement. Empty without a template context or a catalog match.
   */
  blueprintSuggestions: OnboardingPluginSuggestionInput[];
  /**
   * True once the catalog and global-selection reads have settled — the
   * component must not retire the module on an "empty" queue before this.
   */
  ready: boolean;
  /**
   * Enables the given curated plugins in the global selections. Returns
   * false when nothing could be enabled — no catalog match yet, or the
   * selections base could not be read safely (degraded preferences read;
   * writing a merge onto an unknown base would clobber real state) — so the
   * caller falls back to the Plugins page instead.
   */
  enablePlugins: (keys: readonly string[]) => Promise<boolean>;
}

/**
 * Suggestion source for the dynamic queue's plugin tail (see
 * {@link composePluginSuggestions}): the curated plugins cache joined with
 * the global plugin selections so already-enabled plugins land on their
 * "try" step. Role shortlists are applied locally to the available catalog;
 * the server's `recommended` flags provide additional picks after them.
 */
export function usePluginSuggestions(
  selectedRoles: readonly ProfileRoleId[] | null,
  options?: PluginSuggestionsOptions,
): PluginSuggestionsResult {
  // Role changes also force a server-targeted sync. Re-read now and again
  // after its async result has had time to land in the local catalog cache.
  const refreshKey = selectedRoles?.join(',') ?? null;
  // `undefined` = still loading; `null` = unreadable (treated as empty).
  const [cache, setCache] = useState<PluginsCache | null | undefined>(
    undefined,
  );
  const catalog = useMemo(
    (): CuratedOnboardingPlugin[] | null =>
      cache === undefined ? null : selectBundledOnboardingPlugins(cache),
    [cache],
  );
  // Callers rebuild the options object every render, but the refs and
  // selections inside it come from the surfaces store and keep their
  // identity until the chat host republishes them.
  const blueprintPluginRefs = options?.blueprintPluginRefs ?? NO_PLUGIN_REFS;
  const blueprintRows = useMemo(
    (): CuratedOnboardingPlugin[] =>
      cache === undefined || blueprintPluginRefs.length === 0
        ? []
        : selectBlueprintOnboardingPlugins(cache, blueprintPluginRefs),
    [cache, blueprintPluginRefs],
  );
  const projectSelections = options?.projectSelections ?? null;
  // `undefined` = still loading; `null` = degraded read (never write).
  const [selections, setSelections] = useState<
    ChatTabPluginSelections | null | undefined
  >(undefined);
  const [locallyEnabled, setLocallyEnabled] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // The same in-session enables by selection key, for the template rows,
  // which never match a same-named plugin from another marketplace.
  const [locallyEnabledKeys, setLocallyEnabledKeys] = useState<
    ReadonlySet<string>
  >(new Set());
  const enableChain = useRef<Promise<void>>(Promise.resolve());
  const { entries: curatedServers } = useCuratedMcpServers();
  const {
    servers: detectedServers,
    initializing: detectingServers,
    refresh: refreshServers,
  } = useDetectedMcpServers(selections ?? null);
  const { results: connectorResults, refresh: refreshConnectors } =
    useProviderConnectors({
      // Template rows can exist without any bundled catalog entry; their
      // connections are probed all the same.
      enabled:
        catalog !== null && (catalog.length > 0 || blueprintRows.length > 0),
    });

  useEffect(() => {
    let cancelled = false;
    const readCatalog = (): void => {
      void window.plugins
        .loadMarketplacesCacheOnly()
        .then((result) => {
          if (cancelled) return;
          setCache(result.success ? (result.data ?? null) : null);
        })
        .catch(() => {
          if (!cancelled) setCache(null);
        });
    };
    readCatalog();
    const unsubscribePreferences = window.api.onPreferencesSynced?.((prefs) => {
      if (cancelled) return;
      setSelections(
        normalizePluginSelections(prefs.globalPluginSelections ?? null),
      );
      setLocallyEnabled(new Set());
      setLocallyEnabledKeys(new Set());
      readCatalog();
    });
    window.addEventListener('focus', readCatalog);
    // The forced role-targeted re-sync a role save triggers lands
    // asynchronously with no renderer notification; a delayed second read
    // picks up the refreshed recommendations within the session.
    const delayedRead =
      refreshKey != null ? window.setTimeout(readCatalog, 5000) : null;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (cancelled) return;
        // A degraded read must never become a merge base (see the wizard's
        // curated step): mark unusable rather than defaulting to empty.
        setSelections(
          prefs.__error
            ? null
            : normalizePluginSelections(prefs.globalPluginSelections ?? null),
        );
      })
      .catch(() => {
        if (!cancelled) setSelections(null);
      });
    return (): void => {
      cancelled = true;
      unsubscribePreferences?.();
      window.removeEventListener('focus', readCatalog);
      if (delayedRead !== null) window.clearTimeout(delayedRead);
    };
  }, [refreshKey]);

  const enablePlugins = useCallback(
    (keys: readonly string[]): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        if (catalog === null) {
          return false;
        }
        const preferences = await window.api.loadPreferences();
        if (preferences.__error) return false;
        const base = normalizePluginSelections(
          preferences.globalPluginSelections ?? null,
        );
        const rows = [...catalog, ...blueprintRows].filter((plugin) =>
          keys.includes(plugin.key),
        );
        if (rows.length === 0) return false;
        const merged = mergeCuratedPluginSelections(
          base,
          rows,
          rows.map((row) => row.key),
        );
        await window.api.savePreferences({ globalPluginSelections: merged });
        setSelections(merged);
        setLocallyEnabled((previous) => {
          const next = new Set(previous);
          for (const row of rows) next.add(row.name.toLowerCase());
          return next;
        });
        setLocallyEnabledKeys((previous) => {
          const next = new Set(previous);
          for (const row of rows) next.add(row.key);
          return next;
        });
        // Configuration can finish inside a modal without a window-focus
        // event. Re-read both routes so a newly linked tool turns blue now.
        refreshConnectors();
        void refreshServers();
        return true;
      };
      const result = enableChain.current.then(run, run);
      enableChain.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [blueprintRows, catalog, refreshConnectors, refreshServers],
  );

  // Global selection state: local adds plus the global selections.
  const selectedNames = useMemo((): ReadonlySet<string> | null => {
    if (catalog === null) return null;
    const names = new Set(locallyEnabled);
    if (selections !== null && selections !== undefined) {
      const enabledKeys = new Set(
        normalizePluginSelections(selections).pluginRefs.map((ref) =>
          curatedPluginKey(ref.marketplaceId, ref.pluginName),
        ),
      );
      for (const plugin of catalog) {
        if (enabledKeys.has(plugin.key)) {
          names.add(plugin.name.toLowerCase());
        }
      }
      // Selections can reference plugins absent from a stale catalog read;
      // the ref's own plugin name still marks the suggestion satisfied.
      for (const ref of normalizePluginSelections(selections).pluginRefs) {
        names.add(ref.pluginName.toLowerCase());
      }
    }
    return names;
  }, [catalog, selections, locallyEnabled]);
  const connectorRows = useMemo(
    () => buildProviderConnectorRows(connectorResults ?? [], curatedServers),
    [connectorResults, curatedServers],
  );
  const enabledNames = useMemo(
    (): ReadonlySet<string> | null =>
      selectedNames === null || catalog === null
        ? null
        : reconcileWithConnections(
            selectedNames,
            catalog,
            connectorRows,
            detectedServers,
          ),
    [catalog, connectorRows, detectedServers, selectedNames],
  );
  // The template rows read a selection as enabling them only through the
  // marketplace-qualified key of a selection ref — the global selections or
  // the project's own, where the template's refs land at seed time — so a
  // same-named plugin from another marketplace never counts. Reconciled
  // against the same live connections as the general set, and never fed
  // to it: project-scoped state cannot retire a global lesson.
  const blueprintEnabledNames = useMemo((): ReadonlySet<string> | null => {
    if (catalog === null) return null;
    const selectedKeys = new Set<string>();
    for (const selected of [selections ?? null, projectSelections]) {
      if (selected === null) continue;
      for (const ref of normalizePluginSelections(selected).pluginRefs) {
        selectedKeys.add(curatedPluginKey(ref.marketplaceId, ref.pluginName));
      }
    }
    const names = new Set<string>();
    for (const row of blueprintRows) {
      if (selectedKeys.has(row.key) || locallyEnabledKeys.has(row.key)) {
        names.add(row.name.toLowerCase());
      }
    }
    return reconcileWithConnections(
      names,
      blueprintRows,
      connectorRows,
      detectedServers,
    );
  }, [
    blueprintRows,
    catalog,
    connectorRows,
    detectedServers,
    locallyEnabledKeys,
    projectSelections,
    selections,
  ]);

  const suggestions = useMemo(
    (): OnboardingPluginSuggestionInput[] =>
      catalog === null || enabledNames === null
        ? []
        : composePluginSuggestions(catalog, enabledNames, selectedRoles),
    [catalog, enabledNames, selectedRoles],
  );
  const blueprintSuggestions = useMemo(
    (): OnboardingPluginSuggestionInput[] =>
      blueprintEnabledNames === null
        ? []
        : composeBlueprintPluginSuggestions(
            blueprintRows,
            blueprintEnabledNames,
          ),
    [blueprintRows, blueprintEnabledNames],
  );

  return {
    suggestions,
    blueprintSuggestions,
    ready:
      catalog !== null &&
      selections !== undefined &&
      !detectingServers &&
      ((catalog.length === 0 && blueprintRows.length === 0) ||
        connectorResults !== undefined),
    enablePlugins,
  };
}
