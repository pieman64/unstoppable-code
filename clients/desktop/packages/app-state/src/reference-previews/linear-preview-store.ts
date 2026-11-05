import { create } from 'zustand';
import type { CanopyClient } from '@canopy/app-core';
import {
  GITHUB_TITLE_MAX_CODE_POINTS,
  LINEAR_ISSUE_TITLE_MAX_CODE_POINTS,
  LINEAR_TEAM_KEY_PATTERN,
  gitHubPreviewTargetKey,
  isGitHubAvatarUrl,
  isGitHubItemNumber,
  isGitHubRepositoryName,
  isLinearAvatarUrl,
  isLinearStatusType,
  parseGitHubPullPreviewFacts,
  type GitHubPreview,
  type GitHubPreviewTarget,
  type GitHubReferenceOrigin,
  type LinearIssuePreview,
  type LinearIssuePreviewRequest,
  type LinearTeamKeysResult,
  type ReferenceEnrichmentMode,
} from '@canopy/protocol/reference-previews';
import {
  CLIENT_STORE_DISPOSE,
  createClientStore,
  type ClientStore,
} from '../create-client-store';

/** Each provider owns one cache partition: scope, reads, pause and resets. */
export type ReferencePreviewProvider = 'linear' | 'github';

export type ReferencePreviewView<P> =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly preview: P;
      readonly checkedAt: number;
      readonly refreshing: boolean;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'disconnected' | 'unavailable' | 'failed';
    };

export type LinearPreviewView = ReferencePreviewView<LinearIssuePreview>;
export type GitHubPreviewView = ReferencePreviewView<GitHubPreview>;

/** One GitHub.com repository, lowercase, as resolved for a transcript origin. */
export interface GitHubRepositoryName {
  readonly owner: string;
  readonly repository: string;
}

/** The connection's accessible team keys, the allowlist for bare identifiers. */
export interface LinearTeamCatalog {
  /**
   * `idle` once the published catalog is due for a refresh (or before the
   * first load), `loading` while one runs, `unavailable` after it failed.
   */
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable';
  /**
   * The last complete catalog for this scope, kept through refreshes and
   * failed refreshes until retention ends; `null` before the first catalog
   * and after a disconnect or scope change. A successful refresh replaces it.
   */
  readonly keys: ReadonlySet<string> | null;
  /** The host holds a Linear credential for the current scope. */
  readonly connected: boolean;
}

/**
 * Reference previews for every provider. Linear and GitHub share one cache
 * budget and one visibility queue; each keeps its own scope, so a reset of
 * one never clears the other.
 */
export interface LinearPreviewStoreState {
  readonly views: Readonly<Record<string, LinearPreviewView>>;
  readonly teamCatalog: LinearTeamCatalog;
  /** Bumped by every Linear identity reset, so visible references re-register. */
  readonly epoch: number;
  /** Serve from cache or read once; concurrent calls share one read. */
  readonly load: (
    request: LinearIssuePreviewRequest,
  ) => Promise<LinearIssuePreview | null>;
  /**
   * Load the team catalog unless a fresh one, a load, or a retry cooldown
   * already covers it. Known keys stay published while it loads. The first
   * call also confirms a scope hydrated from storage.
   */
  readonly ensureTeamCatalog: () => void;
  /**
   * Register one visible reference for automatic title resolution; returns its
   * release. Reads go through the bounded visibility queue.
   */
  readonly watch: (request: LinearIssuePreviewRequest) => () => void;
  /** Keyed by {@link githubPreviewKey}. */
  readonly githubViews: Readonly<Record<string, GitHubPreviewView>>;
  /**
   * The host holds a GitHub credential, per the local scope query or a scope
   * saved by the last session until the host confirms it.
   */
  readonly githubConnected: boolean;
  /** Bumped by every GitHub identity reset, so visible references re-register. */
  readonly githubEpoch: number;
  /** Check the local GitHub scope once; also confirms a hydrated scope. */
  readonly ensureGitHubConnection: () => void;
  readonly loadGitHub: (
    target: GitHubPreviewTarget,
  ) => Promise<GitHubPreview | null>;
  readonly watchGitHub: (target: GitHubPreviewTarget) => () => void;
  /**
   * Keyed by {@link githubOriginKey}: the origin's single repository, or
   * `null` when it has none. Absent while unresolved.
   */
  readonly githubOrigins: Readonly<Record<string, GitHubRepositoryName | null>>;
  /** Resolve once per retained result; cowork never resolves. */
  readonly ensureGitHubOrigin: (origin: GitHubReferenceOrigin) => void;
}

/**
 * What a decorated reference shows after its identifier: the title, a
 * reserved placeholder while one is expected, or nothing when none will come.
 */
export type ReferenceTitleSlot =
  | { readonly kind: 'title'; readonly title: string }
  | { readonly kind: 'pending'; readonly reading: boolean }
  | { readonly kind: 'none' };

export type LinearTitleSlot = ReferenceTitleSlot;

const PENDING_IDLE: ReferenceTitleSlot = { kind: 'pending', reading: false };
const PENDING_READING: ReferenceTitleSlot = { kind: 'pending', reading: true };
const NO_TITLE: ReferenceTitleSlot = { kind: 'none' };

function titleSlot<P>(
  view: ReferencePreviewView<P> | undefined,
  titleOf: (preview: P) => string | null,
): ReferenceTitleSlot {
  if (view === undefined) return PENDING_IDLE;
  switch (view.status) {
    case 'loading':
      return PENDING_READING;
    case 'ready': {
      const title = titleOf(view.preview);
      return title ? { kind: 'title', title } : NO_TITLE;
    }
    default:
      return NO_TITLE;
  }
}

/**
 * A reference with no view yet expects a title (its read waits on
 * visibility); `reading` marks one with a read in flight. Unavailable,
 * not-found, disconnected and negative-cached references expect none.
 */
export function linearTitleSlot(
  view: LinearPreviewView | undefined,
): ReferenceTitleSlot {
  return titleSlot(view, (preview) => preview.title);
}

/**
 * {@link linearTitleSlot} for GitHub: an item shows its title, a repository
 * its bounded description, and a repository without one shows none.
 */
export function githubTitleSlot(
  view: GitHubPreviewView | undefined,
): ReferenceTitleSlot {
  return titleSlot(view, (preview) =>
    preview.kind === 'item' ? preview.title : preview.description,
  );
}

/** Bounds Linear and GitHub entries together, evicting the least recently shown. */
export const LINEAR_PREVIEW_CACHE_LIMITS = {
  maxEntries: 1000,
  /** 2 MiB of UTF-16 storage. */
  maxSerializedChars: 1024 * 1024,
  /** Bounds parsing of a saved team catalog; main publishes at most 5,000. */
  maxTeamKeys: 5000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  freshMs: 5 * 60 * 1000,
  negativeMs: 60 * 1000,
} as const;

/** Passive (visibility-driven) title reads; hover and focus bypass the queue. */
export const LINEAR_VISIBILITY_QUEUE_LIMITS = {
  debounceMs: 150,
  concurrent: 2,
  pending: 20,
} as const;

const IDLE_CATALOG: LinearTeamCatalog = {
  status: 'idle',
  keys: null,
  connected: false,
};

/**
 * `{ scope, githubScope, entries, catalog, origins }`: each provider's last adopted
 * scope, title entries of both providers (each tagged with its provider and
 * scope; an untagged entry is Linear) and `{ scope, keys, checkedAt }` for the
 * Linear team catalog. A new store hydrates each provider synchronously under
 * its saved scope, then confirms that scope in the background. Origin metadata
 * retains the last resolved local repository until its host revalidation.
 */
export const REFERENCE_PREVIEW_STORAGE_KEY = 'canopy.referencePreviews.v1';
/**
 * Written on every invalidation so other windows reset even with no cache.
 * `<provider>:…` resets one provider; any other value resets every provider.
 */
export const REFERENCE_PREVIEW_RESET_KEY = 'canopy.referencePreviews.reset.v1';

interface EntryFields {
  readonly scope: string;
  readonly key: string;
  readonly checkedAt: number;
  /** When the reference was last shown; eviction drops the oldest first. */
  usedAt: number;
}

type CachedEntry =
  | (EntryFields & {
      readonly provider: 'linear';
      readonly preview: LinearIssuePreview;
    })
  | (EntryFields & {
      readonly provider: 'github';
      readonly preview: GitHubPreview;
    });

interface SavedCatalog {
  readonly scope: string;
  readonly keys: readonly string[];
  readonly checkedAt: number;
}

