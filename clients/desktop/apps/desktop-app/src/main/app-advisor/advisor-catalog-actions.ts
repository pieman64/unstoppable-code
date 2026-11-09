import {
  marketplaceMatches,
  marketplaceSummary,
} from '@canopy/desktop-shared/lib/app-advisor-catalog-results';
import {
  CHAT_PLUGIN_LIST_DEFAULT_LIMIT,
  CHAT_PLUGIN_LIST_MAX_LIMIT,
  clampLimit,
  emptyChatTabPluginSelections,
  pluginSelectionsResult,
} from '@canopy/desktop-shared/lib/app-advisor-chat-reads';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import type { SkillSuggestion } from '@canopy/desktop-shared/lib/skill-suggestions';
import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { selectionEntryIds } from '@canopy/protocol/canopy-core';
import type {
  AgentModelDefinition,
  SaveAgentModelRequest,
} from '@canopy/execution-engine/types/agent-models';
import type { MarketplaceInfo } from '@canopy/desktop-shared/types/plugins';
import type {
  CollectionConfig,
  CollectionIndexEntry,
} from '@canopy/protocol/collections';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import { toAdvisorJson } from './advisor-json';

export const ADVISOR_CATALOG_ACTION_TYPES = [
  'agents.list',
  'agents.get',
  'agents.create',
  'agents.update',
  'agents.delete',
  'collections.list',
  'collections.create',
  'collections.update',
  'collections.delete',
  'plugins.list_marketplaces',
  'plugins.refresh_marketplace',
  'plugins.remove_marketplace',
  'skills.list_marketplace',
  'skill_suggestions.list',
  'preferences.get_global_plugin_selections',
  'preferences.set_global_plugin_selections',
] as const;

export type AdvisorCatalogAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_CATALOG_ACTION_TYPES)[number] }
>;

export function isAdvisorCatalogAction(
  action: AppAdvisorAction,
): action is AdvisorCatalogAction {
  return ADVISOR_CATALOG_ACTION_TYPES.some((type) => type === action.type);
}

export type MarketplaceProvider = 'claude' | 'codex';

/** How a marketplace refresh through the core ended, read from its source. */
export type RefreshWait =
  | { state: 'succeeded' }
  | { state: 'failed'; errorCode: string | null }
  | { state: 'timed_out' };

