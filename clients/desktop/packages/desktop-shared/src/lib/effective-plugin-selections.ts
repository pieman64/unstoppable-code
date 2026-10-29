// ---------------------------------------------------------------------------
// Pure set algebra for {@link ChatTabPluginSelections} plus the inherited
// default-plugin layers (CAN-1428 global defaults, REG-3015 project defaults).
//
// Neither the global layer (`PreferencesData.globalPluginSelections`) nor the
// project layer (workspace `defaultPluginSelections`) is copied into chat
// files. Chat-facing resolution computes the effective set at read time:
//
//   inherited = projectDefaults ∪ (global − workspace tombstones)
//   effective = local ∪ (inherited − chat tombstones)
//
// Tombstones ({@link PluginSelectionTombstones}) are a scope's explicit,
// durable rejections of individual inherited defaults. They only suppress
// inherited layers — they never remove a scope's own local selections.
//
// This module is intentionally framework-free (no store/React/Node imports)
// so the Electron main process, the renderer, and tests share one
// implementation. The generic union/subtract helpers here also back the Home
// composer's draft blending (`apps/.../lib/pluginSelectionsBlend.ts`
// re-exports them).
// ---------------------------------------------------------------------------

import { buildTryItCapabilityKey } from '@canopy/protocol/try-it';

import type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
} from '../types';
import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '../types';
import type {
  AccountMcpConnection,
  McpHttpAuthPreference,
} from '../types/mcp-servers';
import { mcpHttpAuthTargetKey } from './mcp-http-auth';
import { normalizePluginSelections } from './plugin-selections-normalization';

/**
 * Single source of truth for which chat surfaces inherit default plugins
 * (the project layer and the global overlay). Worktree and cowork chats do;
 * purpose-built surfaces (App Advisor, plan-explore, code-review, pipeline
 * editor) keep only their explicit selections. Every call site that opts a
 * session, discovery request, terminal, or picker into the inherited layers
 * must use this predicate — hand-rolled exclusion lists drift.
 */
export function chatSurfaceUsesGlobalPluginDefaults(
  projectId: string,
): boolean {
  return (
    projectId !== APP_ADVISOR_PROJECT_ID &&
    projectId !== PLAN_EXPLORE_CHAT_PROJECT_ID &&
    projectId !== CODE_REVIEW_CHAT_PROJECT_ID &&
    projectId !== PIPELINE_EDITOR_PROJECT_ID
  );
}

type SkillRef = ChatTabPluginSelections['skillRefs'][number];
type PluginRef = ChatTabPluginSelections['pluginRefs'][number];
type McpServerRef = NonNullable<
  ChatTabPluginSelections['mcpServerRefs']
>[number];

function unionByKey<T>(
  a: readonly T[],
  b: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of [...a, ...b]) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function subtractByKey<T>(
  a: readonly T[],
  b: readonly T[],
  keyOf: (item: T) => string,
): T[] {
  const removeKeys = new Set(b.map(keyOf));
  return a.filter((item) => !removeKeys.has(keyOf(item)));
}

const collectionIdKey = (id: string): string => id;
const skillRefKey = (ref: SkillRef): string =>
  JSON.stringify([ref.sourceId, ref.skillName]);
const pluginRefKey = (ref: PluginRef): string =>
  JSON.stringify([ref.marketplaceId, ref.pluginName]);
const mcpServerRefKey = (ref: McpServerRef): string =>
  JSON.stringify([ref.serverId, ref.configId]);
const mcpHttpAuthPreferenceKey = (preference: McpHttpAuthPreference): string =>
  mcpHttpAuthTargetKey(preference.target);

function mergeMcpHttpAuthPreferences(
  a: readonly McpHttpAuthPreference[] | undefined,
  b: readonly McpHttpAuthPreference[] | undefined,
): McpHttpAuthPreference[] {
  const indexByKey = new Map<string, number>();
  const result: McpHttpAuthPreference[] = [];
  for (const preference of [...(a ?? []), ...(b ?? [])]) {
    const key = mcpHttpAuthPreferenceKey(preference);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(preference);
    } else {
      result[existingIndex] = preference;
    }
  }
  return result;
}