interface SavedGitHubOrigin {
  readonly key: string;
  readonly repository: GitHubRepositoryName | null;
  readonly checkedAt: number;
}

function isGitHubOriginKey(key: string): boolean {
  const parts = key.split('\0');
  return (
    parts.length === 2 &&
    parts.every((part) => part.length > 0 && part.length <= 256)
  );
}

interface SavedState {
  readonly scope: string | null;
  readonly githubScope: string | null;
  readonly entries: Map<string, CachedEntry>;
  readonly catalog: SavedCatalog | null;
  readonly origins: readonly SavedGitHubOrigin[];
}

/** The record field that holds each provider's scope. */
const SCOPE_FIELD = { linear: 'scope', github: 'githubScope' } as const;

const WRITE_DELAY_MS = 250;
// Showing a reference re-stamps it at most once a minute, and those stamps
// are written lazily, so scrolling never writes storage per reference.
const TOUCH_INTERVAL_MS = 60 * 1000;
const TOUCH_WRITE_DELAY_MS = 2 * 1000;

export interface LinearPreviewStoreDeps {
  readonly now: () => number;
  readonly storage: () => Storage | null;
}

const liveStoreResets = new Set<
  (provider: ReferencePreviewProvider | undefined) => void
>();
const liveModeChanges = new Set<
  (provider: ReferencePreviewProvider, mode: ReferenceEnrichmentMode) => void
>();
let enrichmentModes: Readonly<
  Record<ReferencePreviewProvider, ReferenceEnrichmentMode>
> = {
  linear: 'replace',
  github: 'replace',
};

/** Set startup modes before store creation, then update every live client store. */
export function setReferenceEnrichmentModes(
  modes: Readonly<Record<ReferencePreviewProvider, ReferenceEnrichmentMode>>,
): void {
  const previous = enrichmentModes;
  enrichmentModes = { linear: modes.linear, github: modes.github };
  for (const provider of ['linear', 'github'] as const) {
    if (previous[provider] !== modes[provider]) {
      liveModeChanges.forEach((change) => change(provider, modes[provider]));
    }
  }
}

function readyView<P>(
  preview: P,
  checkedAt: number,
  refreshing: boolean,
): ReferencePreviewView<P> {
  return { status: 'ready', preview, checkedAt, refreshing };
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: LinearPreviewStoreDeps = {
  now: () => Date.now(),
  storage: browserStorage,
};

export function linearPreviewKey(request: LinearIssuePreviewRequest): string {
  return `${request.workspaceSlug ?? '*'}/${request.identifier}`;
}

/**
 * GitHub cache identity. The `github:` namespace can't match a Linear key,
 * and the repository is part of every item key.
 */
export function githubPreviewKey(target: GitHubPreviewTarget): string {
  return `github:${gitHubPreviewTargetKey(target)}`;
}

/** {@link LinearPreviewStoreState.githubOrigins} key; `null` for cowork. */
export function githubOriginKey(origin: GitHubReferenceOrigin): string | null {
  return origin.kind === 'worktree'
    ? `${origin.projectId}\0${origin.worktreeId}`
    : null;
}

function providerOf(entry: unknown): ReferencePreviewProvider {
  return typeof entry === 'object' &&
    entry !== null &&
    Reflect.get(entry, 'provider') === 'github'
    ? 'github'
    : 'linear';
}

/**
 * The saved record without one provider's scope and entries; `null` when it
 * is unreadable or nothing else remains.
 */
function withoutProvider(
  raw: string,
  provider: ReferencePreviewProvider,
): string | null {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (field === SCOPE_FIELD[provider]) continue;
    if (provider === 'linear' && field === 'catalog') continue;
    record[field] =
      field === 'entries' && Array.isArray(value)
        ? value.filter((entry: unknown) => providerOf(entry) !== provider)
        : value;
  }
  // Nothing of the other provider left: remove the record, as a full reset does.
  const entries = record.entries;
  const empty =
    Object.keys(record).every((field) => field === 'entries') &&
    (!Array.isArray(entries) || entries.length === 0);
  return empty ? null : JSON.stringify(record);
}

/**
 * Forget cached previews in this window and, through the `storage` event,
 * every other window. Without `provider` (sign-out or Canopy account change)
 * every provider resets; with one, only that provider's scope and entries.
 */
export function invalidateReferencePreviews(
  storage: Storage | null = browserStorage(),
  provider?: ReferencePreviewProvider,
): void {
  // The reset key goes first: another window that sees a provider reset
  // ignores the record removal that may follow it (see `onStorage`).
  try {
    const stamp = `${Date.now()}:${Math.random()}`;
    storage?.setItem(
      REFERENCE_PREVIEW_RESET_KEY,
      provider === undefined ? stamp : `${provider}:${stamp}`,
    );
  } catch {
    // Memory is still cleared below.
  }
  try {
    let rest: string | null = null;
    if (provider !== undefined) {
      try {
        const raw = storage?.getItem(REFERENCE_PREVIEW_STORAGE_KEY);
        rest = raw ? withoutProvider(raw, provider) : null;
      } catch {
        // Unreadable record: remove it, as a full reset does.
      }
    }
    if (rest !== null) storage?.setItem(REFERENCE_PREVIEW_STORAGE_KEY, rest);
    else storage?.removeItem(REFERENCE_PREVIEW_STORAGE_KEY);
  } catch {
    // Quota or access failure: memory is still cleared below.
  }
  liveStoreResets.forEach((reset) => reset(provider));
}

/** An older or unknown reset value resets every provider. */
function resetProviderOf(
  value: string | null,
): ReferencePreviewProvider | undefined {
  if (value?.startsWith('linear:')) return 'linear';
  if (value?.startsWith('github:')) return 'github';
  return undefined;
}

const isNullableString = (value: unknown): boolean =>
  value === null || typeof value === 'string';

const isBoundedText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && Array.from(value).length <= max;

function isLinearIssuePreview(value: unknown): value is LinearIssuePreview {
  if (typeof value !== 'object' || value === null) return false;
  const url: unknown = Reflect.get(value, 'url');
  return (
    typeof Reflect.get(value, 'identifier') === 'string' &&
    isBoundedText(
      Reflect.get(value, 'title'),
      LINEAR_ISSUE_TITLE_MAX_CODE_POINTS,
    ) &&
    typeof url === 'string' &&
    url.startsWith('https://linear.app/') &&
    typeof Reflect.get(value, 'updatedAt') === 'string' &&
    isNullableString(Reflect.get(value, 'description')) &&
    isNullableString(Reflect.get(value, 'status')) &&
    isNullableString(Reflect.get(value, 'assignee')) &&
    isNullableString(Reflect.get(value, 'project')) &&
    isAbsentOr(Reflect.get(value, 'statusType'), isLinearStatusType) &&
    isAbsentOr(Reflect.get(value, 'assigneeAvatarUrl'), isLinearAvatarUrl)
  );
}

/** An optional field that, when set, passes `check`. */
function isAbsentOr(
  value: unknown,
  check: (value: unknown) => boolean,
): boolean {
  return value === undefined || value === null || check(value);
}

const GITHUB_ITEM_STATES: readonly unknown[] = ['open', 'closed', 'merged'];
const GITHUB_ITEM_TYPES: readonly unknown[] = ['pull', 'issue'];

function isGitHubPreview(value: unknown): value is GitHubPreview {
  if (typeof value !== 'object' || value === null) return false;
  const field = (name: string): unknown => Reflect.get(value, name);
  const url = field('url');
  const shared =
    isGitHubRepositoryName(field('owner'), field('repository')) &&
    typeof url === 'string' &&
    url.startsWith('https://github.com/') &&
    typeof field('updatedAt') === 'string' &&
    isNullableString(field('description'));
  if (!shared) return false;
  switch (field('kind')) {
    case 'item':
      return (
        isGitHubItemNumber(field('number')) &&
        GITHUB_ITEM_TYPES.includes(field('itemType')) &&
        isBoundedText(field('title'), GITHUB_TITLE_MAX_CODE_POINTS) &&
        GITHUB_ITEM_STATES.includes(field('state')) &&
        typeof field('draft') === 'boolean' &&
        isNullableString(field('author')) &&
        (field('authorAvatarUrl') == null ||
          isGitHubAvatarUrl(field('authorAvatarUrl'))) &&
        (field('pull') === undefined ||
          parseGitHubPullPreviewFacts(field('pull')) !== null)
      );
    case 'repository':
      return (
        isBoundedText(field('fullName'), GITHUB_TITLE_MAX_CODE_POINTS) &&
        typeof field('private') === 'boolean' &&
        typeof field('archived') === 'boolean'
      );
    default:
      return false;
  }
}

