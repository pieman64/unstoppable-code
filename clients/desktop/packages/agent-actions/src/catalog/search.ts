import { clampLimit } from './limit';
import type { AgentActionCatalogEntry, AgentActionField } from './types';

export interface AgentActionSearchInput {
  query?: string;
  category?: string;
  actionType?: string;
  limit?: number;
  featureFlags?: Record<string, boolean | undefined>;
  /**
   * Restrict the searchable catalog to these action types. Applied before
   * ranking and the result limit, so a narrow surface always sees its own
   * matches.
   */
  allowedActionTypes?: readonly string[];
}

export type AgentActionSearchResultAction<
  TEntry extends AgentActionCatalogEntry = AgentActionCatalogEntry,
  TExtras extends object = Record<never, never>,
> = {
  type: TEntry['type'];
  category: string;
  summary: string;
  fields: readonly AgentActionField[];
  /** Scoped chat catalogs omit target fields supplied by the trusted runtime. */
  example: object;
  additionalExamples?: readonly object[];
  notes?: readonly string[];
  requiredFeatureFlag?: string;
  requiredFeatureFlags?: readonly string[];
  requiredFields: string[];
  optionalFields: string[];
} & Partial<TExtras>;

export interface AgentActionSearchResult<
  TAction extends AgentActionSearchResultAction = AgentActionSearchResultAction,
> {
  query: string;
  category?: string;
  actionType?: string;
  totalMatches: number;
  returned: number;
  categories: string[];
  actions: TAction[];
}

/**
 * Host-specific ranking inputs layered onto the generic catalog search:
 * extra haystack terms an entry matches on, and extra result fields derived
 * from the query.
 */
export interface AgentActionRankExtras<
  TEntry extends AgentActionCatalogEntry,
  TExtras extends object,
> {
  haystackTerms: (entry: TEntry) => readonly string[];
  resultExtras: (entry: TEntry, query: string) => Partial<TExtras>;
}

export function searchAgentActionCatalog<
  TEntry extends AgentActionCatalogEntry,
  TExtras extends object = Record<never, never>,
>(
  catalog: readonly TEntry[],
  input: AgentActionSearchInput = {},
  rankExtras?: AgentActionRankExtras<TEntry, TExtras>,
): AgentActionSearchResult<AgentActionSearchResultAction<TEntry, TExtras>> {
  const query = (input.query ?? '').trim();
  const category = input.category?.trim();
  const actionType = input.actionType?.trim();
  const limit = clampLimit(input.limit, 12, 50);
  const tokens = tokenize([query, actionType].filter(Boolean).join(' '));
  const normalizedCategory = category
    ? normalizeActionCategory(category)
    : null;
  const normalizedActionType = actionType ? normalize(actionType) : null;

  const allowedTypes = input.allowedActionTypes
    ? new Set<string>(input.allowedActionTypes)
    : null;
  const scored = catalog
    .filter((entry) => {
      if (allowedTypes && !allowedTypes.has(entry.type)) return false;
      const requiredFlags =
        entry.requiredFeatureFlags ??
        (entry.requiredFeatureFlag ? [entry.requiredFeatureFlag] : []);
      return requiredFlags.every(
        (requiredFlag) => input.featureFlags?.[requiredFlag] !== false,
      );
    })
    .map((entry, index) => ({
      entry,
      index,
      score: scoreEntry(
        entry,
        rankExtras?.haystackTerms(entry) ?? [],
        tokens,
        normalizedCategory,
        normalizedActionType,
      ),
    }))
    .filter(({ score }) => score > 0);

  const matches = scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ entry }) => entry);
  const selected = matches.slice(0, limit);

  return {
    query,
    ...(category ? { category } : {}),
    ...(actionType ? { actionType } : {}),
    totalMatches: matches.length,
    returned: selected.length,
    categories: Array.from(new Set(catalog.map((entry) => entry.category))),
    actions: selected.map((entry) =>
      toSearchResultAction(entry, query, rankExtras),
    ),
  };
}

/**
 * The generic search score of one catalog entry for a search input, without
 * host rank extras; 0 means the entry does not match. Lets a surface rank
 * the results of several families against each other.
 */
export function scoreAgentActionCatalogEntry(
  entry: AgentActionCatalogEntry,
  input: AgentActionSearchInput = {},
): number {
  const category = input.category?.trim();
  const actionType = input.actionType?.trim();
  return scoreEntry(
    entry,
    [],
    tokenize(
      [(input.query ?? '').trim(), actionType].filter(Boolean).join(' '),
    ),
    category ? normalizeActionCategory(category) : null,
    actionType ? normalize(actionType) : null,
  );
}

