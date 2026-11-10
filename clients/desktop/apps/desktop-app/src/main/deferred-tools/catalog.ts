import { filterStoredSkillContexts } from '../skills/skill-install-context';
import { readInstalledItemPolicy } from '../installed-items/installed-item-policy';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type {
  ChatTabPluginSelections,
  DeferredResourceKind,
  DeferredResourceSummary,
  DeferredToolMatch,
  DeferredToolProvider,
  DeferredToolsReloadAdditions,
  LoadDeferredToolRejection,
} from '@canopy/desktop-shared/types';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import type { InstalledSkillInfo } from '@canopy/desktop-shared/types/skills';
import type {
  MarketplaceInfo,
  PluginInfo,
} from '@canopy/execution-engine/types/plugins';
import {
  cursorPluginFacetProvider,
  cursorPluginFacetSupport,
  cursorLoadsPluginMemberKind,
} from '@canopy/plugin-interop/cursor-support';
import type {
  McpServerConfigSummary,
  McpServerIndexEntry,
  McpServersIndexFile,
} from '@canopy/execution-engine/types/mcp-servers';
import { loadSkills } from '../skills/skill-service';
import { loadMarketplacesCacheOnly } from '../plugins/plugin-service';
import {
  resolveEffectivePluginSelectionRefs,
  resolvePluginInfoPath,
  discoverCursorPluginMembers,
  readPluginMcpAuthEntries,
} from '../plugins/plugin-resolver';
import { getMcpServersIndexFilePath } from '../lib/paths';

export type DeferredCatalogItemStatus =
  | 'available'
  | 'already_enabled'
  | 'unsupported'
  | 'disabled';

export interface DeferredCatalogItem {
  identityRef: string;
  ref: string;
  kind: DeferredResourceKind;
  name: string;
  description: string;
  sourceLabel?: string;
  status: DeferredCatalogItemStatus;
  reason?: string;
  selection: DeferredResourceSummary;
  /** Search-only capability metadata; the parent plugin remains loadable. */
  pluginMembers?: DeferredPluginMember[];
}

interface DeferredPluginMember {
  kind: 'skill' | 'command';
  name: string;
  description: string;
}

export interface DeferredCatalog {
  provider: DeferredToolProvider;
  items: DeferredCatalogItem[];
  byRef: Map<string, DeferredCatalogItem>;
  additionsFor(
    items: readonly DeferredCatalogItem[],
  ): DeferredToolsReloadAdditions;
}

export interface LoadClassification {
  willEnable: DeferredResourceSummary[];
  rejected: LoadDeferredToolRejection[];
  additions: DeferredToolsReloadAdditions;
}

export interface BuildDeferredToolsCatalogOptions {
  provider: DeferredToolProvider;
  pluginSelections?: ChatTabPluginSelections;
}

export function encodeDeferredCatalogRef(identityRef: string): string {
  const digest = createHash('sha256').update(identityRef).digest('base64url');
  return `deferred:v1:${digest}`;
}

function encodePart(value: string): string {
  return encodeURIComponent(value);
}

export function encodeSkillRef(sourceId: string, skillName: string): string {
  return `skill:${encodePart(sourceId)}:${encodePart(skillName)}`;
}

export function encodePluginRef(
  marketplaceId: string,
  pluginName: string,
): string {
  return `plugin:${encodePart(marketplaceId)}:${encodePart(pluginName)}`;
}

export function encodeMcpRef(serverId: string, configId: string): string {
  return `mcp:${encodePart(serverId)}:${encodePart(configId)}`;
}

function skillKey(ref: { sourceId: string; skillName: string }): string {
  return `${ref.sourceId}\u0000${ref.skillName}`;
}

function pluginKey(ref: { marketplaceId: string; pluginName: string }): string {
  return `${ref.marketplaceId}\u0000${ref.pluginName.toLowerCase()}`;
}

function mcpKey(ref: { serverId: string; configId: string }): string {
  return `${ref.serverId}\u0000${ref.configId}`;
}

