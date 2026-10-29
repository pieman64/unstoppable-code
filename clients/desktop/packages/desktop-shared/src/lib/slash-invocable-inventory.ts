// Pure merge rules for the composer `/` and `$` menu: which invocable
// inventory rows are promoted beside agent discovery, which stay "Available
// to enable", and how enabling one extends a chat's selections. Shared by the
// desktop renderer and the main-process Portal inventory so both surfaces list
// the same rows.
import {
  getProviderForModel,
  type AgentProviderType,
  type ChatModel,
  type ChatTabPluginSelections,
  type ModelHarness,
  type InvocableInventoryEnableRef,
  type InvocableInventoryEntry,
  type SlashCommandData,
  type WorktreeDiscovery,
} from '../types';
import type { CollectionConfig } from '../types/collections';

/**
 * A slash-menu row built from an invocable-inventory entry. It is a
 * `SlashCommandData` (so it carries the typed `inventoryEntry`) plus the
 * boundary-safe `data` slot consumed by `@canopy/ui-rich`, into which the
 * concrete entry is also written so it survives the ui-rich layer.
 */
export type SlashInventoryCommand = SlashCommandData & {
  /** Opaque passthrough for the ui-rich layer (the concrete entry). */
  data?: unknown;
  /** Muted trailing source label rendered by the menu. */
  category?: string;
};

/** Skill/plugin refs contributed by the tab's selected Collections. */
export interface CollectionEnabledRefs {
  skillRefs: { sourceId: string; skillName: string }[];
  pluginRefs: { marketplaceId: string; pluginName: string }[];
}

export interface BuildSlashInventoryCommandsParams {
  /** Cached inventory rows for the effective provider. */
  entries: InvocableInventoryEntry[];
  /** Agent-discovered rows (canonical; they win on collision). */
  discoveredCommands: SlashCommandData[];
  /** The tab's active plugin selections (direct refs). */
  selections: ChatTabPluginSelections | undefined;
  /** Expanded refs from the tab's selected Collections, if available. */
  collectionRefs?: CollectionEnabledRefs;
  /**
   * True while agent discovery is still running. While discovering, available
   * inventory rows are withheld so they never appear before discovery finishes.
   */
  isDiscovering: boolean;
}

export interface SlashInventoryCommandLists {
  /** Agent-discovered rows, unchanged. Used by the Commands popup. */
  discoveredCommands: SlashCommandData[];
  /** Enabled inventory-backed fallback rows. Used only by inline typeahead. */
  promotedInventoryCommands: SlashInventoryCommand[];
  /** Filtered, de-duped "available to enable" rows. */
  availableInventoryCommands: SlashInventoryCommand[];
}

function skillRefKey(ref: { sourceId: string; skillName: string }): string {
  return `${ref.sourceId}/${ref.skillName}`;
}

function pluginRefKey(ref: {
  marketplaceId: string;
  pluginName: string;
}): string {
  return `${ref.marketplaceId}/${ref.pluginName}`;
}

function isEntryEnabled(
  entry: InvocableInventoryEntry,
  enabledSkillKeys: ReadonlySet<string>,
  enabledPluginKeys: ReadonlySet<string>,
): boolean {
  const ref = entry.enableRef;
  // Nothing to enable: an inherited Cursor row is always on.
  if (ref.kind === 'none') return true;
  if (ref.kind === 'skill') {
    return enabledSkillKeys.has(skillRefKey(ref));
  }
  return enabledPluginKeys.has(pluginRefKey(ref));
}

function entrySortKey(entry: InvocableInventoryEntry): string {
  const ref = entry.enableRef;
  const refKey =
    ref.kind === 'none'
      ? `inherited:${entry.sourceLabel ?? ''}`
      : ref.kind === 'plugin'
        ? `plugin:${ref.marketplaceId}/${ref.pluginName}`
        : `skill:${ref.sourceId}/${ref.skillName}`;
  return `${refKey}::${entry.name}::${entry.invocationKey}`;
}