function subtractMcpHttpAuthPreferences(
  a: readonly McpHttpAuthPreference[] | undefined,
  b: readonly McpHttpAuthPreference[] | undefined,
): McpHttpAuthPreference[] {
  const unchangedDefaultKeys = new Set(
    (b ?? []).map((preference) =>
      JSON.stringify([
        mcpHttpAuthPreferenceKey(preference),
        preference.handler,
      ]),
    ),
  );
  return (a ?? []).filter(
    (preference) =>
      !unchangedDefaultKeys.has(
        JSON.stringify([
          mcpHttpAuthPreferenceKey(preference),
          preference.handler,
        ]),
      ),
  );
}

/**
 * Union of `a` and `b`'s enabled selections, deduplicated by each field's
 * identity (`collectionIds` by id, `skillRefs` by `sourceId`+`skillName`,
 * `pluginRefs` by `marketplaceId`+`pluginName`, `mcpServerRefs` by
 * `serverId`+`configId`). Entries from `a` win ordering ties (appear first);
 * on an `mcpHttpAuthPreferences` key collision `b`'s handler wins.
 */
export function unionPluginSelections(
  a: ChatTabPluginSelections,
  b: ChatTabPluginSelections,
): ChatTabPluginSelections {
  const normalizedA = normalizePluginSelections(a);
  const normalizedB = normalizePluginSelections(b);
  const mcpHttpAuthPreferences = mergeMcpHttpAuthPreferences(
    normalizedA.mcpHttpAuthPreferences,
    normalizedB.mcpHttpAuthPreferences,
  );
  return {
    ...((normalizedA.unresolvedCapabilities?.length ?? 0) ||
    (normalizedB.unresolvedCapabilities?.length ?? 0)
      ? {
          unresolvedCapabilities: unionByKey(
            normalizedA.unresolvedCapabilities ?? [],
            normalizedB.unresolvedCapabilities ?? [],
            (entry) => buildTryItCapabilityKey('', entry),
          ),
        }
      : {}),
    collectionIds: unionByKey(
      normalizedA.collectionIds,
      normalizedB.collectionIds,
      collectionIdKey,
    ),
    skillRefs: unionByKey(
      normalizedA.skillRefs,
      normalizedB.skillRefs,
      skillRefKey,
    ),
    pluginRefs: unionByKey(
      normalizedA.pluginRefs,
      normalizedB.pluginRefs,
      pluginRefKey,
    ),
    mcpServerRefs: unionByKey(
      normalizedA.mcpServerRefs ?? [],
      normalizedB.mcpServerRefs ?? [],
      mcpServerRefKey,
    ),
    ...(mcpHttpAuthPreferences.length > 0 ? { mcpHttpAuthPreferences } : {}),
  };
}

/**
 * Removes every entry of `b` from `a`, matched by the same per-field
 * identities as {@link unionPluginSelections}. An `mcpHttpAuthPreferences`
 * entry is removed only when `b` carries the identical target *and* handler.
 */
export function subtractPluginSelections(
  a: ChatTabPluginSelections,
  b: ChatTabPluginSelections,
): ChatTabPluginSelections {
  const normalizedA = normalizePluginSelections(a);
  const normalizedB = normalizePluginSelections(b);
  const mcpHttpAuthPreferences = subtractMcpHttpAuthPreferences(
    normalizedA.mcpHttpAuthPreferences,
    normalizedB.mcpHttpAuthPreferences,
  );
  return {
    ...((normalizedA.unresolvedCapabilities?.length ?? 0) ||
    (normalizedB.unresolvedCapabilities?.length ?? 0)
      ? {
          unresolvedCapabilities: subtractByKey(
            normalizedA.unresolvedCapabilities ?? [],
            normalizedB.unresolvedCapabilities ?? [],
            (entry) => buildTryItCapabilityKey('', entry),
          ),
        }
      : {}),
    collectionIds: subtractByKey(
      normalizedA.collectionIds,
      normalizedB.collectionIds,
      collectionIdKey,
    ),
    skillRefs: subtractByKey(
      normalizedA.skillRefs,
      normalizedB.skillRefs,
      skillRefKey,
    ),
    pluginRefs: subtractByKey(
      normalizedA.pluginRefs,
      normalizedB.pluginRefs,
      pluginRefKey,
    ),
    mcpServerRefs: subtractByKey(
      normalizedA.mcpServerRefs ?? [],
      normalizedB.mcpServerRefs ?? [],
      mcpServerRefKey,
    ),
    ...(mcpHttpAuthPreferences.length > 0 ? { mcpHttpAuthPreferences } : {}),
  };
}