function providerAllowsPluginSupport(
  plugin: PluginInfo,
  provider: DeferredToolProvider,
): boolean {
  // OpenCode uses the same projected facet/member contract as Cursor.
  if (provider === 'opencode') {
    return cursorPluginFacetSupport(plugin.facets).supported;
  }
  if (provider === 'codex') {
    return plugin.providerSupport.codex !== 'none';
  }
  return plugin.providerSupport.claude === 'native';
}

function providerHasInstalledPluginFacet(
  plugin: PluginInfo,
  provider: DeferredToolProvider,
): boolean {
  if (
    provider !== 'opencode' &&
    plugin.cachePath &&
    existsSync(plugin.cachePath)
  ) {
    return true;
  }
  const facets =
    provider === 'opencode'
      ? [plugin.facets[cursorPluginFacetProvider(plugin.facets)]]
      : provider === 'codex'
        ? plugin.providerSupport.codex === 'native'
          ? [plugin.facets.codex]
          : [plugin.facets.codexCompatibility, plugin.facets.claude]
        : [plugin.facets.claude];
  return facets.some(
    (facet) =>
      facet !== undefined &&
      ((facet.cachePath !== undefined && existsSync(facet.cachePath)) ||
        (facet.installLocation.length > 0 &&
          existsSync(facet.installLocation))),
  );
}

async function loadMcpIndex(): Promise<McpServersIndexFile> {
  try {
    const raw = await readFile(getMcpServersIndexFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isMcpServersIndexFile(parsed)) {
      return parsed;
    }
  } catch {
    // Missing or malformed local MCP state is equivalent to an empty index.
  }
  return { version: 1, servers: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMcpServerConfigSummary(
  value: unknown,
): value is McpServerConfigSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

function isMcpServerIndexEntry(value: unknown): value is McpServerIndexEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    (value.type === 'command' || value.type === 'http') &&
    Array.isArray(value.configs) &&
    value.configs.every(isMcpServerConfigSummary) &&
    typeof value.updatedAt === 'string'
  );
}

function isMcpServersIndexFile(value: unknown): value is McpServersIndexFile {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.servers) &&
    value.servers.every(isMcpServerIndexEntry)
  );
}

function itemSummary(item: DeferredCatalogItem): DeferredResourceSummary {
  return {
    ref: item.ref,
    kind: item.kind,
    name: item.name,
    ...(item.sourceLabel ? { sourceLabel: item.sourceLabel } : {}),
  };
}

function skillItem(
  skill: InstalledSkillInfo,
  enabledKeys: ReadonlySet<string>,
): DeferredCatalogItem {
  const identityRef = encodeSkillRef(skill.sourceId, skill.name);
  const ref = encodeDeferredCatalogRef(identityRef);
  const enabled = enabledKeys.has(
    skillKey({ sourceId: skill.sourceId, skillName: skill.name }),
  );
  return {
    identityRef,
    ref,
    kind: 'skill',
    name: skill.name,
    description: skill.description,
    sourceLabel: skill.source,
    status: enabled ? 'already_enabled' : 'available',
    ...(enabled ? { reason: 'Already enabled in this chat.' } : {}),
    selection: {
      ref,
      kind: 'skill',
      name: skill.name,
      sourceLabel: skill.source,
    },
  };
}

function pluginItem(
  marketplace: MarketplaceInfo,
  plugin: PluginInfo,
  provider: DeferredToolProvider,
  enabledKeys: ReadonlySet<string>,
): DeferredCatalogItem {
  const identityRef = encodePluginRef(marketplace.id, plugin.name);
  const ref = encodeDeferredCatalogRef(identityRef);
  const supported =
    providerAllowsPluginSupport(plugin, provider) &&
    !(
      provider === 'codex' &&
      plugin.providerSupport.codex === 'compat' &&
      plugin.codexCompatDisabled === true
    );
  const enabled = enabledKeys.has(
    pluginKey({ marketplaceId: marketplace.id, pluginName: plugin.name }),
  );
  const sourceLabel = marketplace.name;
  return {
    identityRef,
    ref,
    kind: 'plugin',
    name: plugin.name,
    description: plugin.description ?? marketplace.description ?? '',
    sourceLabel,
    status: !supported
      ? 'unsupported'
      : enabled
        ? 'already_enabled'
        : 'available',
    ...(!supported
      ? { reason: `Plugin is not supported by ${provider}.` }
      : enabled
        ? { reason: 'Already enabled in this chat.' }
        : {}),
    selection: { ref, kind: 'plugin', name: plugin.name, sourceLabel },
    pluginMembers: pluginMembersForProvider(plugin, provider),
  };
}