function toInventoryCommand(
  entry: InvocableInventoryEntry,
  section: 'discovered' | 'available',
): SlashInventoryCommand {
  const command: SlashInventoryCommand = {
    name: entry.name,
    description: entry.description,
    displayName: entry.displayName,
    insertText: entry.insertText,
    section,
    inventoryEntry: entry,
    data: entry,
  };
  if (entry.sourceLabel) {
    command.category = entry.sourceLabel;
  }
  return command;
}

function normalizedCommandToken(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^[/\$]/, '').toLowerCase();
}

function normalizedSyntheticSelectedSkillToken(
  value: string | undefined,
): string | null {
  const token = normalizedCommandToken(value);
  if (!token) return null;
  const separator = token.indexOf(':');
  if (separator <= 0) return null;
  const namespace = token.slice(0, separator);
  if (!namespace.endsWith('-chat-skills')) return null;
  return token.slice(separator + 1) || null;
}

/**
 * Merge cached inventory entries with the agent-discovered slash commands into
 * the two row lists the menu needs.
 *
 * Rules (see the frontend plan):
 * - While `isDiscovering`, no available rows are emitted (wait for discovery).
 * - Entries whose `enableRef` is already enabled — directly or via a selected
 *   Collection — are promoted into discovered rows as a fallback when agent
 *   discovery has not already reported the same command.
 * - Agent-discovered rows are canonical: an entry colliding with a discovered
 *   row (by name or insert text) is hidden.
 * - Remaining entries are de-duped by `invocationKey`, `name`, and `insertText`
 *   after a stable marketplace/plugin/name sort.
 */