/**
 * Order-insensitive equality over the four selection identity fields plus
 * auth preferences. Use this instead of `JSON.stringify` comparison so
 * reordered-but-equivalent selection sets are not treated as changes.
 */
export function pluginSelectionsEqual(
  a: ChatTabPluginSelections | undefined,
  b: ChatTabPluginSelections | undefined,
): boolean {
  return canonicalSelectionsKey(a) === canonicalSelectionsKey(b);
}

function canonicalSelectionsKey(
  selections: ChatTabPluginSelections | undefined,
): string {
  if (!selections) return 'null';
  return JSON.stringify({
    unresolvedCapabilities: (selections.unresolvedCapabilities ?? [])
      .map((entry) => buildTryItCapabilityKey('', entry))
      .sort(),
    collectionIds: [...selections.collectionIds].sort(),
    skillRefs: selections.skillRefs.map(skillRefKey).sort(),
    pluginRefs: selections.pluginRefs.map(pluginRefKey).sort(),
    mcpServerRefs: (selections.mcpServerRefs ?? []).map(mcpServerRefKey).sort(),
    mcpHttpAuthPreferences: (selections.mcpHttpAuthPreferences ?? [])
      .map((preference) =>
        JSON.stringify([
          mcpHttpAuthPreferenceKey(preference),
          preference.handler,
        ]),
      )
      .sort(),
  });
}

/** Whether any global default is suppressed by this tombstone set. */
export function hasAnyTombstones(
  tombstones: PluginSelectionTombstones | undefined,
): boolean {
  if (!tombstones) return false;
  return (
    (tombstones.collectionIds?.length ?? 0) > 0 ||
    (tombstones.skillRefs?.length ?? 0) > 0 ||
    (tombstones.pluginRefs?.length ?? 0) > 0 ||
    (tombstones.mcpServerRefs?.length ?? 0) > 0
  );
}

/**
 * Removes tombstoned entries from `selections`. Auth preferences are left
 * untouched — tombstones cannot target them, and a dangling preference for a
 * suppressed server is inert.
 */
export function subtractPluginSelectionTombstones(
  selections: ChatTabPluginSelections,
  tombstones: PluginSelectionTombstones | undefined,
): ChatTabPluginSelections {
  if (!hasAnyTombstones(tombstones)) return selections;
  return {
    ...selections,
    collectionIds: subtractByKey(
      selections.collectionIds,
      tombstones?.collectionIds ?? [],
      collectionIdKey,
    ),
    skillRefs: subtractByKey(
      selections.skillRefs,
      tombstones?.skillRefs ?? [],
      skillRefKey,
    ),
    pluginRefs: subtractByKey(
      selections.pluginRefs,
      tombstones?.pluginRefs ?? [],
      pluginRefKey,
    ),
    mcpServerRefs: subtractByKey(
      selections.mcpServerRefs ?? [],
      tombstones?.mcpServerRefs ?? [],
      mcpServerRefKey,
    ),
  };
}

/**
 * The surviving global overlay for a scope: `global` minus every supplied
 * tombstone layer (typically workspace-level, then chat-level).
 */
export function effectiveGlobalPluginSelections(
  global: ChatTabPluginSelections,
  tombstoneLayers: readonly (PluginSelectionTombstones | undefined)[],
): ChatTabPluginSelections {
  let result = global;
  for (const layer of tombstoneLayers) {
    result = subtractPluginSelectionTombstones(result, layer);
  }
  return result;
}