/** Copilot projects installed content; native hooks/agents/apps are not capabilities. */
async function copilotPluginItem(
  marketplace: MarketplaceInfo,
  plugin: PluginInfo,
  enabledKeys: ReadonlySet<string>,
): Promise<DeferredCatalogItem | undefined> {
  // Match non-Codex execution's Claude-first facet precedence. Never install
  // while searching, and never fall back to another facet if this one vanished.
  const provider = plugin.facets.claude ? 'claude' : 'codex';
  const root = await resolvePluginInfoPath(
    plugin,
    marketplace,
    [],
    false,
    provider,
  );
  if (!root) return undefined;
  const members = discoverCursorPluginMembers(root, provider);
  const mcp = await readPluginMcpAuthEntries(
    root,
    marketplace.id,
    plugin.name,
    provider,
  );
  const supported = members.length > 0 || mcp.length > 0;
  const item = pluginItem(marketplace, plugin, 'copilot', enabledKeys);
  const enabled = enabledKeys.has(
    pluginKey({ marketplaceId: marketplace.id, pluginName: plugin.name }),
  );
  return {
    ...item,
    status: !supported
      ? 'unsupported'
      : enabled
        ? 'already_enabled'
        : 'available',
    reason: !supported
      ? 'This plugin has no installed skills, commands, or MCP servers supported by Copilot.'
      : enabled
        ? 'Already enabled in this chat.'
        : undefined,
    pluginMembers: members.map((member) => ({
      kind: member.kind === 'plugin_skill' ? 'skill' : 'command',
      name: member.name,
      description:
        member.kind === 'plugin_skill'
          ? member.skill.description
          : member.command.description,
    })),
  };
}