function targetOf(preview: GitHubPreview): GitHubPreviewTarget {
  return preview.kind === 'item'
    ? {
        kind: 'item',
        owner: preview.owner,
        repository: preview.repository,
        number: preview.number,
      }
    : {
        kind: 'repository',
        owner: preview.owner,
        repository: preview.repository,
      };
}

/**
 * A persisted record is trusted only when every displayed field is valid. A
 * GitHub entry must also sit under its own complete target's key.
 */
function parseCachedEntry(value: unknown): CachedEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const scope: unknown = Reflect.get(value, 'scope');
  const key: unknown = Reflect.get(value, 'key');
  const checkedAt: unknown = Reflect.get(value, 'checkedAt');
  const usedAt: unknown = Reflect.get(value, 'usedAt');
  const preview: unknown = Reflect.get(value, 'preview');
  const provider: unknown = Reflect.get(value, 'provider');
  if (
    typeof scope !== 'string' ||
    typeof key !== 'string' ||
    typeof checkedAt !== 'number' ||
    typeof usedAt !== 'number'
  ) {
    return null;
  }
  const fields: EntryFields = { scope, key, checkedAt, usedAt };
  if (provider === 'github') {
    return isGitHubPreview(preview) &&
      githubPreviewKey(targetOf(preview)) === key
      ? { ...fields, provider: 'github', preview }
      : null;
  }
  return (provider === undefined || provider === 'linear') &&
    isLinearIssuePreview(preview)
    ? { ...fields, provider: 'linear', preview }
    : null;
}

const isTeamKey = (value: unknown): value is string =>
  typeof value === 'string' && LINEAR_TEAM_KEY_PATTERN.test(value);

/** Any invalid field discards the whole catalog, never the entries. */
function parseSavedCatalog(value: unknown): SavedCatalog | null {
  if (typeof value !== 'object' || value === null) return null;
  const scope: unknown = Reflect.get(value, 'scope');
  const keys: unknown = Reflect.get(value, 'keys');
  const checkedAt: unknown = Reflect.get(value, 'checkedAt');
  if (
    typeof scope !== 'string' ||
    typeof checkedAt !== 'number' ||
    !Number.isFinite(checkedAt) ||
    !Array.isArray(keys) ||
    keys.length > LINEAR_PREVIEW_CACHE_LIMITS.maxTeamKeys ||
    !keys.every(isTeamKey)
  ) {
    return null;
  }
  return { scope, keys, checkedAt };
}

const savedScopeOf = (record: object, field: string): string | null => {
  const saved: unknown = Reflect.get(record, field);
  return typeof saved === 'string' ? saved : null;
};

type ProviderResult<P> =
  | {
      readonly status: 'ok';
      readonly scope: string;
      readonly preview: P;
      readonly fetchedAt?: number;
    }
  | { readonly status: 'disconnected' }
  | { readonly status: 'unavailable'; readonly scope: string }
  | { readonly status: 'rate-limited'; readonly retryAfterMs: number | null }
  | { readonly status: 'failed' };

/** One provider's lifecycle state; reset without touching the other's. */
interface PartitionState {
  readonly provider: ReferencePreviewProvider;
  // `undefined` until this window first learns the host's provider identity.
  scope: string | null | undefined;
  // Bumped by every reset; a read that started earlier is discarded.
  generation: number;
  // Off fences pending hydration without invalidating this credential's cache.
  modeGeneration: number;
  // A scope hydrated from storage, until the host confirms or replaces it.
  presumed: boolean;
  readonly negative: Map<
    string,
    { retryAt: number; reason: 'unavailable' | 'failed' }
  >;
  pausedUntil: number;
  // Credential presence from the local scope query.
  connectionPending: boolean;
  connectionKnown: boolean;
  // Retries a failed check while saved data is still unconfirmed.
  confirmTimer: ReturnType<typeof setTimeout> | null;
  confirmRetryAt: number;
  // The saved record's scope for this provider, written back unchanged while
  // `scope` is unknown so this window never drops another window's data.
  savedScope: string | null;
}

interface Partition<T, P> {
  readonly state: PartitionState;
  readonly inflight: Map<string, Promise<P | null>>;
  readonly keyOf: (target: T) => string;
  readonly readScope: () => Promise<{
    readonly scope: string | null;
    /** The host will try a rejected credential again after this long. */
    readonly retryAfterMs?: number;
  }>;
  readonly read: (target: T) => Promise<ProviderResult<P>>;
  readonly entryOf: (fields: EntryFields, preview: P) => CachedEntry;
  readonly previewOf: (entry: CachedEntry) => P | null;
  readonly viewsOf: (
    state: LinearPreviewStoreState,
  ) => Readonly<Record<string, ReferencePreviewView<P>>>;
  readonly withViews: (
    views: Record<string, ReferencePreviewView<P>>,
  ) => Partial<LinearPreviewStoreState>;
}

const newPartitionState = (
  provider: ReferencePreviewProvider,
): PartitionState => ({
  provider,
  scope: undefined,
  generation: 0,
  modeGeneration: 0,
  presumed: false,
  negative: new Map(),
  pausedUntil: 0,
  connectionPending: false,
  connectionKnown: false,
  confirmTimer: null,
  confirmRetryAt: 0,
  savedScope: null,
});