export function buildSlashInventoryCommands(
  params: BuildSlashInventoryCommandsParams,
): SlashInventoryCommandLists {
  const {
    entries,
    discoveredCommands,
    selections,
    collectionRefs,
    isDiscovering,
  } = params;

  if (isDiscovering) {
    return {
      discoveredCommands,
      promotedInventoryCommands: [],
      availableInventoryCommands: [],
    };
  }

  const enabledSkillKeys = new Set<string>();
  const enabledPluginKeys = new Set<string>();
  for (const ref of selections?.skillRefs ?? []) {
    enabledSkillKeys.add(skillRefKey(ref));
  }
  for (const ref of selections?.pluginRefs ?? []) {
    enabledPluginKeys.add(pluginRefKey(ref));
  }
  for (const ref of collectionRefs?.skillRefs ?? []) {
    enabledSkillKeys.add(skillRefKey(ref));
  }
  for (const ref of collectionRefs?.pluginRefs ?? []) {
    enabledPluginKeys.add(pluginRefKey(ref));
  }

  const discoveredKeys = new Set<string>();
  for (const cmd of discoveredCommands) {
    for (const key of [
      normalizedCommandToken(cmd.name),
      normalizedCommandToken(cmd.displayName),
      normalizedCommandToken(cmd.insertText),
      // Claude exposes directly selected skills through a brand-specific
      // synthetic plugin namespace (`<brand>-chat-skills:<skill>`), while the
      // inventory intentionally offers the disabled row as the shorter
      // `/<skill>`. Treat the reserved projection's suffix as the same
      // invocation once discovery reports it.
      normalizedSyntheticSelectedSkillToken(cmd.name),
      normalizedSyntheticSelectedSkillToken(cmd.displayName),
      normalizedSyntheticSelectedSkillToken(cmd.insertText),
    ]) {
      if (key) {
        discoveredKeys.add(key);
      }
    }
  }

  // Canopy rows first, inherited rows after them: the chat root gives a
  // selected skill the base id on a name clash and the inherited copy the
  // suffix, so the pick must claim the name in this menu first too.
  const inheritedRank = (entry: InvocableInventoryEntry): number =>
    entry.enableRef.kind === 'none' ? 1 : 0;
  const sorted = [...entries].sort(
    (a, b) =>
      inheritedRank(a) - inheritedRank(b) ||
      entrySortKey(a).localeCompare(entrySortKey(b)),
  );

  const seenInvocationKeys = new Set<string>();
  const seenNames = new Set<string>();
  const seenInserts = new Set<string>();
  const promotedInventoryCommands: SlashInventoryCommand[] = [];
  const availableInventoryCommands: SlashInventoryCommand[] = [];

  for (const entry of sorted) {
    if (!isEntryEnabled(entry, enabledSkillKeys, enabledPluginKeys)) {
      continue;
    }
    const entryKeys = [
      normalizedCommandToken(entry.name),
      normalizedCommandToken(entry.displayName),
      normalizedCommandToken(entry.insertText),
      normalizedCommandToken(entry.invocationKey),
    ].filter((key): key is string => key !== null);

    // An inherited row keeps its own identity: its bare name may repeat a
    // Canopy row's or another inherited row's (`/review` beside `/review-1`,
    // two plugins shipping `brainstorming`), so only what it inserts can be
    // claimed already. A Canopy row yields on any key, as before.
    const claimKeys =
      entry.enableRef.kind === 'none'
        ? [
            normalizedCommandToken(entry.insertText),
            normalizedCommandToken(entry.invocationKey),
          ].filter((key): key is string => key !== null)
        : entryKeys;

    // Agent-discovered rows, and rows promoted before this one, win on
    // collision.
    if (claimKeys.some((key) => discoveredKeys.has(key))) {
      continue;
    }

    // The entry is already enabled. Treat this inventory-backed fallback like
    // any other discovered row so selecting it inserts immediately and never
    // mislabels it under "Available to enable" when the provider reports a
    // differently-prefixed form of the same command.
    promotedInventoryCommands.push(toInventoryCommand(entry, 'discovered'));
    for (const key of claimKeys) {
      discoveredKeys.add(key);
    }
  }

  for (const entry of sorted) {
    if (isEntryEnabled(entry, enabledSkillKeys, enabledPluginKeys)) {
      continue;
    }
    const entryKeys = [
      normalizedCommandToken(entry.name),
      normalizedCommandToken(entry.displayName),
      normalizedCommandToken(entry.insertText),
      normalizedCommandToken(entry.invocationKey),
    ].filter((key): key is string => key !== null);

    // Agent-discovered and promoted enabled rows win on collision.
    if (entryKeys.some((key) => discoveredKeys.has(key))) {
      continue;
    }

    // De-dupe across remaining available rows (e.g. two disabled plugins that
    // expose the same Claude command name resolve to the same insertion).
    if (
      seenInvocationKeys.has(entry.invocationKey) ||
      seenNames.has(entry.name.toLowerCase()) ||
      seenInserts.has(entry.insertText.trim())
    ) {
      continue;
    }
    seenInvocationKeys.add(entry.invocationKey);
    seenNames.add(entry.name.toLowerCase());
    seenInserts.add(entry.insertText.trim());

    availableInventoryCommands.push(toInventoryCommand(entry, 'available'));
  }

  return {
    discoveredCommands,
    promotedInventoryCommands,
    availableInventoryCommands,
  };
}

/**
 * Flatten loaded Collection configs into the skill/plugin refs they enable.
 * Used to exclude inventory rows that are already enabled via a selected
 * Collection. Null configs (failed loads) are skipped.
 */
export function flattenCollectionRefs(
  configs: ReadonlyArray<CollectionConfig | null | undefined>,
): CollectionEnabledRefs {
  const skillRefs: { sourceId: string; skillName: string }[] = [];
  const pluginRefs: { marketplaceId: string; pluginName: string }[] = [];
  for (const config of configs) {
    if (!config) continue;
    for (const skill of config.skills) {
      skillRefs.push({ sourceId: skill.sourceId, skillName: skill.skillName });
    }
    for (const plugin of config.plugins) {
      pluginRefs.push({
        marketplaceId: plugin.marketplaceId,
        pluginName: plugin.pluginName,
      });
    }
  }
  return { skillRefs, pluginRefs };
}

function cloneSelections(
  selections: ChatTabPluginSelections,
): ChatTabPluginSelections {
  return {
    collectionIds: [...(selections.collectionIds ?? [])],
    skillRefs: [...(selections.skillRefs ?? [])],
    pluginRefs: [...(selections.pluginRefs ?? [])],
    ...(selections.mcpServerRefs
      ? { mcpServerRefs: [...selections.mcpServerRefs] }
      : {}),
    ...(selections.mcpHttpAuthPreferences
      ? { mcpHttpAuthPreferences: [...selections.mcpHttpAuthPreferences] }
      : {}),
  };
}