function toSearchResultAction<
  TEntry extends AgentActionCatalogEntry,
  TExtras extends object,
>(
  entry: TEntry,
  query: string,
  rankExtras: AgentActionRankExtras<TEntry, TExtras> | undefined,
): AgentActionSearchResultAction<TEntry, TExtras> {
  const extras: Partial<TExtras> = rankExtras
    ? rankExtras.resultExtras(entry, query)
    : {};
  return {
    type: entry.type,
    category: entry.category,
    summary: entry.summary,
    fields: entry.fields,
    example: entry.example,
    ...(entry.additionalExamples
      ? { additionalExamples: entry.additionalExamples }
      : {}),
    ...extras,
    ...(entry.notes ? { notes: entry.notes } : {}),
    ...(entry.requiredFeatureFlag
      ? { requiredFeatureFlag: entry.requiredFeatureFlag }
      : {}),
    ...(entry.requiredFeatureFlags
      ? { requiredFeatureFlags: entry.requiredFeatureFlags }
      : {}),
    requiredFields: entry.fields
      .filter((fieldEntry) => fieldEntry.required)
      .map((fieldEntry) => fieldEntry.name),
    optionalFields: entry.fields
      .filter((fieldEntry) => !fieldEntry.required)
      .map((fieldEntry) => fieldEntry.name),
  };
}

function scoreEntry(
  entry: AgentActionCatalogEntry,
  extraHaystackTerms: readonly string[],
  tokens: string[],
  normalizedCategory: string | null,
  normalizedActionType: string | null,
): number {
  let score = 0;
  const haystack = normalize(
    [
      entry.type,
      entry.category,
      entry.summary,
      ...entry.keywords,
      ...extraHaystackTerms,
      ...entry.fields.map((fieldEntry) => fieldEntry.name),
      ...entry.fields.map((fieldEntry) => fieldEntry.description),
    ].join(' '),
  );
  const normalizedType = normalize(entry.type);
  const actionTypeExact = normalizedActionType
    ? normalizedType === normalizedActionType
    : false;

  if (normalizedActionType) {
    if (actionTypeExact) score += 1000;
    else if (normalizedType.includes(normalizedActionType)) score += 80;
    else return 0;
  }

  if (normalizedCategory) {
    if (normalizeActionCategory(entry.category) === normalizedCategory)
      score += 100;
    else if (actionTypeExact) score -= 10;
    else return 0;
  }

  const queryTokens = normalizedCategory
    ? tokens.filter((token) => token !== normalizedCategory)
    : tokens;
  let matchingTokens = 0;
  for (const token of queryTokens) {
    if (normalizedType === token) {
      score += 120;
      matchingTokens += 1;
    } else if (
      token.length > 2
        ? normalizedType.startsWith(token) ||
          normalizedType.includes(` ${token}`)
        : normalizedType.split(' ').includes(token)
    ) {
      // Partial action-name matches start at a segment, so "view" does not
      // give preview/review actions priority over an explicit view keyword.
      // Short words such as "me" must not boost unrelated types like memory
      // or resume. Explicit abbreviations such as "pr" still match type words.
      score += 40;
      matchingTokens += 1;
    } else if (haystack.includes(token)) {
      score += 10;
      matchingTokens += 1;
    } else score -= 1;
  }

  if (queryTokens.length > 0 && matchingTokens === 0 && !actionTypeExact) {
    return 0;
  }
  // An action that covers every word of a longer request ("open the app when
  // I sign in") outranks actions that only share its first verb with their
  // type name, however many of those the catalog holds.
  if (queryTokens.length > 2 && matchingTokens === queryTokens.length) {
    score += 20;
  }

  if (queryTokens.length > 0 && score <= 0) return 0;
  return score + 1;
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_./-]+/g, ' ');
}

function normalizeActionCategory(value: string): string {
  const normalized = normalize(value);
  switch (normalized) {
    case 'automation':
      return 'automations';
    case 'watcher':
      return 'watchers';
    case 'panels':
      return 'panel';
    case 'skill':
      return 'skills';
    case 'plugin':
      return 'plugins';
    case 'collection':
      return 'collections';
    case 'delegations':
      return 'delegation';
    case 'workspace':
      return 'workspace';
    case 'worktree':
      return 'worktree';
    case 'worktree chat':
      return 'worktree chat';
    case 'standalone chat':
      return 'standalone chat';
    default:
      return normalized;
  }
}
