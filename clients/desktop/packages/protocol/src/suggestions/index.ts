/** Suggestion categories in arbitration priority order. */
export const SUGGESTION_IDS = [
  'os-notification-offer',
  'repeat-task-automation',
  'skill-share',
  'skill-suggestion',
  'plan-mode-hint',
] as const;
export type SuggestionId = (typeof SUGGESTION_IDS)[number];
export type SuggestionPlacement = 'corner' | 'composer';
export const SUGGESTION_PLACEMENTS: Readonly<
  Record<SuggestionId, SuggestionPlacement>
> = {
  'os-notification-offer': 'corner',
  'repeat-task-automation': 'corner',
  'skill-share': 'corner',
  'skill-suggestion': 'composer',
  'plan-mode-hint': 'composer',
};
export interface SuggestionsState {
  readonly enabled: boolean;
  readonly dismissed: Readonly<Partial<Record<SuggestionId, string>>>;
  readonly lastCornerShownAt?: string;
}
export type SuggestionsUpdate =
  | { readonly action: 'set-enabled'; readonly enabled: boolean }
  | { readonly action: 'dismiss'; readonly suggestionId: SuggestionId }
  | { readonly action: 'corner-shown'; readonly suggestionId: SuggestionId };
export const CORNER_SUGGESTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
export function isSuggestionId(value: unknown): value is SuggestionId {
  return typeof value === 'string' && SUGGESTION_IDS.some((id) => id === value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function timestamp(value: unknown): string | undefined {
  // Require a date-time, not Date.parse's numeric/date-only shorthand.
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  )
    return undefined;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== value.slice(0, 10)
  )
    return undefined;
  if (
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14, 16)) > 59 ||
    Number(value.slice(17, 19)) > 59
  )
    return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
export function normalizeSuggestionsState(
  value: unknown,
  legacyEnabled: unknown = undefined,
): SuggestionsState {
  const record = isRecord(value) ? value : {};
  const dismissed: Partial<Record<SuggestionId, string>> = {};
  if (isRecord(record.dismissed)) {
    for (const id of SUGGESTION_IDS) {
      const at = timestamp(record.dismissed[id]);
      if (at !== undefined) dismissed[id] = at;
    }
  }
  const lastCornerShownAt = timestamp(record.lastCornerShownAt);
  return {
    enabled:
      typeof record.enabled === 'boolean'
        ? record.enabled
        : legacyEnabled !== false,
    dismissed,
    ...(lastCornerShownAt === undefined ? {} : { lastCornerShownAt }),
  };
}
export function parseSuggestionsState(value: unknown): SuggestionsState | null {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    !isRecord(value.dismissed)
  )
    return null;
  if (
    Object.keys(value).some(
      (key) => !['enabled', 'dismissed', 'lastCornerShownAt'].includes(key),
    )
  )
    return null;
  for (const [id, at] of Object.entries(value.dismissed)) {
    if (!isSuggestionId(id) || timestamp(at) === undefined) return null;
  }
  if (
    'lastCornerShownAt' in value &&
    timestamp(value.lastCornerShownAt) === undefined
  )
    return null;
  return normalizeSuggestionsState(value);
}
export function parseSuggestionsUpdate(
  value: unknown,
): SuggestionsUpdate | null {
  if (!isRecord(value) || Object.keys(value).length !== 2) return null;
  if (value.action === 'set-enabled' && typeof value.enabled === 'boolean')
    return { action: 'set-enabled', enabled: value.enabled };
  if (!isSuggestionId(value.suggestionId)) return null;
  if (value.action === 'dismiss')
    return { action: 'dismiss', suggestionId: value.suggestionId };
  if (
    value.action === 'corner-shown' &&
    SUGGESTION_PLACEMENTS[value.suggestionId] === 'corner'
  )
    return { action: 'corner-shown', suggestionId: value.suggestionId };
  return null;
}
/** Future stamps conservatively close the cap through stamp + 24 hours. */
export function isCornerSuggestionAllowed(
  state: SuggestionsState,
  now: Date,
): boolean {
  return (
    state.enabled &&
    (state.lastCornerShownAt === undefined ||
      now.getTime() - Date.parse(state.lastCornerShownAt) >=
        CORNER_SUGGESTION_INTERVAL_MS)
  );
}
/** The writer supplies authoritative time; callers never supply a timestamp. */
export function applySuggestionsUpdate(
  current: SuggestionsState,
  update: SuggestionsUpdate,
  now: Date,
): SuggestionsState {
  if (update.action === 'set-enabled')
    return { ...current, enabled: update.enabled };
  if (update.action === 'dismiss') {
    if (current.dismissed[update.suggestionId] !== undefined) return current;
    return {
      ...current,
      dismissed: {
        ...current.dismissed,
        [update.suggestionId]: now.toISOString(),
      },
    };
  }
  if (SUGGESTION_PLACEMENTS[update.suggestionId] !== 'corner')
    throw new Error('Corner display requires a corner suggestion.');
  if (
    current.lastCornerShownAt !== undefined &&
    Date.parse(current.lastCornerShownAt) >= now.getTime()
  )
    return current;
  return { ...current, lastCornerShownAt: now.toISOString() };
}
export interface SuggestionsQueryMap {
  'suggestions.get': { args: Record<string, never>; result: SuggestionsState };
}
export interface SuggestionsCommandMap {
  'suggestions.update': { args: SuggestionsUpdate; result: SuggestionsState };
}