/**
 * Merge an inventory `enableRef` into a clone of the current selections using
 * exactly the ref shapes the plugin picker writes (the `kind` discriminator is
 * dropped). The candidate is appended last; an already-present equal ref is
 * left untouched.
 */
export function appendEnableRef(
  selections: ChatTabPluginSelections,
  enableRef: InvocableInventoryEnableRef,
): ChatTabPluginSelections {
  const next = cloneSelections(selections);
  // An inherited row has nothing to enable; the copy is returned unchanged.
  if (enableRef.kind === 'none') return next;
  if (enableRef.kind === 'skill') {
    const exists = next.skillRefs.some(
      (ref) =>
        ref.sourceId === enableRef.sourceId &&
        ref.skillName === enableRef.skillName,
    );
    if (!exists) {
      next.skillRefs = [
        ...next.skillRefs,
        { sourceId: enableRef.sourceId, skillName: enableRef.skillName },
      ];
    }
  } else {
    const exists = next.pluginRefs.some(
      (ref) =>
        ref.marketplaceId === enableRef.marketplaceId &&
        ref.pluginName === enableRef.pluginName,
    );
    if (!exists) {
      next.pluginRefs = [
        ...next.pluginRefs,
        {
          marketplaceId: enableRef.marketplaceId,
          pluginName: enableRef.pluginName,
        },
      ];
    }
  }
  return next;
}

/**
 * Whether choosing this composer row must go through `runInventorySelection`
 * (validate-and-resolve against the current selection) rather than inserting
 * its cached text. "Available to enable" rows always do. So does an inherited
 * Cursor row (`enableRef.kind === 'none'`): it is promoted like an enabled
 * row, but its cached id was assigned over the inherited set alone, and only
 * the resolver knows the id the chat root gives it next to the selection (a
 * selected skill of the same name keeps the base id). Agent-discovered rows
 * and promoted enabled rows insert as cached.
 */
export function inventoryRowNeedsResolution(
  command: Pick<SlashCommandData, 'section' | 'inventoryEntry'>,
): boolean {
  if (command.section === 'available') return true;
  return command.inventoryEntry?.enableRef.kind === 'none';
}

/**
 * The provider key discovery runs under for a chat. Ollama on Claude keeps its
 * local endpoint even though its execution harness is Claude.
 */
export function resolveDiscoveryProviderType(tab?: {
  providerType?: AgentProviderType;
  model?: ChatModel;
  executionHarness?: ModelHarness;
}): AgentProviderType | undefined {
  if (
    tab?.executionHarness === 'codex' ||
    (tab?.executionHarness === 'claude' && tab.providerType !== 'ollama')
  ) {
    return tab.executionHarness;
  }

  if (tab?.providerType) {
    return tab.providerType;
  }

  return tab?.model ? getProviderForModel(tab.model) : undefined;
}

function matchesDiscoveryProvider(
  discovery: WorktreeDiscovery | undefined,
  providerType: AgentProviderType | undefined,
): boolean {
  if (!discovery) {
    return false;
  }

  if (!providerType) {
    return true;
  }

  const effectiveDiscoveryProvider = discovery.providerType ?? 'claude';
  return effectiveDiscoveryProvider === providerType;
}

export function selectDiscoverySlashCommands(options: {
  providerType?: AgentProviderType;
  tabDiscovery?: WorktreeDiscovery;
  worktreeDiscovery?: WorktreeDiscovery;
}): SlashCommandData[] {
  if (matchesDiscoveryProvider(options.tabDiscovery, options.providerType)) {
    return options.tabDiscovery?.slashCommands ?? [];
  }

  if (
    matchesDiscoveryProvider(options.worktreeDiscovery, options.providerType)
  ) {
    return options.worktreeDiscovery?.slashCommands ?? [];
  }

  return [];
}