function pluginMembersForProvider(
  plugin: PluginInfo,
  provider: DeferredToolProvider,
): DeferredPluginMember[] {
  const details =
    provider === 'opencode'
      ? plugin.facets[cursorPluginFacetProvider(plugin.facets)]?.details
      : provider === 'codex'
        ? (plugin.facets.codex?.details ??
          plugin.facets.codexCompatibility?.details ??
          plugin.details)
        : (plugin.facets.claude?.details ?? plugin.details);
  if (!details) return [];

  const members: DeferredPluginMember[] = [];
  const seen = new Set<string>();
  for (const member of details.skills) {
    const key = `skill\0${member.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({
      kind: 'skill',
      name: member.name,
      description: member.description,
    });
  }
  const commands =
    provider === 'opencode' &&
    !cursorLoadsPluginMemberKind(
      cursorPluginFacetProvider(plugin.facets),
      'commands',
    )
      ? []
      : details.commands;
  for (const member of commands) {
    const key = `command\0${member.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({
      kind: 'command',
      name: member.name,
      description: member.description,
    });
  }
  return members;
}

function mcpItem(
  server: { id: string; name: string; description: string },
  config: McpServerConfigSummary,
  enabledKeys: ReadonlySet<string>,
): DeferredCatalogItem {
  const identityRef = encodeMcpRef(server.id, config.id);
  const ref = encodeDeferredCatalogRef(identityRef);
  const selected = enabledKeys.has(
    mcpKey({ serverId: server.id, configId: config.id }),
  );
  const sourceLabel = server.name;
  const name =
    config.name && config.name !== server.name
      ? `${server.name} / ${config.name}`
      : server.name;
  return {
    identityRef,
    ref,
    kind: 'mcp',
    name,
    description: server.description,
    sourceLabel,
    status: !config.enabled
      ? 'disabled'
      : selected
        ? 'already_enabled'
        : 'available',
    ...(!config.enabled
      ? { reason: 'MCP server config is disabled.' }
      : selected
        ? { reason: 'Already enabled in this chat.' }
        : {}),
    selection: { ref, kind: 'mcp', name, sourceLabel },
  };
}

export async function buildDeferredToolsCatalog(
  options: BuildDeferredToolsCatalogOptions,
): Promise<DeferredCatalog> {
  const normalizedSelections = normalizePluginSelections(
    options.pluginSelections,
  );
  const effective =
    await resolveEffectivePluginSelectionRefs(normalizedSelections);
  const enabledSkillKeys = new Set(effective.skillRefs.map(skillKey));
  const enabledPluginKeys = new Set(effective.pluginRefs.map(pluginKey));
  const enabledMcpKeys = new Set(effective.mcpServerRefs.map(mcpKey));

  const items: DeferredCatalogItem[] = [];
  const policy = await readInstalledItemPolicy();

  const skillsResult = loadSkills();
  if (skillsResult.success && skillsResult.data)
    skillsResult.data = await filterStoredSkillContexts(skillsResult.data);
  if (skillsResult.success && skillsResult.data) {
    for (const skill of skillsResult.data) {
      if (
        policy.isDisabled({
          kind: 'skill',
          sourceId: skill.sourceId,
          skillName: skill.name,
        })
      )
        continue;
      items.push(skillItem(skill, enabledSkillKeys));
    }
  }

  const marketplacesResult = await loadMarketplacesCacheOnly();
  if (marketplacesResult.success && marketplacesResult.data) {
    for (const marketplace of marketplacesResult.data.marketplaces) {
      for (const plugin of marketplace.plugins) {
        if (
          policy.isDisabled({
            kind: 'plugin',
            marketplaceId: marketplace.id,
            pluginName: plugin.name,
          })
        )
          continue;
        if (options.provider === 'copilot') {
          const item = await copilotPluginItem(
            marketplace,
            plugin,
            enabledPluginKeys,
          );
          if (item) items.push(item);
          continue;
        }
        if (
          providerAllowsPluginSupport(plugin, options.provider) &&
          !providerHasInstalledPluginFacet(plugin, options.provider)
        ) {
          continue;
        }
        items.push(
          pluginItem(marketplace, plugin, options.provider, enabledPluginKeys),
        );
      }
    }
  }

  const mcpIndex = await loadMcpIndex();
  for (const server of mcpIndex.servers) {
    for (const config of server.configs) {
      if (config.enabled) {
        items.push(mcpItem(server, config, enabledMcpKeys));
      }
    }
  }

  items.sort(compareCatalogItems);
  const byRef = new Map(items.map((item) => [item.ref, item]));
  return {
    provider: options.provider,
    items,
    byRef,
    additionsFor(selectedItems): DeferredToolsReloadAdditions {
      const additions: DeferredToolsReloadAdditions = {
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      };
      for (const item of selectedItems) {
        if (item.kind === 'skill') {
          const [, sourceId = '', skillName = ''] = item.identityRef.split(':');
          additions.skillRefs.push({
            sourceId: decodeURIComponent(sourceId),
            skillName: decodeURIComponent(skillName),
          });
        } else if (item.kind === 'plugin') {
          const [, marketplaceId = '', pluginName = ''] =
            item.identityRef.split(':');
          additions.pluginRefs.push({
            marketplaceId: decodeURIComponent(marketplaceId),
            pluginName: decodeURIComponent(pluginName),
          });
        } else {
          const [, serverId = '', configId = ''] = item.identityRef.split(':');
          additions.mcpServerRefs.push({
            serverId: decodeURIComponent(serverId),
            configId: decodeURIComponent(configId),
          });
        }
      }
      return additions;
    },
  };
}

function compareCatalogItems(
  a: DeferredCatalogItem,
  b: DeferredCatalogItem,
): number {
  return (
    a.kind.localeCompare(b.kind) ||
    a.name.localeCompare(b.name) ||
    a.identityRef.localeCompare(b.identityRef)
  );
}

type MatchRank = 0 | 1 | 2 | 3;

function rankText(
  names: readonly string[],
  fields: readonly (string | undefined)[],
  query: string,
): MatchRank | null {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return null;
  }
  const normalizedNames = names.map((name) => name.toLowerCase());
  if (normalizedNames.some((name) => name === needle)) return 0;
  if (normalizedNames.some((name) => name.startsWith(needle))) return 1;
  const haystack = [...names, ...fields]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const tokens = haystack.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.some((token) => token === needle || token.startsWith(needle))) {
    return 2;
  }
  return haystack.includes(needle) ? 3 : null;
}

