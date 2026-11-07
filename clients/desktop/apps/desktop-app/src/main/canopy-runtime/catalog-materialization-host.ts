import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CatalogSelectionUnavailableError,
  type CatalogMaterializationResolution,
  type CatalogMaterializationResolver,
  type WorkerCatalogHost,
  type WorkerCatalogPluginInstall,
  type WorkerCatalogSkillInstall,
} from '@canopy/core-runtime/node/catalog';
import {
  collectionEntryId,
  mcpServerEntryId,
  pluginEntryId,
  selectionEntryIds,
  skillEntryId,
  type CatalogMaterializationItemDescriptor,
} from '@canopy/protocol/canopy-core';
import { createMarketplaceShareResolver } from '@canopy/desktop-shared/lib/marketplace-share-resolution';
import {
  STANDALONE_CHAT_PROJECT_ID,
  type ChatTabPluginSelections,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import type {
  MarketplaceInfo,
  PluginInfo,
  PluginsCache,
} from '@canopy/desktop-shared/types/plugins';
import type { EffectivePluginSelectionRefs } from '../plugins/plugin-resolver';
import { skillCatalogRevision } from '../skills/skill-catalog-revision';
import {
  readSkillLockSnapshot,
  type SkillLockSnapshot,
} from '../skills/skill-lock-snapshot';
import {
  pluginCatalogProviders,
  pluginCatalogRevision,
} from '../plugins/plugin-catalog-revision';
import {
  readDesktopChatSelectionLayers,
  type DesktopCatalogHostDeps,
} from './core-catalog-host';

/** What materialization reads; tests inject fakes. Defaults load lazily and never write. */
export interface DesktopMaterializationDeps extends Pick<
  DesktopCatalogHostDeps,
  | 'readPreferences'
  | 'readWorkspaceConfig'
  | 'readWorkspaceRevision'
  | 'readChatTabs'
  | 'normalizeAccountSelections'
  | 'normalizeAccountTombstones'
  | 'loadMarketplacesCacheOnly'
> {
  resolveEffectiveRefs(
    selections: ChatTabPluginSelections,
    warnings: string[],
    workspaceId: string,
    preferences: PreferencesData,
  ): Promise<EffectivePluginSelectionRefs>;
  resolvePluginRoot(
    plugin: PluginInfo,
    marketplace: MarketplaceInfo,
    provider: 'claude' | 'codex',
  ): Promise<string | null>;
  realpath(path: string): Promise<string>;
  /** CAN-4124: version reads that never write or migrate the lock. */
  readLockSnapshot(): Promise<SkillLockSnapshot>;
  readSkillFile(path: string): Promise<Buffer>;
  skillExists(path: string): boolean;
  /** Lexical containment in the skills or bundled root; null on escape (a warning is pushed). */
  resolveSkillDirectory(
    ref: SkillRef,
    warnings: string[],
  ): Promise<string | null>;
  /** Realpath containment, or null when SKILL.md is missing or the directory escapes. */
  canonicalSkillDirectory(ref: SkillRef): Promise<string | null>;
}

type SkillRef = { sourceId: string; skillName: string };

const defaultDeps: DesktopMaterializationDeps = {
  readPreferences: async () =>
    (await import('../lib/preferences-store')).readPreferencesFileDetailed(),
  readWorkspaceConfig: async (workspaceId) =>
    (await import('../lib/workspace-persistence')).readWorkspaceConfigDetailed(
      workspaceId,
    ),
  readWorkspaceRevision: async (workspaceId) => {
    const { readW5Revisions } = await import('../lib/w5-commit-log-file-store');
    return (
      (await readW5Revisions([{ kind: 'workspace', workspaceId }]))[0]
        ?.revision ?? 0
    );
  },
  readChatTabs: async (workspaceId, worktreeId) =>
    (await import('../lib/chat-tabs-reader')).readChatTabsFile(
      workspaceId,
      worktreeId,
    ),
  normalizeAccountSelections: async (value) =>
    (await import('../mcp/account-catalog')).normalizeAccountMcpSelections(
      value,
    ),
  normalizeAccountTombstones: async (value) =>
    (await import('../mcp/account-catalog')).normalizeAccountMcpTombstones(
      value,
    ),
  loadMarketplacesCacheOnly: async () =>
    (await import('../plugins/plugin-service')).loadMarketplacesCacheOnly(),
  resolveEffectiveRefs: async (
    selections,
    warnings,
    workspaceId,
    preferences,
  ) =>
    (
      await import('../plugins/plugin-resolver')
    ).resolveEffectivePluginSelectionRefs(
      selections,
      warnings,
      workspaceId,
      preferences,
    ),
  resolvePluginRoot: async (plugin, marketplace, provider) =>
    (await import('../plugins/plugin-resolver')).resolvePluginInfoPath(
      plugin,
      marketplace,
      [],
      false,
      provider,
    ),
  realpath: (path) => realpath(path),
  readLockSnapshot: () => readSkillLockSnapshot(),
  readSkillFile: (path) => readFile(path),
  skillExists: (path) => existsSync(path),
  resolveSkillDirectory: async (ref, warnings) =>
    (await import('../plugins/plugin-resolver')).resolveSelectedSkillDirectory(
      ref,
      warnings,
    ),
  canonicalSkillDirectory: async (ref) =>
    (await import('../plugins/plugin-resolver')).cursorSkillSourceDir(ref),
};

const withDefaults = (
  deps: Partial<DesktopMaterializationDeps> = {},
): DesktopMaterializationDeps => ({ ...defaultDeps, ...deps });

async function cachedMarketplaces(
  deps: DesktopMaterializationDeps,
): Promise<MarketplaceInfo[]> {
  let cache: Awaited<ReturnType<typeof deps.loadMarketplacesCacheOnly>>;
  try {
    cache = await deps.loadMarketplacesCacheOnly();
  } catch (error) {
    throw new CatalogSelectionUnavailableError(error);
  }
  if (!cache.success || !cache.data)
    throw new CatalogSelectionUnavailableError();
  const data: PluginsCache = cache.data;
  return data.marketplaces;
}

function lookup(
  marketplaces: readonly MarketplaceInfo[],
  marketplaceId: string,
  pluginName: string,
): { plugin: PluginInfo; marketplace: MarketplaceInfo } | null {
  const found = createMarketplaceShareResolver(
    marketplaces,
    (plugin) => plugin.displayName ?? plugin.name,
  ).findPlugin(marketplaceId, pluginName);
  return found.status === 'resolved' ? found.match : null;
}

/** The core's strict resolution of a chat's selection into plugin descriptors (CAN-4123). */
export function createDesktopMaterializationResolver(
  overrides?: Partial<DesktopMaterializationDeps>,
): CatalogMaterializationResolver {
  const deps = withDefaults(overrides);
  return {
    resolve: async (scope): Promise<CatalogMaterializationResolution> => {
      const { read, effective, preferences } =
        await readDesktopChatSelectionLayers(deps, scope);
      const skillWorkspace =
        scope.workspaceId === STANDALONE_CHAT_PROJECT_ID
          ? (
              await import('../lib/cowork-migration-map')
            ).resolveCoworkWorkspaceId(scope.worktreeId)
          : scope.workspaceId;
      const warnings: string[] = [];
      let refs: EffectivePluginSelectionRefs;
      try {
        refs = await deps.resolveEffectiveRefs(
          effective,
          warnings,
          skillWorkspace,
          preferences,
        );
      } catch (error) {
        throw new CatalogSelectionUnavailableError(error);
      }
      const marketplaces =
        refs.pluginRefs.length > 0 ? await cachedMarketplaces(deps) : [];
      const resolver = createMarketplaceShareResolver(
        marketplaces,
        (plugin) => plugin.displayName ?? plugin.name,
      );
      const items: CatalogMaterializationItemDescriptor[] = [];
      const unavailable: CatalogMaterializationResolution['unavailable'] = [];
      for (const ref of refs.pluginRefs) {
        const entryId = pluginEntryId(ref);
        const found = resolver.findPlugin(ref.marketplaceId, ref.pluginName);
        if (found.status !== 'resolved') {
          unavailable.push({ entryId, reason: 'missing' });
          continue;
        }
        const { plugin, marketplace } = found.match;
        const providers = pluginCatalogProviders(plugin);
        if (providers.length === 0) {
          unavailable.push({ entryId, reason: 'incompatible' });
          continue;
        }
        items.push({
          kind: 'plugin',
          entryId,
          marketplaceId: ref.marketplaceId,
          pluginName: ref.pluginName,
          providers,
          pluginRevision: pluginCatalogRevision(plugin, marketplace),
        });
      }
      const lock = await deps.readLockSnapshot();
      for (const ref of refs.skillRefs) {
        const entryId = skillEntryId(ref);
        const dir = await deps.resolveSkillDirectory(ref, warnings);
        if (dir === null) {
          unavailable.push({ entryId, reason: 'missing' });
          continue;
        }
        const skillMdPath = join(dir, 'SKILL.md');
        if (!deps.skillExists(skillMdPath)) {
          warnings.push(
            `Skill "${ref.skillName}" (source: ${ref.sourceId}) not found, skipping.`,
          );
          unavailable.push({ entryId, reason: 'missing' });
          continue;
        }
        const skillRevision = await skillCatalogRevision(
          ref,
          skillMdPath,
          lock,
          (path) => deps.readSkillFile(path),
        );
        if (skillRevision === null) {
          unavailable.push({ entryId, reason: 'missing' });
          continue;
        }
        items.push({
          kind: 'skill',
          entryId,
          sourceId: ref.sourceId,
          skillName: ref.skillName,
          skillRevision,
        });
      }
      for (const ref of refs.disabledRefs) {
        const entryId =
          ref.kind === 'plugin'
            ? pluginEntryId(ref)
            : ref.kind === 'skill'
              ? skillEntryId(ref)
              : ref.kind === 'mcp-config'
                ? mcpServerEntryId(ref)
                : ref.kind === 'collection'
                  ? collectionEntryId(ref.collectionId)
                  : null;
        if (entryId !== null) unavailable.push({ entryId, reason: 'disabled' });
      }
      // Skill/lock reads can yield after the plugin snapshot was validated.
      if (refs.pluginRefs.length > 0) await cachedMarketplaces(deps);
      return {
        selection: {
          revision: read.revision,
          selectedItemIds: selectionEntryIds(read.selections),
        },
        items,
        deferred: [
          ...refs.mcpServerRefs.map((ref) => ({
            entryId: mcpServerEntryId(ref),
            entryKind: 'mcp_server' as const,
          })),
        ],
        unavailable,
        warnings,
      };
    },
  };
}

/** The in-process worker's read-only view of installed plugins (CAN-4123). */
export function createDesktopWorkerCatalogHost(
  overrides?: Partial<DesktopMaterializationDeps>,
): WorkerCatalogHost {
  const deps = withDefaults(overrides);
  const root = async (
    plugin: PluginInfo,
    marketplace: MarketplaceInfo,
    provider: 'claude' | 'codex',
  ): Promise<string | null> => {
    try {
      const resolved = await deps.resolvePluginRoot(
        plugin,
        marketplace,
        provider,
      );
      return resolved === null ? null : await deps.realpath(resolved);
    } catch {
      return null;
    }
  };
  return {
    lookupPlugin: async (
      marketplaceId,
      pluginName,
    ): Promise<WorkerCatalogPluginInstall | null> => {
      const found = lookup(
        await cachedMarketplaces(deps),
        marketplaceId,
        pluginName,
      );
      if (!found) return null;
      const { plugin, marketplace } = found;
      const claude =
        plugin.providerSupport.claude === 'native'
          ? await root(plugin, marketplace, 'claude')
          : null;
      let codex: WorkerCatalogPluginInstall['roots']['codex'] = null;
      if (plugin.providerSupport.codex === 'native') {
        const codexRoot = await root(plugin, marketplace, 'codex');
        codex = codexRoot === null ? null : { root: codexRoot, mode: 'native' };
      } else if (
        plugin.providerSupport.codex === 'compat' &&
        plugin.codexCompatDisabled !== true
      ) {
        codex = claude === null ? null : { root: claude, mode: 'compat' };
      }
      // Root resolution and realpath must not publish stale healthy authority.
      await cachedMarketplaces(deps);
      return {
        pluginRevision: pluginCatalogRevision(plugin, marketplace),
        roots: { claude, codex },
      };
    },
    lookupSkill: async (
      sourceId,
      skillName,
    ): Promise<WorkerCatalogSkillInstall | null> => {
      const ref = { sourceId, skillName };
      const dir = await deps.resolveSkillDirectory(ref, []);
      if (dir === null) return null;
      const skillMdPath = join(dir, 'SKILL.md');
      if (!deps.skillExists(skillMdPath)) return null;
      const skillRevision = await skillCatalogRevision(
        ref,
        skillMdPath,
        await deps.readLockSnapshot(),
        (path) => deps.readSkillFile(path),
      );
      if (skillRevision === null) return null;
      return {
        skillRevision,
        sourceDir: dir,
        canonicalSourceDir: await deps.canonicalSkillDirectory(ref),
        skillMdPath,
      };
    },
  };
}