/**
 * A scope's effective plugin selections under the global overlay:
 * `local ∪ (global − tombstone layers)`. Globally supplied entries order
 * first; the local scope's `mcpHttpAuthPreferences` win on collision.
 */
export function effectivePluginSelections(
  local: ChatTabPluginSelections,
  global: ChatTabPluginSelections | undefined,
  tombstoneLayers: readonly (PluginSelectionTombstones | undefined)[] = [],
): ChatTabPluginSelections {
  if (!global) return local;
  const overlay = effectiveGlobalPluginSelections(global, tombstoneLayers);
  // `b` wins auth-preference collisions in unionPluginSelections, so pass the
  // local scope second to keep its handler overrides authoritative.
  return unionPluginSelections(overlay, local);
}

/**
 * Current {@link PersistedChatTab.inheritedPluginDefaultsVersion}: the chat's
 * `pluginSelections` hold only its own choices, and project defaults are
 * inherited live instead of copied in.
 */
export const INHERITED_PLUGIN_DEFAULTS_VERSION = 1;

/**
 * Whether a chat inherits its project's default plugins as a live layer. A
 * chat written before project defaults became live has no stamp and keeps
 * exactly the selection it had: the project layer adds nothing to it until it
 * is normalized, just before its project's defaults next change, and from
 * then on only defaults added later reach it. A chat that doesn't exist yet,
 * like the Home draft, inherits like a new chat. The global layer never
 * depends on this.
 */
export function chatInheritsProjectDefaults(
  tab: { inheritedPluginDefaultsVersion?: number } | undefined,
): boolean {
  return (
    tab === undefined ||
    (tab.inheritedPluginDefaultsVersion ?? 0) >=
      INHERITED_PLUGIN_DEFAULTS_VERSION
  );
}

/**
 * The project layer `tab` inherits: `projectDefaults`, or nothing for a chat
 * that {@link chatInheritsProjectDefaults} says keeps its own selection.
 */