export function createLinearPreviewStore(
  client: CanopyClient,
  deps: LinearPreviewStoreDeps = DEFAULT_DEPS,
): ClientStore<LinearPreviewStoreState> {
  const limits = LINEAR_PREVIEW_CACHE_LIMITS;
  // Both providers' entries share this map, its bounds and its LRU order.
  let entries: Map<string, CachedEntry> | null = null;
  let savedCatalog: SavedCatalog | null = null;
  // The saved record's catalog, carried like `PartitionState.savedScope`.
  let carriedCatalog: SavedCatalog | null = null;
  let writeTimer: ReturnType<typeof setTimeout> | null = null;
  let touchTimer: ReturnType<typeof setTimeout> | null = null;
  let dispose = (): void => undefined;
  // Team catalog: published keys go stale but stay published until a
  // successful refresh replaces them or retention ends; failures wait out a
  // cooldown.
  let catalogCheckedAt = 0;
  let catalogExpiresAt = 0;
  let catalogRetryAt = 0;
  let catalogPending = false;
  let catalogTimer: ReturnType<typeof setTimeout> | null = null;
  // Kept team keys end at retention even while a refresh never settles.
  let retentionTimer: ReturnType<typeof setTimeout> | null = null;
  let originRetentionTimer: ReturnType<typeof setTimeout> | null = null;
  // Local git remotes don't depend on a credential.
  const originsRequested = new Set<string>();
  const originsPending = new Map<string, number>();
  const originCache = new Map<string, SavedGitHubOrigin>();
  const rememberOrigin = (entry: SavedGitHubOrigin): string | undefined => {
    originCache.delete(entry.key);
    originCache.set(entry.key, entry);
    let evicted: string | undefined;
    while (originCache.size > limits.maxEntries) {
      const oldest = originCache.keys().next().value;
      if (oldest === undefined) break;
      originCache.delete(oldest);
      evicted = oldest;
    }
    return evicted;
  };
  // Visibility queue, shared by both providers. `visible` counts mounted,
  // on-screen consumers per key.
  interface VisibleEntry {
    readonly partition: PartitionState;
    readonly load: () => Promise<unknown>;
    readonly view: () => ReferencePreviewView<unknown> | undefined;
    count: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** Re-admits the reference when its title goes stale or a retry is due. */
    recheck: ReturnType<typeof setTimeout> | null;
    /** After the first read, only `recheck` admits it again. */
    attempted: boolean;
  }
  const visible = new Map<string, VisibleEntry>();
  const pending: string[] = [];
  const demanded = new Set<string>();
  // Keys with a passive read in flight, and the partition that owns each.
  const passive = new Map<string, PartitionState>();
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeAt = 0;
  const clearVisibleTimers = (entry: VisibleEntry): void => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    if (entry.recheck !== null) clearTimeout(entry.recheck);
    entry.timer = null;
    entry.recheck = null;
  };

  const linearState = newPartitionState('linear');
  const githubState = newPartitionState('github');
  const modeOf = (partition: PartitionState): ReferenceEnrichmentMode =>
    enrichmentModes[partition.provider];

  const readSaved = (): SavedState => {
    const map = new Map<string, CachedEntry>();
    let scope: string | null = null;
    let githubScope: string | null = null;
    let catalog: SavedCatalog | null = null;
    const origins: SavedGitHubOrigin[] = [];
    try {
      const raw = deps.storage()?.getItem(REFERENCE_PREVIEW_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (typeof parsed === 'object' && parsed !== null) {
        scope = savedScopeOf(parsed, SCOPE_FIELD.linear);
        githubScope = savedScopeOf(parsed, SCOPE_FIELD.github);
        catalog = parseSavedCatalog(Reflect.get(parsed, 'catalog'));
        const savedOrigins: unknown = Reflect.get(parsed, 'origins');
        if (Array.isArray(savedOrigins)) {
          for (const value of savedOrigins.slice(0, limits.maxEntries)) {
            if (typeof value !== 'object' || value === null) continue;
            const key: unknown = Reflect.get(value, 'key');
            const checkedAt: unknown = Reflect.get(value, 'checkedAt');
            const candidate: unknown = Reflect.get(value, 'repository');
            if (
              typeof key !== 'string' ||
              !isGitHubOriginKey(key) ||
              typeof checkedAt !== 'number' ||
              !Number.isFinite(checkedAt) ||
              checkedAt < 0 ||
              checkedAt > deps.now() ||
              deps.now() - checkedAt > limits.retentionMs
            )
              continue;
            let repository: GitHubRepositoryName | null = null;
            if (candidate !== null) {
              if (typeof candidate !== 'object' || candidate === null) continue;
              const owner: unknown = Reflect.get(candidate, 'owner');
              const name: unknown = Reflect.get(candidate, 'repository');
              if (
                typeof owner !== 'string' ||
                typeof name !== 'string' ||
                !isGitHubRepositoryName(owner, name)
              )
                continue;
              repository = { owner, repository: name };
            }
            origins.push({ key, repository, checkedAt });
          }
        }
        const list: unknown = Reflect.get(parsed, 'entries');
        if (Array.isArray(list)) {
          let dropped = false;
          for (const value of list) {
            const entry = parseCachedEntry(value);
            if (
              map.size < limits.maxEntries &&
              entry &&
              deps.now() - entry.checkedAt <= limits.retentionMs
            ) {
              map.set(entry.key, entry);
            } else {
              dropped = true;
            }
          }
          // Rewrite the mirror so expired details do not outlive retention.
          if (dropped) schedulePersist();
        }
      }
    } catch {
      // Corrupt or unreadable storage: continue from memory.
    }
    linearState.savedScope = scope;
    githubState.savedScope = githubScope;
    carriedCatalog = catalog;
    origins.forEach(rememberOrigin);
    return { scope, githubScope, entries: map, catalog, origins };
  };

  const cacheEntries = (): Map<string, CachedEntry> => {
    entries ??= readSaved().entries;
    return entries;
  };

  const flush = (): void => {
    writeTimer = null;
    if (touchTimer !== null) clearTimeout(touchTimer);
    touchTimer = null;
    const scopeOf = (partition: PartitionState): string | null =>
      partition.scope === undefined ? partition.savedScope : partition.scope;
    let head = '';
    for (const partition of [linearState, githubState]) {
      const scope = scopeOf(partition);
      if (scope !== null) {
        head += `"${SCOPE_FIELD[partition.provider]}":${JSON.stringify(scope)},`;
      }
    }
    const catalog =
      linearState.scope === undefined ? carriedCatalog : savedCatalog;
    let tail =
      catalog && catalog.scope === scopeOf(linearState)
        ? `,"catalog":${JSON.stringify(catalog)}`
        : '';
    const origins = Array.from(originCache.values()).filter(
      (entry) => deps.now() - entry.checkedAt <= limits.retentionMs,
    );
    if (origins.length > 0) tail += `,"origins":${JSON.stringify(origins)}`;
    // Most recently shown first, so the least recently shown fall off.
    const ordered = Array.from(cacheEntries().values()).sort(
      (left, right) => right.usedAt - left.usedAt,
    );
    const parts: string[] = [];
    let size = head.length + tail.length + '{"entries":[]}'.length;
    for (const entry of ordered.slice(0, limits.maxEntries)) {
      const part = JSON.stringify(entry);
      if (size + part.length + 1 > limits.maxSerializedChars) break;
      parts.push(part);
      size += part.length + 1;
    }
    try {
      const storage = deps.storage();
      // Nothing to save: don't recreate a record a reset just removed.
      if (
        head === '' &&
        tail === '' &&
        parts.length === 0 &&
        storage?.getItem(REFERENCE_PREVIEW_STORAGE_KEY) === null
      ) {
        return;
      }
      storage?.setItem(
        REFERENCE_PREVIEW_STORAGE_KEY,
        `{${head}"entries":[${parts.join(',')}]${tail}}`,
      );
    } catch {
      // Quota or access failure: memory remains the source of truth.
    }
  };

  const schedulePersist = (): void => {
    writeTimer ??= setTimeout(flush, WRITE_DELAY_MS);
  };

  const touch = (key: string): void => {
    const entry = cacheEntries().get(key);
    const now = deps.now();
    if (!entry || now - entry.usedAt < TOUCH_INTERVAL_MS) return;
    entry.usedAt = now;
    if (writeTimer === null) {
      touchTimer ??= setTimeout(flush, TOUCH_WRITE_DELAY_MS);
    }
  };

  const store: ClientStore<LinearPreviewStoreState> =
    create<LinearPreviewStoreState>((set, get) => {
      const linear: Partition<LinearIssuePreviewRequest, LinearIssuePreview> = {
        state: linearState,
        inflight: new Map(),
        keyOf: linearPreviewKey,
        readScope: () => client.query('referencePreview.linearScope', {}),
        read: (request) =>
          client.query('referencePreview.linearIssue', request),
        entryOf: (fields, preview) => ({
          ...fields,
          provider: 'linear',
          preview,
        }),
        previewOf: (entry) =>
          entry.provider === 'linear' ? entry.preview : null,
        viewsOf: (state) => state.views,
        withViews: (views) => ({ views }),
      };
      const github: Partition<GitHubPreviewTarget, GitHubPreview> = {
        state: githubState,
        inflight: new Map(),
        keyOf: githubPreviewKey,
        readScope: () => client.query('referencePreview.githubScope', {}),
        read: (target) => client.query('referencePreview.github', target),
        entryOf: (fields, preview) => ({
          ...fields,
          provider: 'github',
          preview,
        }),
        previewOf: (entry) =>
          entry.provider === 'github' ? entry.preview : null,
        viewsOf: (state) => state.githubViews,
        withViews: (views) => ({ githubViews: views }),
      };

      // Ready views mirror cache entries and leave when their entry is
      // evicted. Views without a title are bounded on their own, dropping
      // the oldest off-screen ones first; re-inserting moves a key last.
      const setView = <T, P>(
        partition: Partition<T, P>,
        key: string,
        view: ReferencePreviewView<P>,
      ): void =>
        set((state) => {
          const views: Record<string, ReferencePreviewView<P>> = {
            ...partition.viewsOf(state),
          };
          delete views[key];
          views[key] = view;
          if (view.status === 'ready') {
            // Only a cache reloaded by another window can strand ready views.
            if (Object.keys(views).length > 2 * limits.maxEntries) {
              const map = cacheEntries();
              trim(
                views,
                (other, current) =>
                  current.status === 'ready' && !map.has(other),
              );
            }
          } else {
            trim(views, (_, current) => current.status !== 'ready');
          }
          return partition.withViews(views);
        });

      const trim = <P>(
        views: Record<string, ReferencePreviewView<P>>,
        bounded: (key: string, view: ReferencePreviewView<P>) => boolean,
      ): void => {
        const keys = Object.entries(views)
          .filter(([key, view]) => bounded(key, view))
          .map(([key]) => key);
        const excess = keys.length - limits.maxEntries;
        if (excess <= 0) return;
        const offscreen = keys.filter((key) => !visible.has(key));
        const onscreen = keys.filter((key) => visible.has(key));
        for (const old of [...offscreen, ...onscreen].slice(0, excess)) {
          delete views[old];
        }
      };

      // One budget for both providers: the least recently shown entry of
      // either leaves first.
      const remember = (entry: CachedEntry): void => {
        const map = cacheEntries();
        map.set(entry.key, entry);
        if (map.size <= limits.maxEntries) return;
        const evicted = Array.from(map.values())
          .sort((left, right) => left.usedAt - right.usedAt)
          .slice(0, map.size - limits.maxEntries)
          .map((stale) => stale.key);
        for (const key of evicted) map.delete(key);
        const { views, githubViews } = get();
        const shown = evicted.filter(
          (key) =>
            views[key]?.status === 'ready' ||
            githubViews[key]?.status === 'ready',
        );
        if (shown.length === 0) return;
        set((state) => {
          const nextViews: Record<string, LinearPreviewView> = {
            ...state.views,
          };
          const nextGitHub: Record<string, GitHubPreviewView> = {
            ...state.githubViews,
          };
          for (const key of shown) {
            delete nextViews[key];
            delete nextGitHub[key];
          }
          return { views: nextViews, githubViews: nextGitHub };
        });
      };

      const resetPartition = (partition: PartitionState): void => {
        partition.generation += 1;
        partition.scope = undefined;
        partition.presumed = false;
        partition.negative.clear();
        partition.pausedUntil = 0;
        partition.connectionPending = false;
        partition.connectionKnown = false;
        if (partition.confirmTimer !== null) {
          clearTimeout(partition.confirmTimer);
        }
        partition.confirmTimer = null;
        partition.confirmRetryAt = 0;
        partition.savedScope = null;
        for (const [key, entry] of Array.from(visible)) {
          if (entry.partition !== partition) continue;
          clearVisibleTimers(entry);
          visible.delete(key);
          const index = pending.indexOf(key);
          if (index >= 0) pending.splice(index, 1);
        }
        // Includes reads whose reference was released mid-read: their own
        // settle is fenced off by the new generation and never frees them.
        for (const [key, owner] of Array.from(passive)) {
          if (owner === partition) passive.delete(key);
        }
        if (entries) {
          let dropped = false;
          for (const [key, entry] of Array.from(entries)) {
            if (entry.provider === partition.provider) {
              entries.delete(key);
              dropped = true;
            }
          }
          // A merge from another window may have re-added them to storage.
          if (dropped) schedulePersist();
        }
        if (partition === linearState) {
          for (const key of Array.from(linear.inflight.keys()))
            demanded.delete(key);
          linear.inflight.clear();
          savedCatalog = null;
          carriedCatalog = null;
          catalogCheckedAt = 0;
          catalogExpiresAt = 0;
          catalogRetryAt = 0;
          catalogPending = false;
          if (catalogTimer !== null) clearTimeout(catalogTimer);
          catalogTimer = null;
          if (retentionTimer !== null) clearTimeout(retentionTimer);
          retentionTimer = null;
          set((state) => ({
            views: {},
            teamCatalog: IDLE_CATALOG,
            epoch: state.epoch + 1,
          }));
        } else {
          for (const key of Array.from(github.inflight.keys()))
            demanded.delete(key);
          github.inflight.clear();
          set((state) => ({
            githubViews: {},
            githubConnected: false,
            githubEpoch: state.githubEpoch + 1,
          }));
        }
        // Slots the reset provider held may now admit the other's references.
        pump();
      };

      const reset = (provider: ReferencePreviewProvider | undefined): void => {
        // A full reset reloads whatever another window saved since, and
        // writes nothing itself.
        if (provider === undefined) entries = null;
        if (provider !== 'github') resetPartition(linearState);
        if (provider !== 'linear') resetPartition(githubState);
      };

      const adoptScope = (
        partition: PartitionState,
        next: string | null,
      ): void => {
        // Saved data under a disowned scope is shared by every window, and
        // other windows may have hydrated it: purge this provider in all.
        const disowned =
          (partition.presumed ||
            (partition.scope !== undefined && partition.scope !== null)) &&
          partition.scope !== next;
        if (disowned) {
          invalidateReferencePreviews(deps.storage(), partition.provider);
        }
        if (partition.scope !== undefined && partition.scope !== next) {
          resetPartition(partition);
        }
        partition.scope = next;
        partition.presumed = false;
        let dropped = false;
        for (const [key, entry] of Array.from(cacheEntries())) {
          if (entry.provider === partition.provider && entry.scope !== next) {
            cacheEntries().delete(key);
            dropped = true;
          }
        }
        // The purge removed this provider's saved scope; save the new one.
        if (dropped || (disowned && next !== null)) schedulePersist();
      };

      const cached = <T, P>(
        partition: Partition<T, P>,
        key: string,
      ): { readonly preview: P; readonly checkedAt: number } | null => {
        const entry = cacheEntries().get(key);
        if (!entry) return null;
        const preview = partition.previewOf(entry);
        if (preview === null) return null;
        if (deps.now() - entry.checkedAt > limits.retentionMs) {
          cacheEntries().delete(key);
          schedulePersist();
          return null;
        }
        return { preview, checkedAt: entry.checkedAt };
      };

      const run = async <T, P>(
        partition: Partition<T, P>,
        target: T,
        key: string,
        passiveRead: boolean,
      ): Promise<P | null> => {
        const own = partition.state;
        const scopeGeneration = own.generation;
        const modeGeneration = own.modeGeneration;
        const identity = await partition.readScope().catch(() => null);
        if (
          scopeGeneration !== own.generation ||
          modeGeneration !== own.modeGeneration ||
          modeOf(own) === 'off' ||
          (passiveRead && modeOf(own) !== 'replace' && !demanded.has(key))
        )
          return null;
        if (!identity) {
          own.negative.set(key, {
            retryAt: deps.now() + limits.negativeMs,
            reason: 'failed',
          });
          const entry = cached(partition, key);
          setView(
            partition,
            key,
            entry
              ? readyView(entry.preview, entry.checkedAt, false)
              : { status: 'unavailable', reason: 'failed' },
          );
          return entry?.preview ?? null;
        }
        const current = identity.scope;
        adoptScope(own, current);
        if (current === null) {
          setView(partition, key, {
            status: 'unavailable',
            reason: 'disconnected',
          });
          return null;
        }
        const readGeneration = own.generation;
        const entry = cached(partition, key);
        const blocked = own.negative.get(key);
        if (
          entry &&
          (deps.now() - entry.checkedAt <= limits.freshMs ||
            (blocked && blocked.retryAt > deps.now()))
        ) {
          setView(
            partition,
            key,
            readyView(entry.preview, entry.checkedAt, false),
          );
          return entry.preview;
        }
        if (blocked && blocked.retryAt > deps.now()) {
          setView(partition, key, {
            status: 'unavailable',
            reason: blocked.reason,
          });
          return null;
        }
        const stale = (refreshing: boolean): ReferencePreviewView<P> =>
          entry
            ? readyView(entry.preview, entry.checkedAt, refreshing)
            : { status: 'unavailable', reason: 'failed' };
        // The provider asked us to wait: hover and focus honor that too.
        if (deps.now() < own.pausedUntil) {
          setView(partition, key, stale(false));
          return entry?.preview ?? null;
        }
        setView(partition, key, entry ? stale(true) : { status: 'loading' });
        const result = await partition
          .read(target)
          .catch((): ProviderResult<P> => ({ status: 'failed' }));
        if (
          readGeneration !== own.generation ||
          modeGeneration !== own.modeGeneration ||
          modeOf(own) === 'off'
        )
          return null;
        if (result.status === 'ok' || result.status === 'unavailable') {
          if (result.scope !== current) {
            resetPartition(own);
            return null;
          }
        }
        switch (result.status) {
          case 'ok': {
            const now = deps.now();
            const acquiredAt =
              partition.state.provider === 'github' &&
              result.fetchedAt !== undefined
                ? result.fetchedAt
                : now;
            if (
              typeof acquiredAt !== 'number' ||
              !Number.isFinite(acquiredAt) ||
              acquiredAt < 0 ||
              acquiredAt > now ||
              now - acquiredAt > limits.retentionMs
            ) {
              setView(partition, key, stale(false));
              return entry?.preview ?? null;
            }
            const latest = cached(partition, key);
            if (latest && latest.checkedAt > acquiredAt) {
              setView(
                partition,
                key,
                readyView(latest.preview, latest.checkedAt, false),
              );
              return latest.preview;
            }
            remember(
              partition.entryOf(
                { scope: current, key, checkedAt: acquiredAt, usedAt: now },
                result.preview,
              ),
            );
            own.negative.delete(key);
            schedulePersist();
            setView(
              partition,
              key,
              readyView(result.preview, acquiredAt, false),
            );
            return result.preview;
          }
          case 'disconnected':
            invalidateReferencePreviews(deps.storage(), own.provider);
            setView(partition, key, {
              status: 'unavailable',
              reason: 'disconnected',
            });
            return null;
          case 'unavailable':
            if (cacheEntries().delete(key)) schedulePersist();
            own.negative.set(key, {
              retryAt: deps.now() + limits.negativeMs,
              reason: 'unavailable',
            });
            setView(partition, key, {
              status: 'unavailable',
              reason: 'unavailable',
            });
            return null;
          default: {
            const retryAfterMs =
              (result.status === 'rate-limited' ? result.retryAfterMs : null) ??
              limits.negativeMs;
            if (result.status === 'rate-limited') {
              // A shorter Retry-After that lands later never shortens the pause.
              own.pausedUntil = Math.max(
                own.pausedUntil,
                deps.now() + retryAfterMs,
              );
            }
            // Transient: keep a labeled stale value until retention expires.
            own.negative.set(key, {
              retryAt: deps.now() + retryAfterMs,
              reason: 'failed',
            });
            setView(partition, key, stale(false));
            return entry?.preview ?? null;
          }
        }
      };

      let providerResetPending = false;
      const onStorage = (event: StorageEvent): void => {
        if (event.key === null) {
          reset(undefined);
        } else if (event.key === REFERENCE_PREVIEW_RESET_KEY) {
          const provider = resetProviderOf(event.newValue);
          providerResetPending = provider !== undefined;
          reset(provider);
        } else if (event.key === REFERENCE_PREVIEW_STORAGE_KEY) {
          if (event.newValue === null) {
            // A provider reset that emptied the record removes it right after
            // naming the provider; the other provider keeps its data.
            if (providerResetPending) {
              providerResetPending = false;
              return;
            }
            reset(undefined);
            return;
          }
          const local = entries;
          const saved = readSaved();
          entries = saved.entries;
          // Never write back an older catalog than another window saved. The
          // newer one applies on this window's next refresh, not live.
          if (
            saved.catalog &&
            saved.catalog.scope === linearState.scope &&
            saved.catalog.checkedAt > (savedCatalog?.checkedAt ?? -Infinity)
          ) {
            savedCatalog = saved.catalog;
          }
          // Keep entries and last-shown stamps this window has not written
          // yet; the pending flush then persists both windows' results.
          if (local && (writeTimer !== null || touchTimer !== null)) {
            const merged = saved.entries;
            local.forEach((entry, key) => {
              const other = merged.get(key);
              if (!other || other.checkedAt < entry.checkedAt) {
                merged.set(key, entry);
              } else if (other.checkedAt === entry.checkedAt) {
                other.usedAt = Math.max(other.usedAt, entry.usedAt);
              }
            });
          }
        }
      };

      // Known keys stay published through refreshes and failures until
      // retention, measured from the catalog's own read.
      const retainedKeys = (): ReadonlySet<string> | null =>
        deps.now() - catalogCheckedAt <= limits.retentionMs
          ? get().teamCatalog.keys
          : null;

      // Kept keys end at retention even while a refresh never settles or a
      // retry waits longer.
      const dropKeysAt = (deadline: number): void => {
        if (retentionTimer !== null) clearTimeout(retentionTimer);
        const timerGeneration = linearState.generation;
        retentionTimer = setTimeout(
          () => {
            retentionTimer = null;
            if (timerGeneration !== linearState.generation) return;
            set((state) => ({
              teamCatalog: { ...state.teamCatalog, keys: null },
            }));
          },
          Math.max(0, deadline - deps.now()),
        );
      };

      // One timer per deadline, not polling: when a published catalog
      // expires or a failure cooldown ends, mounted transcripts see `idle`
      // and reload on that use.
      const idleCatalogAt = (deadline: number): void => {
        if (catalogTimer !== null) clearTimeout(catalogTimer);
        const timerGeneration = linearState.generation;
        catalogTimer = setTimeout(
          () => {
            catalogTimer = null;
            if (timerGeneration !== linearState.generation) return;
            set((state) => ({
              teamCatalog: {
                status: 'idle',
                keys: retainedKeys(),
                connected: state.teamCatalog.connected,
              },
            }));
          },
          Math.max(0, deadline - deps.now()),
        );
      };

      const applyCatalog = (result: LinearTeamKeysResult | null): void => {
        const now = deps.now();
        if (result === null) {
          catalogRetryAt = now + limits.negativeMs;
          set((state) => ({
            teamCatalog: {
              status: 'unavailable',
              keys: retainedKeys(),
              connected: state.teamCatalog.connected,
            },
          }));
          idleCatalogAt(catalogRetryAt);
          return;
        }
        if (result.status === 'disconnected') {
          // Tell other windows, but only on a transition: a window that has
          // already reset (or never connected) stays quiet, so windows cannot
          // keep resetting each other.
          if (
            get().teamCatalog.connected ||
            (linearState.scope !== undefined && linearState.scope !== null)
          ) {
            invalidateReferencePreviews(deps.storage(), 'linear');
          }
          adoptScope(linearState, null);
          // Recheck on the next eligible use after the freshness window, or
          // sooner when a connection change resets the store.
          catalogRetryAt = now + limits.freshMs;
          set({
            teamCatalog: {
              status: 'unavailable',
              keys: null,
              connected: false,
            },
          });
          return;
        }
        adoptScope(linearState, result.scope);
        if (result.status === 'ok') {
          catalogCheckedAt = Math.min(result.fetchedAt, now);
          catalogExpiresAt = catalogCheckedAt + limits.freshMs;
          dropKeysAt(catalogCheckedAt + limits.retentionMs);
          savedCatalog = {
            scope: result.scope,
            keys: result.keys,
            checkedAt: catalogCheckedAt,
          };
          schedulePersist();
          set({
            teamCatalog: {
              status: 'ready',
              keys: new Set(result.keys),
              connected: true,
            },
          });
          idleCatalogAt(catalogExpiresAt);
          return;
        }
        catalogRetryAt =
          now +
          ((result.status === 'rate-limited' ? result.retryAfterMs : null) ??
            limits.negativeMs);
        set({
          teamCatalog: {
            status: 'unavailable',
            keys: retainedKeys(),
            connected: true,
          },
        });
        idleCatalogAt(catalogRetryAt);
      };

      // The local scope query (no provider call) tells references whether a
      // credential exists, without waiting for a provider read.
      const ensureConnection = <T, P>(
        partition: Partition<T, P>,
        publish: (connected: boolean) => void,
        onDisowned?: () => void,
      ): void => {
        const own = partition.state;
        if (modeOf(own) === 'off') return;
        const retryConnectionAt = (deadline: number): void => {
          own.confirmRetryAt = deadline;
          const generation = own.generation;
          const modeGeneration = own.modeGeneration;
          own.confirmTimer ??= setTimeout(
            () => {
              own.confirmTimer = null;
              if (
                generation !== own.generation ||
                modeGeneration !== own.modeGeneration ||
                modeOf(own) === 'off'
              )
                return;
              own.confirmRetryAt = 0;
              own.connectionKnown = false;
              ensureConnection(partition, publish, onDisowned);
            },
            Math.max(0, deadline - deps.now()),
          );
        };
        if (own.connectionKnown && own.confirmRetryAt > 0) {
          retryConnectionAt(own.confirmRetryAt);
          return;
        }
        if (own.connectionPending || own.connectionKnown) return;
        own.connectionPending = true;
        const connectionGeneration = own.generation;
        const connectionModeGeneration = own.modeGeneration;
        void partition
          .readScope()
          .catch(() => null)
          .then((identity) => {
            if (
              connectionGeneration !== own.generation ||
              connectionModeGeneration !== own.modeGeneration ||
              modeOf(own) === 'off'
            )
              return;
            own.connectionPending = false;
            if (!identity) {
              // Saved data stays unconfirmed; check again rather than wait
              // for the next use.
              if (own.presumed) {
                retryConnectionAt(deps.now() + limits.negativeMs);
              }
              return;
            }
            // Presence, plus the check that disowns a scope already shown: a
            // hydrated scope, or one a read path adopted first. An unknown
            // scope is left to the read paths, so this cannot reset a read
            // started in the same tick.
            if (
              own.presumed ||
              (own.scope !== undefined && identity.scope !== own.scope)
            ) {
              adoptScope(own, identity.scope);
            }
            own.connectionKnown = true;
            const connected = identity.scope !== null;
            publish(connected);
            // The host is waiting out a credential the provider rejected:
            // check again when it says it will retry, in every window.
            const retryAfterMs = connected ? undefined : identity.retryAfterMs;
            if (
              typeof retryAfterMs === 'number' &&
              Number.isFinite(retryAfterMs) &&
              retryAfterMs > 0
            ) {
              retryConnectionAt(
                deps.now() + Math.min(retryAfterMs, limits.freshMs),
              );
            }
            // A disowned scope reset the partition and fenced off the load
            // this check started with; start it again for the new scope.
            if (connected && connectionGeneration !== own.generation) {
              onDisowned?.();
            }
          });
      };

      const ensureTeamCatalog = (): void => {
        if (modeOf(linearState) === 'off') return;
        ensureConnection(
          linear,
          (connected) =>
            set((state) => ({
              teamCatalog: { ...state.teamCatalog, connected },
            })),
          ensureTeamCatalog,
        );
        if (catalogPending) return;
        const now = deps.now();
        const { teamCatalog } = get();
        if (teamCatalog.status === 'ready' && now < catalogExpiresAt) {
          if (catalogTimer === null) idleCatalogAt(catalogExpiresAt);
          return;
        }
        if (teamCatalog.status === 'unavailable' && now < catalogRetryAt) {
          if (catalogTimer === null) idleCatalogAt(catalogRetryAt);
          return;
        }
        catalogPending = true;
        if (catalogTimer !== null) clearTimeout(catalogTimer);
        catalogTimer = null;
        const catalogGeneration = linearState.generation;
        const catalogModeGeneration = linearState.modeGeneration;
        set({
          teamCatalog: {
            status: 'loading',
            keys: retainedKeys(),
            connected: teamCatalog.connected,
          },
        });
        void client
          .query('referencePreview.linearTeams', {})
          .catch(() => null)
          .then((result) => {
            if (
              catalogGeneration !== linearState.generation ||
              catalogModeGeneration !== linearState.modeGeneration ||
              modeOf(linearState) === 'off'
            )
              return;
            catalogPending = false;
            applyCatalog(result);
          });
      };

      const ensureGitHubConnection = (): void =>
        ensureConnection(github, (connected) =>
          set({ githubConnected: connected }),
        );

      const scheduleOriginRetention = (): void => {
        if (originRetentionTimer !== null) clearTimeout(originRetentionTimer);
        originRetentionTimer = null;
        let deadline = Infinity;
        for (const entry of Array.from(originCache.values())) {
          deadline = Math.min(
            deadline,
            entry.checkedAt + limits.retentionMs + 1,
          );
        }
        if (!Number.isFinite(deadline)) return;
        originRetentionTimer = setTimeout(
          () => {
            originRetentionTimer = null;
            const githubOrigins = { ...get().githubOrigins };
            let expired = false;
            for (const entry of Array.from(originCache.values())) {
              if (deps.now() - entry.checkedAt <= limits.retentionMs) continue;
              originCache.delete(entry.key);
              delete githubOrigins[entry.key];
              originsRequested.delete(entry.key);
              expired = true;
            }
            if (expired) {
              set({ githubOrigins });
              schedulePersist();
            }
            scheduleOriginRetention();
          },
          Math.max(0, deadline - deps.now()),
        );
      };

      const ensureGitHubOrigin = (origin: GitHubReferenceOrigin): void => {
        if (modeOf(githubState) === 'off') return;
        const key = githubOriginKey(origin);
        if (
          key === null ||
          originsRequested.has(key) ||
          originsPending.has(key)
        )
          return;
        originsRequested.add(key);
        const originModeGeneration = githubState.modeGeneration;
        originsPending.set(key, originModeGeneration);
        void client
          .query('referencePreview.githubOrigin', origin)
          .catch(() => undefined)
          .then((result) => {
            if (
              originModeGeneration !== githubState.modeGeneration ||
              modeOf(githubState) === 'off'
            ) {
              if (originsPending.get(key) === originModeGeneration) {
                originsPending.delete(key);
                originsRequested.delete(key);
              }
              return;
            }
            originsPending.delete(key);
            if (result === undefined) {
              const retained = originCache.get(key);
              set((state) => ({
                githubOrigins: {
                  ...state.githubOrigins,
                  [key]:
                    retained &&
                    deps.now() - retained.checkedAt <= limits.retentionMs
                      ? retained.repository
                      : null,
                },
              }));
              return;
            }
            const found = result.repository ?? null;
            const repository: GitHubRepositoryName | null =
              found && isGitHubRepositoryName(found.owner, found.repository)
                ? { owner: found.owner, repository: found.repository }
                : null;
            let evicted: string | undefined;
            if (isGitHubOriginKey(key)) {
              evicted = rememberOrigin({
                key,
                repository,
                checkedAt: deps.now(),
              });
              scheduleOriginRetention();
              schedulePersist();
            }
            set((state) => {
              const githubOrigins = {
                ...state.githubOrigins,
                [key]: repository,
              };
              if (evicted !== undefined) {
                delete githubOrigins[evicted];
                originsRequested.delete(evicted);
              }
              return { githubOrigins };
            });
          });
      };

      // When a reference next needs a read: after its fresh window (as
      // `run` serves it) or its negative-cache wait, whichever ends later.
      const readDueAt = (key: string, entry: VisibleEntry): number => {
        const view = entry.view();
        const freshUntil =
          view?.status === 'ready' && !view.refreshing
            ? view.checkedAt + limits.freshMs + 1
            : 0;
        return Math.max(
          freshUntil,
          entry.partition.negative.get(key)?.retryAt ?? 0,
        );
      };

      const isSettled = (key: string, entry: VisibleEntry): boolean =>
        readDueAt(key, entry) > deps.now();

      // One timer per visible reference, not polling: re-admit it once its
      // title goes stale, its failure cooldown ends, or a provider pause
      // lifts. A disconnected reference waits for the reset on reconnect.
      const scheduleRecheck = (key: string): void => {
        const entry = visible.get(key);
        if (!entry || modeOf(entry.partition) !== 'replace') return;
        entry.attempted = true;
        if (entry.recheck !== null) clearTimeout(entry.recheck);
        entry.recheck = null;
        const delay =
          Math.max(readDueAt(key, entry), entry.partition.pausedUntil) -
          deps.now();
        if (delay <= 0) return;
        entry.recheck = setTimeout(() => {
          entry.recheck = null;
          if (modeOf(entry.partition) !== 'replace') return;
          // Due again: refill may admit it if the pending set is full now.
          entry.attempted = false;
          if (admit(key)) pump();
        }, delay);
      };

      const resumeQueueAt = (at: number): void => {
        if (resumeTimer !== null && resumeAt <= at) return;
        if (resumeTimer !== null) clearTimeout(resumeTimer);
        resumeAt = at;
        resumeTimer = setTimeout(() => {
          resumeTimer = null;
          pump();
        }, at - deps.now());
      };

      // A paused provider's references wait in place; the other provider's
      // references still run.
      const pump = (): void => {
        const now = deps.now();
        let pausedUntil = Infinity;
        let index = 0;
        while (
          passive.size < LINEAR_VISIBILITY_QUEUE_LIMITS.concurrent &&
          index < pending.length
        ) {
          const key = pending[index];
          const entry = key === undefined ? undefined : visible.get(key);
          if (key === undefined || !entry) {
            pending.splice(index, 1);
            continue;
          }
          const partition = entry.partition;
          if (modeOf(partition) !== 'replace') {
            pending.splice(index, 1);
            continue;
          }
          if (now < partition.pausedUntil) {
            pausedUntil = Math.min(pausedUntil, partition.pausedUntil);
            index += 1;
            continue;
          }
          pending.splice(index, 1);
          passive.set(key, partition);
          const queueGeneration = partition.generation;
          void entry.load().finally(() => {
            if (queueGeneration !== partition.generation) return;
            if (passive.get(key) !== partition) return;
            passive.delete(key);
            refill();
          });
        }
        if (pausedUntil !== Infinity) resumeQueueAt(pausedUntil);
      };

      // Admit a visible reference whose debounce elapsed, if it still needs
      // a read and the pending set has room.
      const admit = (key: string): boolean => {
        const entry = visible.get(key);
        if (
          !entry ||
          modeOf(entry.partition) !== 'replace' ||
          entry.timer !== null ||
          entry.attempted
        )
          return false;
        if (
          pending.includes(key) ||
          passive.has(key) ||
          isSettled(key, entry)
        ) {
          return false;
        }
        if (
          pendingFor(entry.partition) >= LINEAR_VISIBILITY_QUEUE_LIMITS.pending
        ) {
          return false;
        }
        pending.push(key);
        return true;
      };

      // Each provider has its own pending limit, so references a paused
      // provider keeps waiting never block the other provider's.
      const pendingFor = (partition: PartitionState): number =>
        pending.filter((key) => visible.get(key)?.partition === partition)
          .length;

      // As slots clear, admit references that are still on screen.
      const refill = (): void => {
        for (const key of Array.from(visible.keys())) admit(key);
        pump();
      };

      const watchIn = <T, P>(
        partition: Partition<T, P>,
        target: T,
      ): (() => void) => {
        if (modeOf(partition.state) !== 'replace') return () => undefined;
        const key = partition.keyOf(target);
        let entry = visible.get(key);
        if (!entry) {
          entry = {
            partition: partition.state,
            load: (): Promise<P | null> => loadIn(partition, target, true),
            view: (): ReferencePreviewView<P> | undefined =>
              partition.viewsOf(get())[key],
            count: 0,
            timer: null,
            recheck: null,
            attempted: false,
          };
          visible.set(key, entry);
        }
        const watched = entry;
        watched.count += 1;
        if (watched.count === 1) {
          touch(key);
          watched.timer = setTimeout(() => {
            watched.timer = null;
            if (admit(key)) pump();
            else if (isSettled(key, watched)) scheduleRecheck(key);
          }, LINEAR_VISIBILITY_QUEUE_LIMITS.debounceMs);
        }
        let released = false;
        return (): void => {
          if (released || visible.get(key) !== watched) return;
          released = true;
          watched.count -= 1;
          if (watched.count > 0) return;
          clearVisibleTimers(watched);
          visible.delete(key);
          const index = pending.indexOf(key);
          if (index >= 0) pending.splice(index, 1);
        };
      };

      const loadIn = <T, P>(
        partition: Partition<T, P>,
        target: T,
        passiveRead = false,
      ): Promise<P | null> => {
        if (modeOf(partition.state) === 'off') return Promise.resolve(null);
        if (passiveRead && modeOf(partition.state) !== 'replace') {
          return Promise.resolve(null);
        }
        const key = partition.keyOf(target);
        touch(key);
        const existing = partition.inflight.get(key);
        if (existing) {
          if (!passiveRead) demanded.add(key);
          return existing;
        }
        const loadGeneration = partition.state.generation;
        const modeGeneration = partition.state.modeGeneration;
        const promise = run(partition, target, key, passiveRead).finally(() => {
          if (partition.inflight.get(key) === promise) {
            partition.inflight.delete(key);
            demanded.delete(key);
          }
          if (
            loadGeneration === partition.state.generation &&
            modeGeneration === partition.state.modeGeneration
          ) {
            scheduleRecheck(key);
          }
        });
        partition.inflight.set(key, promise);
        return promise;
      };

      const onModeChange = (
        provider: ReferencePreviewProvider,
        mode: ReferenceEnrichmentMode,
      ): void => {
        const partition = provider === 'linear' ? linearState : githubState;
        if (mode !== 'replace') {
          for (const [key, entry] of Array.from(visible)) {
            if (entry.partition !== partition) continue;
            clearVisibleTimers(entry);
            visible.delete(key);
            const index = pending.indexOf(key);
            if (index >= 0) pending.splice(index, 1);
          }
          // In-flight requests still occupy the shared budget until their
          // own finalizer settles, even if this provider is now Off.
          if (resumeTimer !== null) clearTimeout(resumeTimer);
          resumeTimer = null;
          resumeAt = 0;
          pump();
        }
        if (mode !== 'off') return;
        partition.modeGeneration += 1;
        partition.connectionPending = false;
        if (partition.confirmTimer !== null)
          clearTimeout(partition.confirmTimer);
        partition.confirmTimer = null;
        if (provider === 'linear') {
          for (const key of Array.from(linear.inflight.keys()))
            demanded.delete(key);
          linear.inflight.clear();
          catalogPending = false;
          if (catalogTimer !== null) clearTimeout(catalogTimer);
          catalogTimer = null;
        } else {
          for (const key of Array.from(github.inflight.keys()))
            demanded.delete(key);
          github.inflight.clear();
          for (const key of Array.from(originsPending.keys()))
            originsRequested.delete(key);
          originsPending.clear();
        }
      };

      // First paint: show what the last session saw under each provider's
      // scope, from storage only. Each provider's first use confirms its
      // scope with the host. Deliberate (CAN-3978): saved data paints before
      // that check, which purges every window if the scope changed while no
      // window was running. Credential changes made while one runs already
      // purge storage.
      const saved = readSaved();
      entries = saved.entries;
      scheduleOriginRetention();
      const initialViews: Record<string, LinearPreviewView> = {};
      const initialGitHubViews: Record<string, GitHubPreviewView> = {};
      let initialCatalog = IDLE_CATALOG;
      if (saved.scope !== null) {
        const savedScope = saved.scope;
        linearState.scope = savedScope;
        linearState.presumed = true;
        saved.entries.forEach((entry, key) => {
          if (entry.provider === 'linear' && entry.scope === savedScope) {
            initialViews[key] = readyView(
              entry.preview,
              entry.checkedAt,
              false,
            );
          }
        });
        initialCatalog = { ...IDLE_CATALOG, connected: true };
        const catalog = saved.catalog;
        const now = deps.now();
        if (
          catalog &&
          catalog.scope === savedScope &&
          now - catalog.checkedAt <= limits.retentionMs
        ) {
          savedCatalog = catalog;
          catalogCheckedAt = Math.min(catalog.checkedAt, now);
          catalogExpiresAt = catalogCheckedAt + limits.freshMs;
          const fresh = now < catalogExpiresAt;
          dropKeysAt(catalogCheckedAt + limits.retentionMs);
          initialCatalog = {
            status: fresh ? 'ready' : 'idle',
            keys: new Set(catalog.keys),
            connected: true,
          };
          if (fresh) idleCatalogAt(catalogExpiresAt);
        }
      }
      if (saved.githubScope !== null) {
        const savedScope = saved.githubScope;
        githubState.scope = savedScope;
        githubState.presumed = true;
        saved.entries.forEach((entry, key) => {
          if (entry.provider === 'github' && entry.scope === savedScope) {
            initialGitHubViews[key] = readyView(
              entry.preview,
              entry.checkedAt,
              false,
            );
          }
        });
      }

      liveStoreResets.add(reset);
      liveModeChanges.add(onModeChange);
      if (typeof window !== 'undefined') {
        window.addEventListener('storage', onStorage);
      }
      dispose = (): void => {
        liveStoreResets.delete(reset);
        liveModeChanges.delete(onModeChange);
        if (typeof window !== 'undefined') {
          window.removeEventListener('storage', onStorage);
        }
        if (writeTimer !== null) clearTimeout(writeTimer);
        if (touchTimer !== null) clearTimeout(touchTimer);
        if (resumeTimer !== null) clearTimeout(resumeTimer);
        if (catalogTimer !== null) clearTimeout(catalogTimer);
        if (retentionTimer !== null) clearTimeout(retentionTimer);
        if (originRetentionTimer !== null) clearTimeout(originRetentionTimer);
        for (const partition of [linearState, githubState]) {
          if (partition.confirmTimer !== null) {
            clearTimeout(partition.confirmTimer);
          }
        }
        visible.forEach(clearVisibleTimers);
        visible.clear();
        pending.length = 0;
        linearState.generation += 1;
        githubState.generation += 1;
        githubState.modeGeneration += 1;
      };

      return {
        views: initialViews,
        teamCatalog: initialCatalog,
        epoch: 0,
        load: (request) => loadIn(linear, request),
        ensureTeamCatalog,
        watch: (request) => watchIn(linear, request),
        githubViews: initialGitHubViews,
        githubConnected: saved.githubScope !== null,
        githubEpoch: 0,
        ensureGitHubConnection,
        loadGitHub: (target) => loadIn(github, target),
        watchGitHub: (target) => watchIn(github, target),
        githubOrigins: Object.fromEntries(
          saved.origins.map((entry) => [entry.key, entry.repository]),
        ),
        ensureGitHubOrigin,
      };
    });
  store[CLIENT_STORE_DISPOSE] = (): void => dispose();
  return store;
}

/** Provider-scoped reference preview cache (Linear and GitHub); one per injected client. */
export const useLinearPreviewStore = createClientStore((client) =>
  createLinearPreviewStore(client),
);