function rankItem(item: DeferredCatalogItem, query: string): MatchRank | null {
  return rankText(
    [item.name],
    [item.description, item.sourceLabel, item.kind],
    query,
  );
}

interface QualifiedPluginMemberQuery {
  plugin: string;
  member: string;
}

function parseQualifiedPluginMemberQuery(
  query: string,
): QualifiedPluginMemberQuery | null {
  const trimmed = query.trim();
  const separator = trimmed.indexOf(':');
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  const plugin = trimmed.slice(0, separator).trim();
  const member = trimmed.slice(separator + 1).trim();
  return plugin && member ? { plugin, member } : null;
}

function rankPluginMember(
  plugin: DeferredCatalogItem,
  member: DeferredPluginMember,
  query: string,
): MatchRank | null {
  const trimmed = query.trim();
  const names = trimmed.includes(' ')
    ? [
        member.name,
        `${plugin.name}:${member.name}`,
        `${plugin.name} ${member.name}`,
      ]
    : [member.name];
  return rankText(names, [member.description], trimmed);
}

interface RankedPluginMember {
  member: DeferredPluginMember;
  rank: MatchRank;
}

function comparePluginMembers(
  a: RankedPluginMember,
  b: RankedPluginMember,
): number {
  return (
    (a.member.kind === 'skill' ? 0 : 1) - (b.member.kind === 'skill' ? 0 : 1) ||
    a.rank - b.rank ||
    a.member.name.localeCompare(b.member.name)
  );
}

interface RankedCatalogMatch {
  item: DeferredCatalogItem;
  rank: number;
  pluginRank: number;
  pluginMemberMatch: boolean;
  matchedMembers?: RankedPluginMember[];
}

export interface DeferredCatalogSearchResult {
  matches: DeferredToolMatch[];
  unsupportedMatches: number;
}

export function searchDeferredCatalogResult(
  catalog: DeferredCatalog,
  query: string,
  options: { kinds?: DeferredResourceKind[]; limit?: number } = {},
): DeferredCatalogSearchResult {
  const allowedKinds = options.kinds?.length
    ? new Set(options.kinds)
    : undefined;
  const qualified = parseQualifiedPluginMemberQuery(query);
  const rankedByRef = new Map<string, RankedCatalogMatch>();
  for (const item of catalog.items) {
    if (!qualified && (!allowedKinds || allowedKinds.has(item.kind))) {
      const rank = rankItem(item, query);
      if (rank !== null) {
        rankedByRef.set(item.ref, {
          item,
          rank,
          pluginRank: 0,
          pluginMemberMatch: false,
        });
      }
    }

    const deepPluginSearchAllowed =
      item.kind === 'plugin' &&
      (!allowedKinds ||
        allowedKinds.has('skill') ||
        allowedKinds.has('plugin'));
    if (!deepPluginSearchAllowed || !item.pluginMembers?.length) {
      continue;
    }

    const pluginRank = qualified ? rankItem(item, qualified.plugin) : 0;
    if (qualified && pluginRank === null) continue;
    const memberQuery = qualified?.member ?? query;
    const matchedMembers = item.pluginMembers
      .map((member): RankedPluginMember | null => {
        const rank = rankPluginMember(item, member, memberQuery);
        return rank === null ? null : { member, rank };
      })
      .filter((match): match is RankedPluginMember => match !== null)
      .sort(comparePluginMembers);
    if (matchedMembers.length === 0) continue;

    const existing = rankedByRef.get(item.ref);
    if (existing) {
      existing.matchedMembers = matchedMembers;
      continue;
    }
    rankedByRef.set(item.ref, {
      item,
      rank: matchedMembers[0]?.rank ?? 3,
      pluginRank: pluginRank ?? 0,
      pluginMemberMatch: true,
      matchedMembers,
    });
  }
  let ranked = Array.from(rankedByRef.values());
  if (qualified && ranked.some((match) => match.pluginRank === 0)) {
    ranked = ranked.filter((match) => match.pluginRank === 0);
  }
  ranked.sort(
    (a, b) =>
      Number(a.pluginMemberMatch) - Number(b.pluginMemberMatch) ||
      a.pluginRank - b.pluginRank ||
      a.rank - b.rank ||
      compareCatalogItems(a.item, b.item),
  );
  const unsupportedMatches = ranked.filter(
    ({ item }) => item.status === 'unsupported' || item.status === 'disabled',
  ).length;
  const matches = ranked
    .filter(
      ({ item }) => item.status !== 'unsupported' && item.status !== 'disabled',
    )
    .slice(0, options.limit ?? 10)
    .map(
      ({ item, matchedMembers }): DeferredToolMatch => ({
        ref: item.ref,
        kind: item.kind,
        name: item.name,
        description: item.description,
        ...(item.sourceLabel ? { sourceLabel: item.sourceLabel } : {}),
        status:
          item.status === 'already_enabled' ? 'already_enabled' : 'available',
        ...(item.reason ? { reason: item.reason } : {}),
        ...(matchedMembers
          ? {
              matchedMembers: matchedMembers.slice(0, 10).map(({ member }) => ({
                kind: member.kind,
                name: `${item.name}:${member.name}`,
                description: member.description,
              })),
            }
          : {}),
      }),
    );
  return { matches, unsupportedMatches };
}