export function projectDefaultsForChat(
  tab: { inheritedPluginDefaultsVersion?: number } | undefined,
  projectDefaults: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections | undefined {
  return chatInheritsProjectDefaults(tab) ? projectDefaults : undefined;
}

/**
 * The layering stamp for a chat created now on `projectId`: current when the
 * surface inherits project defaults (it stores only its own choices), absent
 * on purpose-built surfaces, which still seed a copy. Every path that creates
 * a chat applies it; a fork or transfer carries its source's value instead.
 */
export function newChatPluginDefaultsStamp(projectId: string): {
  inheritedPluginDefaultsVersion?: number;
} {
  return chatSurfaceUsesGlobalPluginDefaults(projectId)
    ? { inheritedPluginDefaultsVersion: INHERITED_PLUGIN_DEFAULTS_VERSION }
    : {};
}

/** The layers a chat inherits plugin defaults from. */
export interface InheritedPluginLayers {
  /** The chat's workspace `defaultPluginSelections`. */
  projectDefaults?: ChatTabPluginSelections;
  /** `PreferencesData.globalPluginSelections`, when the surface opts in. */
  global?: ChatTabPluginSelections;
  /** The workspace's rejections of global defaults. */
  projectTombstones?: PluginSelectionTombstones;
}

/**
 * Everything a chat inherits before its own tombstones apply:
 * `projectDefaults ∪ (global − projectTombstones)`. `undefined` when neither
 * layer exists. On an auth-preference collision the project layer wins over
 * the global one.
 */
export function inheritedPluginSelections(
  layers: InheritedPluginLayers,
): ChatTabPluginSelections | undefined {
  const { projectDefaults, global, projectTombstones } = layers;
  if (!projectDefaults && !global) return undefined;
  const empty: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
  return unionPluginSelections(
    global
      ? effectiveGlobalPluginSelections(global, [projectTombstones])
      : empty,
    projectDefaults ?? empty,
  );
}

/**
 * A chat's effective selections:
 * `local ∪ ((projectDefaults ∪ (global − projectTombstones)) − chatTombstones)`.
 * Inherited entries order first; the chat's own `mcpHttpAuthPreferences` win
 * on collision.
 */
export function effectiveChatPluginSelections(
  input: InheritedPluginLayers & {
    local: ChatTabPluginSelections | undefined;
    chatTombstones?: PluginSelectionTombstones;
  },
): ChatTabPluginSelections {
  const local = normalizePluginSelections(input.local);
  return effectivePluginSelections(local, inheritedPluginSelections(input), [
    input.chatTombstones,
  ]);
}

/**
 * Splits the set a chat picker saved against the chat's inherited layers:
 * unchecked inherited entries become chat tombstones, checked non-inherited
 * entries become local selections, and entries the chat already owned locally
 * stay local (so a later default removal cannot revoke them). Previous
 * tombstones for entries that are not inherited right now are kept unless
 * the user chose the entry, so turning a default off survives the default
 * being removed and added again.
 */
export function splitChosenChatPluginSelections(
  input: InheritedPluginLayers & {
    chosen: ChatTabPluginSelections;
    previousLocal?: ChatTabPluginSelections;
    previousTombstones?: PluginSelectionTombstones;
  },
): {
  localSelections: ChatTabPluginSelections;
  tombstones: PluginSelectionTombstones;
} {
  const inherited = inheritedPluginSelections(input);
  const split = splitChosenSelectionsAgainstGlobal(
    input.chosen,
    inherited,
    [],
    input.previousLocal,
  );
  if (!hasAnyTombstones(input.previousTombstones)) return split;
  const empty: ChatTabPluginSelections = {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
  const retained = subtractPluginSelections(
    subtractPluginSelections(
      { ...empty, ...input.previousTombstones },
      inherited ?? empty,
    ),
    input.chosen,
  );
  const merged = unionPluginSelections(
    { ...empty, ...split.tombstones },
    retained,
  );
  return {
    localSelections: split.localSelections,
    tombstones:
      normalizePluginSelectionTombstones({
        collectionIds: merged.collectionIds,
        skillRefs: merged.skillRefs,
        pluginRefs: merged.pluginRefs,
        mcpServerRefs: merged.mcpServerRefs,
      }) ?? {},
  };
}

/**
 * Derives the persisted state for a scope from the *effective* set a picker
 * displayed and the user's chosen set: local selections are everything chosen
 * beyond the surviving inherited overlay (`global` may be any inherited
 * layer, see {@link inheritedPluginSelections}), and tombstones record every
 * overlay entry the user unchecked. Auth preferences persist locally as
 * chosen.
 */
export function splitChosenSelectionsAgainstGlobal(
  chosen: ChatTabPluginSelections,
  global: ChatTabPluginSelections | undefined,
  parentTombstoneLayers: readonly (
    | PluginSelectionTombstones
    | undefined
  )[] = [],
  previousLocalSelections?: ChatTabPluginSelections,
): {
  localSelections: ChatTabPluginSelections;
  tombstones: PluginSelectionTombstones;
} {
  if (!global) {
    return { localSelections: chosen, tombstones: {} };
  }
  const overlay = effectiveGlobalPluginSelections(
    global,
    parentTombstoneLayers,
  );
  // Only overlay entries the scope did not already own locally are absorbed
  // into the overlay. A previously-local selection that also happens to be a
  // global default stays in the scope's own selections, so a later global
  // removal cannot silently revoke it ("removing a global default withdraws
  // it everywhere unless a scope selected it locally").
  const overlayOnly = previousLocalSelections
    ? subtractPluginSelections(overlay, previousLocalSelections)
    : overlay;
  const localSelections: ChatTabPluginSelections = {
    ...subtractPluginSelectionTombstones(chosen, {
      collectionIds: overlayOnly.collectionIds,
      skillRefs: overlayOnly.skillRefs,
      pluginRefs: overlayOnly.pluginRefs,
      mcpServerRefs: overlayOnly.mcpServerRefs,
    }),
    ...(chosen.mcpHttpAuthPreferences !== undefined
      ? { mcpHttpAuthPreferences: chosen.mcpHttpAuthPreferences }
      : {}),
  };
  const rejected = subtractPluginSelections(overlay, chosen);
  const tombstones: PluginSelectionTombstones = {};
  if (rejected.collectionIds.length > 0) {
    tombstones.collectionIds = rejected.collectionIds;
  }
  if (rejected.skillRefs.length > 0) {
    tombstones.skillRefs = rejected.skillRefs;
  }
  if (rejected.pluginRefs.length > 0) {
    tombstones.pluginRefs = rejected.pluginRefs;
  }
  if ((rejected.mcpServerRefs?.length ?? 0) > 0) {
    tombstones.mcpServerRefs = rejected.mcpServerRefs;
  }
  return { localSelections, tombstones };
}

/**
 * Normalizes an untrusted/persisted tombstone blob: drops malformed entries,
 * trims and de-duplicates, and omits empty arrays. Returns `undefined` when
 * nothing survives so persisted files stay compact.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizePluginSelectionTombstones(
  input: unknown,
): PluginSelectionTombstones | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const source = input;
  const result: PluginSelectionTombstones = {};
  const collectionIds = normalizeStringArray(source.collectionIds);
  if (collectionIds.length > 0) result.collectionIds = collectionIds;
  const skillRefs = normalizeRefArray(
    source.skillRefs,
    'sourceId',
    'skillName',
  ).map(([sourceId, skillName]) => ({ sourceId, skillName }));
  if (skillRefs.length > 0) result.skillRefs = skillRefs;
  const pluginRefs = normalizeRefArray(
    source.pluginRefs,
    'marketplaceId',
    'pluginName',
  ).map(([marketplaceId, pluginName]) => ({ marketplaceId, pluginName }));
  if (pluginRefs.length > 0) result.pluginRefs = pluginRefs;
  const mcpServerRefs = normalizeRefArray(
    source.mcpServerRefs,
    'serverId',
    'configId',
  ).map(([serverId, configId]) => ({ serverId, configId }));
  if (mcpServerRefs.length > 0) result.mcpServerRefs = mcpServerRefs;
  return hasAnyTombstones(result) ? result : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeRefArray(
  value: unknown,
  firstField: string,
  secondField: string,
): [string, string][] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: [string, string][] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const firstRaw = entry[firstField];
    const secondRaw = entry[secondField];
    const first = typeof firstRaw === 'string' ? firstRaw.trim() : '';
    const second = typeof secondRaw === 'string' ? secondRaw.trim() : '';
    if (!first || !second) continue;
    const key = `${first}\0${second}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push([first, second]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Account MCP selection refs
//
// Account servers are selected as `{ serverId: serverKey, configId }`: the
// curated catalog key or `custom:<uuid>`, the same shape cloud sessions,
// workspace templates, and delegated agents use. Earlier desktop builds wrote
// `account:<connectionId>`; those refs are mapped on read, never migrated.
// ---------------------------------------------------------------------------

const LEGACY_ACCOUNT_MCP_REF_PREFIX = 'account:';

type AccountMcpRefConnection = Pick<
  AccountMcpConnection,
  'id' | 'serverKey' | 'configId' | 'kind'
>;

/** The connection id of a legacy `account:<connectionId>` ref. */
export function legacyAccountMcpConnectionId(
  serverId: string,
): string | undefined {
  return serverId.startsWith(LEGACY_ACCOUNT_MCP_REF_PREFIX)
    ? serverId.slice(LEGACY_ACCOUNT_MCP_REF_PREFIX.length)
    : undefined;
}

/** Custom account servers are keyed `custom:<uuid>`; no device id has that shape. */
export function isCustomAccountMcpServerKey(serverId: string): boolean {
  return serverId.startsWith('custom:');
}

export function accountMcpConnectionForRef<T extends AccountMcpRefConnection>(
  ref: McpServerRef,
  connections: readonly T[],
): T | undefined {
  const legacyId = legacyAccountMcpConnectionId(ref.serverId);
  if (legacyId !== undefined)
    return connections.find(
      (connection) =>
        connection.id === legacyId && connection.configId === ref.configId,
    );
  const kind = isCustomAccountMcpServerKey(ref.serverId) ? 'CUSTOM' : 'CURATED';
  return connections.find(
    (connection) =>
      connection.kind === kind &&
      connection.serverKey === ref.serverId &&
      connection.configId === ref.configId,
  );
}

/** How a caller names the account connection it wants. */
export interface AccountMcpConnectionMatchTarget {
  curatedKey?: string;
  accountConnectionId?: string;
  configId?: string;
}

/**
 * The one connection a target names, or `undefined` when none or several do.
 * An explicit connection id is authoritative. A curated key matches only
 * curated connections with that server key: the exact config first, else a
 * single candidate; two candidates without an exact config fail closed.
 * Names and URLs never match, so an unrelated server can never be bound.
 */
export function matchAccountMcpConnection<T extends AccountMcpRefConnection>(
  rows: readonly T[],
  target: AccountMcpConnectionMatchTarget,
): T | undefined {
  if (target.accountConnectionId)
    return rows.find((row): boolean => row.id === target.accountConnectionId);
  if (!target.curatedKey) return undefined;
  const matches = rows.filter(
    (row): boolean =>
      row.kind === 'CURATED' && row.serverKey === target.curatedKey,
  );
  const exact = matches.find(
    (row): boolean => row.configId === target.configId,
  );
  return exact ?? (matches.length === 1 ? matches[0] : undefined);
}

export function hasLegacyAccountMcpRefs(
  selections: Pick<PluginSelectionTombstones, 'mcpServerRefs'> | undefined,
): boolean {
  return (selections?.mcpServerRefs ?? []).some(
    (ref) => legacyAccountMcpConnectionId(ref.serverId) !== undefined,
  );
}

function normalizeAccountMcpRefs(
  refs: readonly McpServerRef[],
  connections: readonly AccountMcpRefConnection[],
): { refs: McpServerRef[]; dropped: McpServerRef[] } {
  const dropped: McpServerRef[] = [];
  const mapped: McpServerRef[] = [];
  for (const ref of refs) {
    if (legacyAccountMcpConnectionId(ref.serverId) === undefined) {
      mapped.push(ref);
      continue;
    }
    const connection = accountMcpConnectionForRef(ref, connections);
    if (connection)
      mapped.push({
        serverId: connection.serverKey,
        configId: connection.configId,
      });
    else dropped.push(ref);
  }
  return { refs: unionByKey(mapped, [], mcpServerRefKey), dropped };
}

/**
 * Maps legacy `account:<connectionId>` refs to `{ serverId: serverKey,
 * configId }` using the account's connection list. Refs whose connection is
 * gone are removed and returned as `dropped` for the caller's warning path.
 */
export function normalizeAccountMcpSelectionRefs<
  T extends ChatTabPluginSelections,
>(
  selections: T,
  connections: readonly AccountMcpRefConnection[],
): { selections: T; dropped: McpServerRef[] } {
  if (!hasLegacyAccountMcpRefs(selections)) return { selections, dropped: [] };
  const { refs, dropped } = normalizeAccountMcpRefs(
    selections.mcpServerRefs ?? [],
    connections,
  );
  return { selections: { ...selections, mcpServerRefs: refs }, dropped };
}

export function normalizeAccountMcpTombstoneRefs(
  tombstones: PluginSelectionTombstones | undefined,
  connections: readonly AccountMcpRefConnection[],
): PluginSelectionTombstones | undefined {
  if (!tombstones || !hasLegacyAccountMcpRefs(tombstones)) return tombstones;
  const { refs } = normalizeAccountMcpRefs(
    tombstones.mcpServerRefs ?? [],
    connections,
  );
  const result: PluginSelectionTombstones = { ...tombstones };
  if (refs.length > 0) result.mcpServerRefs = refs;
  else delete result.mcpServerRefs;
  return result;
}