/** The main owners App Advisor's catalog actions use (CAN-6002). */
export interface AdvisorCatalogActionHost {
  listAgents(): Promise<AgentModelDefinition[]>;
  getAgent(id: string): Promise<AgentModelDefinition | null>;
  /** The window's agent save, with its validation and change notice. */
  saveAgent(request: SaveAgentModelRequest): Promise<AgentModelDefinition>;
  /** The window's agent delete: the store refuses what it refuses for the window. */
  deleteAgent(id: string): Promise<boolean>;
  listCollections(): Promise<CollectionIndexEntry[]>;
  getCollection(id: string): Promise<CollectionConfig | null>;
  saveCollection(
    collection: Partial<CollectionConfig> & { name: string },
  ): Promise<CollectionConfig>;
  /** The window's collection delete. */
  deleteCollection(id: string): Promise<void>;
  /** The window's marketplace projection. */
  loadMarketplaces(): Promise<MarketplaceInfo[]>;
  /** Whether the row is built in or curated, which keep their direct paths. */
  isManagedMarketplace(id: string): boolean;
  /** The marketplace sources core.catalog.source.* serves, disabled ones included. */
  coreSourceIds(): Promise<ReadonlySet<string>>;
  /** core.catalog.source.refresh for one source; answers its operation id. */
  refreshThroughCore(sourceId: string): Promise<string>;
  /** Waits, within its bound, for the source's refresh by that operation to end. */
  awaitRefresh(operationId: string): Promise<RefreshWait>;
  /**
   * Asks a person in this chat to confirm removing the marketplace. Only a
   * person's answer confirms: no one to ask, a dismissal or an agent's answer
   * never does.
   */
  confirmMarketplaceRemoval(marketplace: {
    id: string;
    name: string;
  }): Promise<'confirmed' | 'declined' | 'no_person'>;
  /** The direct update the window and the Portal use for a built-in or curated row. */
  refreshDirect(sourceId: string): Promise<MarketplaceInfo>;
  /** core.catalog.source.delete. */
  removeThroughCore(
    sourceId: string,
    providers: readonly MarketplaceProvider[],
  ): Promise<{ removedProviders: string[]; alreadyAbsent: boolean }>;
  listMarketplaceSkills(): Promise<
    Array<{
      externalId: string;
      name: string;
      description: string;
      publisher: string;
      installedSkillName?: string | null;
    }>
  >;
  /** Null when skill suggestions are turned off. */
  listSkillSuggestions(): Promise<SkillSuggestion[] | null>;
  /** The work owner the window's sidebar scopes to. */
  activeOwner(): WorkOwner | undefined;
  /** The global plugin defaults and their core.catalog.selection revision. */
  readGlobalSelections(): Promise<{
    selections: ChatTabPluginSelections;
    revision: number;
  }>;
  /** Each catalog entry's availability, unavailable entries included. */
  catalogAvailability(): Promise<ReadonlyMap<string, string>>;
  /** The entry ids of plugins installed for at least one provider. */
  installedPluginEntryIds(): Promise<ReadonlySet<string>>;
  /** core.catalog.selection.update of the global defaults, checked against the revision. */
  replaceGlobalSelections(
    entryIds: readonly string[],
    expectedRevision: number,
  ): Promise<'applied' | 'conflict'>;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

function failure(
  code: 'not_found' | 'execution_failed' | 'surface_unavailable',
  message: string,
): Response {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(code === 'execution_failed' ? { retryable: true } : {}),
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function marketplaceRow(
  host: AdvisorCatalogActionHost,
  id: string,
): Promise<AppAdvisorJson> {
  const row = (await host.loadMarketplaces()).find((entry) => entry.id === id);
  return row ? marketplaceSummary(row) : null;
}

async function run(
  action: AdvisorCatalogAction,
  host: AdvisorCatalogActionHost,
): Promise<Response> {
  switch (action.type) {
    case 'agents.list': {
      const query = action.query?.trim().toLowerCase();
      const agents = (await host.listAgents()).filter(
        (agent) =>
          !query ||
          agent.id.toLowerCase().includes(query) ||
          agent.name.toLowerCase().includes(query),
      );
      const limit =
        action.limit && action.limit > 0
          ? Math.min(action.limit, agents.length)
          : agents.length;
      return {
        ok: true,
        result: { agents: toAdvisorJson(agents.slice(0, limit)) },
      };
    }
    case 'agents.get': {
      const agent = await host.getAgent(action.id);
      return agent
        ? { ok: true, result: toAdvisorJson(agent) }
        : failure('not_found', `Local agent ${action.id} was not found.`);
    }
    case 'agents.create':
      return {
        ok: true,
        result: toAdvisorJson(
          await host.saveAgent({
            name: action.name,
            baseModel: action.baseModel,
            instructions: action.instructions,
            ...(action.modelIdSlug ? { modelIdSlug: action.modelIdSlug } : {}),
            pluginSelections:
              action.pluginSelections ?? emptyChatTabPluginSelections(),
          }),
        ),
      };
    case 'agents.update': {
      const existing = await host.getAgent(action.id);
      if (!existing)
        return failure('not_found', `Local agent ${action.id} was not found.`);
      return {
        ok: true,
        result: toAdvisorJson(
          await host.saveAgent({
            id: existing.id,
            name: action.name ?? existing.name,
            baseModel: action.baseModel ?? existing.baseModel,
            instructions: action.instructions ?? existing.instructions,
            pluginSelections:
              action.pluginSelections ?? existing.pluginSelections,
          }),
        ),
      };
    }
    case 'agents.delete':
      await host.deleteAgent(action.id);
      return { ok: true, result: { id: action.id } };
    case 'collections.list':
      return {
        ok: true,
        result: { collections: toAdvisorJson(await host.listCollections()) },
      };
    case 'collections.create':
      return {
        ok: true,
        result: toAdvisorJson(
          await host.saveCollection({
            name: action.name,
            ...(action.description !== undefined
              ? { description: action.description }
              : {}),
            skills: action.skills ?? [],
            plugins: action.plugins ?? [],
            mcpServers: action.mcpServers ?? [],
          }),
        ),
      };
    case 'collections.update': {
      const existing = await host.getCollection(action.id);
      if (!existing)
        return failure(
          'not_found',
          `Local collection ${action.id} was not found.`,
        );
      return {
        ok: true,
        result: toAdvisorJson(
          await host.saveCollection({
            ...existing,
            ...(action.name !== undefined ? { name: action.name } : {}),
            ...(action.description !== undefined
              ? { description: action.description }
              : {}),
            ...(action.skills !== undefined ? { skills: action.skills } : {}),
            ...(action.plugins !== undefined
              ? { plugins: action.plugins }
              : {}),
            ...(action.mcpServers !== undefined
              ? { mcpServers: action.mcpServers }
              : {}),
          }),
        ),
      };
    }
    case 'collections.delete':
      await host.deleteCollection(action.id);
      return { ok: true, result: { id: action.id } };
    case 'plugins.list_marketplaces': {
      const query = action.query?.trim() ?? '';
      const limit = clampLimit(
        action.limit,
        CHAT_PLUGIN_LIST_DEFAULT_LIMIT,
        CHAT_PLUGIN_LIST_MAX_LIMIT,
      );
      const filtered = (await host.loadMarketplaces())
        .filter((marketplace) => marketplaceMatches(marketplace, query))
        .sort((a, b) => a.name.localeCompare(b.name));
      const rows = filtered.slice(0, limit).map(marketplaceSummary);
      return {
        ok: true,
        result: {
          query,
          totalMatches: filtered.length,
          returned: rows.length,
          marketplaces: rows,
        },
      };
    }
    case 'plugins.refresh_marketplace': {
      const id = action.marketplaceId;
      // A source the core does not serve (built-in, curated, or a native
      // Codex marketplace) keeps the window's direct refresh.
      if (
        host.isManagedMarketplace(id) ||
        !(await host.coreSourceIds()).has(id)
      )
        return {
          ok: true,
          result: {
            marketplace: marketplaceSummary(await host.refreshDirect(id)),
          },
        };
      const operationId = await host.refreshThroughCore(id);
      const ended = await host.awaitRefresh(operationId);
      if (ended.state === 'timed_out')
        return { ok: true, result: { started: true, operationId } };
      if (ended.state === 'failed')
        return failure(
          'execution_failed',
          ended.errorCode
            ? `Failed to refresh plugin marketplace (${ended.errorCode}).`
            : 'Failed to refresh plugin marketplace.',
        );
      return {
        ok: true,
        result: { marketplace: await marketplaceRow(host, id), operationId },
      };
    }
    case 'plugins.remove_marketplace': {
      const id = action.marketplaceId;
      const providers =
        action.providers && action.providers.length > 0
          ? action.providers
          : undefined;
      // Built-in and curated rows stay refused, before any question or write.
      if (host.isManagedMarketplace(id))
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'Built-in and curated marketplaces cannot be removed.',
          },
        };
      const row = (await host.loadMarketplaces()).find(
        (marketplace) => marketplace.id === id,
      );
      if (!row) return failure('not_found', `Marketplace "${id}" not found.`);
      if (!(await host.coreSourceIds()).has(id))
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'This marketplace is not one the plugin catalog can remove. Remove it from the Plugins page.',
          },
        };
      // Removing a source takes its installed plugins away: only a person's
      // confirmation lets it go ahead (CAN-6002).
      const confirmed = await host.confirmMarketplaceRemoval({
        id,
        name: row.name,
      });
      if (confirmed === 'no_person')
        return failure(
          'surface_unavailable',
          'No person confirmed removing this marketplace, so nothing was removed.',
        );
      if (confirmed === 'declined')
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'The marketplace was kept; nothing was removed.',
          },
        };
      const removal = await host.removeThroughCore(
        id,
        providers ?? ['claude', 'codex'],
      );
      return {
        ok: true,
        result: {
          sourceId: id,
          ...toAdvisorJsonRecord(removal),
          marketplaces: (await host.loadMarketplaces()).map(marketplaceSummary),
        },
      };
    }
    case 'skills.list_marketplace': {
      const query = action.query?.trim().toLowerCase() ?? '';
      const matches = (await host.listMarketplaceSkills()).filter((row) =>
        `${row.name}\n${row.description}\n${row.publisher}`
          .toLowerCase()
          .includes(query),
      );
      const limit = clampLimit(
        action.limit,
        CHAT_PLUGIN_LIST_DEFAULT_LIMIT,
        CHAT_PLUGIN_LIST_MAX_LIMIT,
      );
      return {
        ok: true,
        result: {
          totalMatches: matches.length,
          skills: matches.slice(0, limit).map((row) => ({
            entryId: `public-share:skill:${row.externalId}`,
            name: row.name,
            description: row.description,
            publisher: row.publisher,
            installed: Boolean(row.installedSkillName),
          })),
        },
      };
    }
    case 'skill_suggestions.list': {
      const all = await host.listSkillSuggestions();
      if (all === null)
        return failure(
          'surface_unavailable',
          'Skill suggestions are not available.',
        );
      // Partitions are never mixed: only the active owner's non-private
      // suggestions, and a count of the rest.
      const owner = host.activeOwner() ?? { kind: 'personal' };
      const visible = all.filter(
        (suggestion) =>
          !suggestion.isPrivate &&
          (suggestion.owner.kind === 'personal'
            ? owner.kind === 'personal'
            : owner.kind === 'organization' &&
              owner.organizationId === suggestion.owner.organizationId),
      );
      const otherSuggestionCount = all.length - visible.length;
      return {
        ok: true,
        result: {
          ...(otherSuggestionCount > 0 ? { otherSuggestionCount } : {}),
          suggestions: visible.map((suggestion) => ({
            id: suggestion.id,
            kind: suggestion.kind,
            title: suggestion.title,
            summary: suggestion.summary,
            proposedSkillName: suggestion.proposedSkillName,
            occurrenceCount: suggestion.occurrenceCount,
            chainSkills: toAdvisorJson(suggestion.chainSkills),
            ownerLabel: suggestion.ownerLabel,
          })),
        },
      };
    }
    case 'preferences.get_global_plugin_selections': {
      const current = await host.readGlobalSelections();
      return {
        ok: true,
        result: {
          pluginSelections: pluginSelectionsResult(current.selections),
          revision: current.revision,
        },
      };
    }
    case 'preferences.set_global_plugin_selections': {
      const normalized = normalizePluginSelections(action.selections);
      const entryIds = selectionEntryIds(normalized);
      // A reference normalization would drop is refused, never silently
      // turned into a smaller set that replaces the defaults.
      const kept = new Set(entryIds);
      const malformed = selectionEntryIds(action.selections).filter(
        (id) => !kept.has(id),
      );
      if (malformed.length > 0)
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: `Not a valid reference: ${malformed.join(', ')}.`,
          },
        };
      // core.catalog.selection.update writes entry ids only, so a change to
      // MCP sign-in preferences is refused rather than dropped.
      const before = await host.readGlobalSelections();
      if (
        action.selections.mcpHttpAuthPreferences !== undefined &&
        JSON.stringify(normalized.mcpHttpAuthPreferences ?? []) !==
          JSON.stringify(before.selections.mcpHttpAuthPreferences ?? [])
      )
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message:
              'MCP sign-in preferences cannot be changed here. Leave them out, or change them in Settings.',
          },
        };
      // Only what is installed and usable now: no install, fetch or sign-in
      // is started, and one unknown item refuses the whole set.
      const [availability, installedPlugins] = await Promise.all([
        host.catalogAvailability(),
        host.installedPluginEntryIds(),
      ]);
      const plugins = new Set(
        selectionEntryIds({ pluginRefs: normalized.pluginRefs }),
      );
      const refused = entryIds.filter(
        (id) =>
          availability.get(id) !== 'available' ||
          (plugins.has(id) && !installedPlugins.has(id)),
      );
      if (refused.length > 0)
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Only installed, available items can be global defaults. Not available: ${refused.join(', ')}.`,
          },
        };
      const outcome = await host.replaceGlobalSelections(
        entryIds,
        action.expectedRevision,
      );
      if (outcome === 'conflict')
        return {
          ok: false,
          error: {
            code: 'stale_ui_state',
            message:
              'The global defaults changed since they were read. Read them again and retry.',
            retryable: true,
          },
        };
      const after = await host.readGlobalSelections();
      return {
        ok: true,
        result: {
          before: pluginSelectionsResult(before.selections),
          pluginSelections: pluginSelectionsResult(after.selections),
          revision: after.revision,
        },
      };
    }
  }
}

function toAdvisorJsonRecord(value: object): Record<string, AppAdvisorJson> {
  const json = toAdvisorJson(value);
  return json !== null && typeof json === 'object' && !Array.isArray(json)
    ? json
    : {};
}

/**
 * App Advisor's catalog actions in Electron main (CAN-6002): agents and
 * collections on the stores the window's IPC handlers use, refusing what
 * they refuse; marketplace writes through core.catalog.source.*, with built-in
 * and curated rows on their direct paths; marketplace reads from the window's
 * own projection.
 */
export async function dispatchAdvisorCatalogAction(
  action: AdvisorCatalogAction,
  host: AdvisorCatalogActionHost,
): Promise<Response> {
  try {
    return await run(action, host);
  } catch (error) {
    return failure('execution_failed', messageOf(error));
  }
}