export function searchDeferredCatalog(
  catalog: DeferredCatalog,
  query: string,
  options: { kinds?: DeferredResourceKind[]; limit?: number } = {},
): DeferredToolMatch[] {
  return searchDeferredCatalogResult(catalog, query, options).matches;
}

export const DEFERRED_REF_NOT_ISSUED_MESSAGE =
  'This chat has not been given that ref. Search with SearchDeferredTools in this chat, then load a ref it returned.';

/**
 * Classifies a Load request against the live catalog. `issued` says whether
 * search returned a ref to this chat (CAN-5995); any other ref is refused
 * before the catalog is consulted.
 */
export function classifyLoadItems(
  catalog: DeferredCatalog,
  refs: readonly string[],
  issued: (ref: string) => boolean,
): LoadClassification {
  const seen = new Set<string>();
  const selected: DeferredCatalogItem[] = [];
  const rejected: LoadDeferredToolRejection[] = [];
  for (const ref of refs) {
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed)) {
      if (!trimmed) {
        rejected.push({
          ref,
          code: 'invalid_ref',
          message: 'Load item ref must be a non-empty string.',
        });
      }
      continue;
    }
    seen.add(trimmed);
    if (!issued(trimmed)) {
      rejected.push({
        ref: trimmed,
        code: 'not_found',
        message: DEFERRED_REF_NOT_ISSUED_MESSAGE,
      });
      continue;
    }
    const item = catalog.byRef.get(trimmed);
    if (!item) {
      rejected.push({
        ref: trimmed,
        code: 'not_found',
        message: 'Catalog item was not found.',
      });
      continue;
    }
    if (item.status === 'already_enabled') {
      rejected.push({
        ref: trimmed,
        code: 'already_enabled',
        message: item.reason ?? 'Item is already enabled.',
      });
      continue;
    }
    if (item.status === 'unsupported') {
      rejected.push({
        ref: trimmed,
        code: 'unsupported',
        message: item.reason ?? 'Item is unsupported by this provider.',
      });
      continue;
    }
    if (item.status === 'disabled') {
      rejected.push({
        ref: trimmed,
        code: 'disabled',
        message: item.reason ?? 'Item is disabled.',
      });
      continue;
    }
    selected.push(item);
  }

  return {
    willEnable: selected.map(itemSummary),
    rejected,
    additions: catalog.additionsFor(selected),
  };
}
