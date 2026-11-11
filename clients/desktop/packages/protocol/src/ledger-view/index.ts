// ---------------------------------------------------------------------------
// View contracts for reading and writing one scope's Agent Ledger from an
// interface: the desktop Ledger panel, and the global Feed after it.
//
// These are portable DTOs. They carry logical IDs only (projects, worktrees,
// Work Entries, chats, pipeline executions), never host paths, so a host
// adapts them to its own transport and navigation. Entries, filters and
// errors reuse the `core.ledger.*` contracts unchanged.
//
// Dependency-free like the rest of `@canopy/protocol`: safe to import from the
// desktop main process, the renderer and the web app.
// ---------------------------------------------------------------------------

import type {
  LedgerActorLabel,
  LedgerAddEntryParams,
  LedgerCommandReceipt,
  LedgerEntriesSearchParams,
  LedgerEntryGetResult,
  LedgerEntrySearchItem,
  LedgerEntryType,
  LedgerErrorReason,
  LedgerGlobalOwner,
  LedgerOwnerCandidatePage,
  LedgerRollupItem,
  LedgerRootChatFilter,
  LedgerSourceAvailability,
  LedgerStatus,
  LedgerUpdateEntryParams,
} from '../canopy-core';
import type {
  LedgerMirrorActorLabel,
  LedgerMirrorEntry,
  LedgerMirrorEntryResponse,
  LedgerMirrorEntryResponseV2,
  LedgerMirrorEntryV2,
  LedgerScopeKind,
} from '../ledger-sync';

/**
 * A task's work scope: a panel layout's project and worktree, where a Cowork
 * or App Advisor Work Entry occupies the worktree slot. Panel placement, the
 * composer, file search and navigation only ever address this shape.
 */
export interface LedgerTaskViewScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

/**
 * One incarnation of an owner's global (workflow) Ledger. `ledgerId` is only
 * an address: the host validates the stored account and owner before serving
 * it, so retained guest history stays reachable without exposing another
 * account's Ledger.
 */
export interface LedgerGlobalViewScope {
  readonly kind: 'global';
  readonly owner: LedgerGlobalOwner;
  readonly ledgerId: string;
}

/** The work scope a view reads. */
export type LedgerViewScope = LedgerTaskViewScope | LedgerGlobalViewScope;

export function isLedgerTaskViewScope(
  scope: LedgerViewScope,
): scope is LedgerTaskViewScope {
  return !('kind' in scope);
}

/**
 * A stable key for per-scope state. Global keys include the `ledgerId` so two
 * incarnations of one owner's Ledger never collide. The parts are encoded as
 * a JSON array, so no ID can make two scopes share a key.
 */
export function ledgerViewScopeKey(scope: LedgerViewScope): string {
  if (isLedgerTaskViewScope(scope)) {
    return JSON.stringify(['task', scope.projectId, scope.worktreeId]);
  }
  const owner =
    scope.owner.kind === 'personal'
      ? 'personal'
      : `org:${scope.owner.organizationId.toLowerCase()}`;
  return JSON.stringify(['global', owner, scope.ledgerId]);
}

/** Why a scope has no Ledger to read right now. */
export const LEDGER_VIEW_UNAVAILABLE_REASONS = [
  /** `canopy-ledger-enabled` is off. */
  'disabled',
  /** The scope has no Ledger container, or the container no longer exists. */
  'no_scope',
  /** The Ledger runtime is not running (startup or shutdown). */
  'runtime_unavailable',
] as const;

export type LedgerViewUnavailableReason =
  (typeof LEDGER_VIEW_UNAVAILABLE_REASONS)[number];

/**
 * A view read's outcome. An error is never folded into an empty result, so an
 * interface can tell "no entries" from "could not read the Ledger".
 */
export type LedgerViewResult<Value> =
  | { readonly status: 'ok'; readonly value: Value }
  | {
      readonly status: 'unavailable';
      readonly reason: LedgerViewUnavailableReason;
    }
  | {
      readonly status: 'error';
      /** The Ledger's error reason, or `UNKNOWN` for any other failure. */
      readonly reason: LedgerErrorReason | 'UNKNOWN';
      readonly message: string;
    };

/** The filters a view applies on top of its search text. */
export interface LedgerViewFilters {
  /** Empty means every type. */
  readonly types: readonly LedgerEntryType[];
  /** Empty means every status. */
  readonly statuses: readonly LedgerStatus[];
  /** `you` keeps the entries the person reading owns. */
  readonly owner: 'anyone' | 'you';
  /**
   * Work from one line of agents: the Feed panel's root chat picker and its
   * Root activity only switch. Absent or null shows everyone's.
   */
  readonly rootChat?: LedgerRootChatFilter | null;
}

export interface LedgerViewSearchRequest {
  readonly scope: LedgerViewScope;
  readonly params: LedgerEntriesSearchParams;
}

export interface LedgerViewEntryRequest {
  readonly scope: LedgerViewScope;
  readonly entryId: string;
  /** Continues the entry's mutation history from this cursor. */
  readonly historyCursor?: string;
}

/** The Summary snapshot a SUMMARY entry recorded, as it was generated. */
export interface LedgerViewSummarySnapshot {
  readonly title: string;
  readonly description: string;
  readonly highlights: readonly string[];
  readonly generatedAt: string;
}

/**
 * Where an entry's source opens on this device. Every target is a logical
 * location the host navigator resolves when it is opened; none is a path.
 */
export type LedgerViewSourceTarget =
  | {
      /**
       * The chat that recorded the entry, or for a managed delegate the chat
       * that started it. `delegationId` names the delegate, whose own chat a
       * host opens beside that chat while it is not archived.
       */
      readonly kind: 'chat';
      readonly projectId: string;
      readonly worktreeId: string;
      readonly chatId: string;
      /** The chat is archived; it opens in the read-only archive viewer. */
      readonly archived: boolean;
      readonly delegationId?: string;
    }
  | {
      /**
       * The pipeline execution of a pipeline agent, or the one a managed
       * delegate's pipeline agent belongs to. Opens at the physical job when
       * one is known. A global or directory run has no task, so it carries
       * no project or worktree.
       */
      readonly kind: 'pipeline';
      readonly projectId?: string;
      readonly worktreeId?: string;
      readonly executionId: string;
      readonly jobId?: string;
      readonly stepId?: string;
      readonly attempt?: number;
    }
  | {
      /** The Summary snapshot the entry recorded, never the latest summary. */
      readonly kind: 'summary';
      readonly snapshot: LedgerViewSummarySnapshot;
    };

/** An entry's source as this device can open it. */
export interface LedgerViewSource {
  readonly availability: LedgerSourceAvailability;
  /**
   * Null when there is nothing to open: an entry the user added, or a source
   * this device no longer has.
   */
  readonly target: LedgerViewSourceTarget | null;
}

/** One entry with its history page and its resolved source. */
export interface LedgerViewEntry {
  readonly entry: LedgerEntryGetResult;
  /** Null when the source could not be checked right now. */
  readonly source: LedgerViewSource | null;
}

/** The outcome of opening a source or a reference file. */
export type LedgerViewOpenResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/** One committed change: identifiers and the new revision only. */
export interface LedgerViewChange {
  readonly scope: LedgerViewScope;
  readonly entryId: string;
  readonly revision: number;
  /** A provisional title was resolved without changing the entry revision. */
  readonly titleResolved?: true;
}

/** Changes committed since the last event, coalesced by the host. */
export interface LedgerViewChangedEvent {
  readonly changes: readonly LedgerViewChange[];
  /**
   * Scopes whose entries' sync state changed with no new revision, such as
   * the mirror acknowledging them; `all` when what may sync changed for every
   * scope (the account, sharing or an organization's policy).
   */
  readonly syncChanged?: readonly LedgerViewScope[] | 'all';
}

/**
 * A command a view sends as the person using it. `requestKey` identifies the
 * attempt: sending the same key with the same params again returns the first
 * attempt's receipt, so a view retries with it after an unknown outcome.
 */
export interface LedgerViewAddRequest {
  readonly scope: LedgerViewScope;
  readonly requestKey: string;
  readonly params: LedgerAddEntryParams;
}

export interface LedgerViewUpdateRequest {
  readonly scope: LedgerViewScope;
  readonly requestKey: string;
  readonly params: LedgerUpdateEntryParams;
}

/** A command's outcome once the local Ledger committed it. */
export type LedgerViewReceipt = LedgerCommandReceipt;

/** One page of the scope's assignable owners. */
export interface LedgerViewOwnersRequest {
  readonly scope: LedgerViewScope;
  readonly cursor?: string;
}

export type LedgerViewOwnerPage = LedgerOwnerCandidatePage;

/**
 * A file a view may reference: a path relative to one of the scope's logical
 * roots. A reference never carries the file's content.
 */
export interface LedgerViewFileCandidate {
  readonly rootId: string;
  /** The root's name, for display. */
  readonly rootName: string;
  readonly path: string;
}

// ---------------------------------------------------------------------------
// The global Feed (phase 14, LD03): entries across every project and task.
// It reads the cloud mirror for the account's other devices and its
// teammates, and this device's own scopes locally, so it can show work this
// device has not synced yet.
// ---------------------------------------------------------------------------

/**
 * Whose entries the Feed shows: the person's own on every device (the
 * default), the same plus their teammates', or only this device's.
 */
export const LEDGER_FEED_AUDIENCES = [
  'mine',
  'teammates',
  'this_device',
] as const;

export type LedgerFeedAudience = (typeof LEDGER_FEED_AUDIENCES)[number];

/** How far back the Feed reaches, by when an entry last changed. */
export const LEDGER_FEED_PERIODS = ['any', 'day', 'week', 'month'] as const;

export type LedgerFeedPeriod = (typeof LEDGER_FEED_PERIODS)[number];

/** The Feed's filters: the panel's, plus who added an entry, when and where. */
export interface LedgerFeedFilters extends LedgerViewFilters {
  /** `you` keeps the entries the person reading added. */
  readonly author: 'anyone' | 'you';
  readonly period: LedgerFeedPeriod;
  /** Includes the entries of archived projects and tasks. */
  readonly includeArchived: boolean;
}

export interface LedgerFeedRequest {
  readonly audience: LedgerFeedAudience;
  /** Literal words, each matching the start of a word; all must match. Empty for none. */
  readonly query: string;
  readonly filters: LedgerFeedFilters;
  /** Continues a search from the page that returned it. */
  readonly cursor?: string;
  /** Reads past the Feed's short-lived cache of first pages. */
  readonly refresh?: boolean;
  /**
   * A look at the newest first page, for newer activity: it reads past the
   * cache, keeps no search, and its page has no cursor, so it never
   * displaces a search a list is paging.
   */
  readonly peek?: boolean;
  /**
   * Narrows the Feed to these of this device's scopes. Rows of other
   * devices and teammates never match, so the read stays on this device.
   */
  readonly ledgerIds?: readonly string[];
  /** Narrows the Feed to this one scope of this device, as a panel shows it. */
  readonly scope?: LedgerViewScope;
}

/** Where a Feed row was written. */
export type LedgerFeedOrigin =
  | {
      /** This device: the row opens and changes here, in its scope. */
      readonly kind: 'this_device';
      readonly scope: LedgerViewScope;
    }
  | {
      /** Another of the person's devices: read only here. */
      readonly kind: 'other_device';
      readonly deviceLabel: string;
    }
  | {
      /** A teammate, in a project an organization of the person can read. */
      readonly kind: 'teammate';
      readonly teammateName: string;
      readonly organizationName: string;
    };

/**
 * Who owns a global (workflow) row. `organizationName` is present only when
 * the reader may see the organization; without it the row reads as
 * Workflows alone.
 */
export interface LedgerFeedGlobalOwner {
  readonly owner: LedgerGlobalOwner;
  readonly organizationName?: string;
}

/** One entry in the Feed, with where it was recorded. */
export interface LedgerFeedRow {
  readonly entry: LedgerEntrySearchItem;
  readonly ledgerId: string;
  /** What kind of work the entry belongs to. */
  readonly scopeKind: LedgerScopeKind;
  readonly scopeArchived: boolean;
  readonly origin: LedgerFeedOrigin;
  /** Set on a `global` row read from the mirror, from its version-2 owner. */
  readonly global?: LedgerFeedGlobalOwner;
}

/**
 * Why a page holds only part of what the Feed could show. Never folded into
 * an empty page: the person always learns what is missing.
 */
export type LedgerFeedNotice =
  /** Signed out: only work this device did signed out shows. */
  | 'signed_out'
  /** The cloud could not be reached: only this device's work shows. */
  | 'remote_unavailable';

export interface LedgerFeedPage {
  /** Newest change first. */
  readonly rows: readonly LedgerFeedRow[];
  /** Labels for every actor the rows name. */
  readonly actors: readonly LedgerActorLabel[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly notice: LedgerFeedNotice | null;
}

/**
 * A row of another device or a teammate, read from the cloud mirror. Rows of
 * this device's scopes read through their scope instead.
 */
export interface LedgerFeedEntryRequest {
  readonly entryId: string;
  /** Continues the entry's history from this cursor. */
  readonly historyCursor?: string;
}

// ---------------------------------------------------------------------------
// Feed variant E (L06–L10, L12): the Operations table of this device's
// operations and top-level tasks, and where their owners run, so a view can
// read their live state from the host's canonical chat state.
// ---------------------------------------------------------------------------

/**
 * Where an actor of this device's scopes runs. Logical IDs only: a host maps
 * it to its own chat, delegation and pipeline state.
 */
export type LedgerViewActorHost =
  | {
      readonly kind: 'chat';
      readonly projectId: string;
      readonly worktreeId: string;
      readonly chatId: string;
    }
  | {
      /** A managed delegate, with the chat its delegation tree started from. */
      readonly kind: 'delegation';
      readonly projectId: string;
      readonly worktreeId: string;
      readonly delegationId: string;
      readonly rootChatId: string | null;
    }
  | {
      readonly kind: 'pipeline';
      readonly projectId: string;
      readonly worktreeId: string;
      readonly executionId: string;
    };

/** One Operations row: an operation, or a top-level task with no operation. */
export interface LedgerFeedWorkRow {
  readonly ledgerId: string;
  readonly scope: LedgerViewScope;
  readonly scopeKind: LedgerScopeKind;
  readonly scopeArchived: boolean;
  /** The project's and task's names for the work path; null when unknown here. */
  readonly projectName: string | null;
  readonly taskName: string | null;
  /** The item and its leaf-task rollup, from `core.ledger.rollups.list`. */
  readonly item: LedgerRollupItem;
  /**
   * The task's chat, which Message writes to when the person owns the item;
   * null when the task has none.
   */
  readonly chatId: string | null;
  /**
   * Finished before the two-working-day window, with no open leaves; only
   * with `includeOlder`. The Feed lists it once the person shows older rows.
   */
  readonly older?: true;
}

export interface LedgerFeedWorkRequest {
  /**
   * Also returns Completed and Failed rows older than the two-working-day
   * window, each marked `older`.
   */
  readonly includeOlder: boolean;
  /** Reads past the host's short-lived cache. */
  readonly refresh?: boolean;
  /** Only this scope's operations and top-level tasks, as a panel shows them. */
  readonly scope?: LedgerViewScope;
}

export interface LedgerFeedWorkPage {
  /** Newest last activity first. */
  readonly rows: readonly LedgerFeedWorkRow[];
  /** Labels for every actor the rows name. */
  readonly actors: readonly LedgerActorLabel[];
  /**
   * Where each actor that owns a row or one of its open leaves runs, by actor
   * ID. Only this device's actors; one with no live session here is absent.
   */
  readonly actorHosts: Readonly<Record<string, LedgerViewActorHost>>;
  /** How many Completed and Failed rows are older than the window. */
  readonly olderCount: number;
  /** The rollup read stopped at its bound, so some rows are missing. */
  readonly truncated: boolean;
}

const LEDGER_FEED_COMPLETED_WORKING_DAYS = 2;

/**
 * The start of the window of Completed rows the Operations table shows: two
 * working days back from `now` in local time, skipping Saturday and Sunday, so
 * on a Monday Friday's finished work still shows.
 */
export function ledgerFeedCompletedCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  let counted = 0;
  while (counted < LEDGER_FEED_COMPLETED_WORKING_DAYS) {
    cutoff.setDate(cutoff.getDate() - 1);
    const day = cutoff.getDay();
    if (day !== 0 && day !== 6) counted += 1;
  }
  return cutoff;
}

// ---------------------------------------------------------------------------
// The cloud mirror's rows as the Feed reads them. Every host that reads the
// mirror (the desktop Feed for other devices and teammates, the web Feed for
// everything) maps them the same way.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const LEDGER_FEED_PERIOD_MS: {
  readonly [Period in LedgerFeedPeriod]: number | null;
} = {
  any: null,
  day: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
};

/** The Feed's filters as a scope's search and the mirror's search take them. */
export interface LedgerFeedSearchFilters {
  readonly query?: string;
  readonly types?: LedgerEntriesSearchParams['types'];
  readonly statuses?: LedgerEntriesSearchParams['statuses'];
  readonly owner?: 'self';
  readonly author?: 'self';
  readonly updatedAfter?: string;
}

/** The search filters for a Feed query, its period counted back from `now`. */
export function ledgerFeedSearchFilters(
  query: string,
  filters: LedgerFeedFilters,
  now: number,
): LedgerFeedSearchFilters {
  const trimmed = query.trim();
  const period = LEDGER_FEED_PERIOD_MS[filters.period];
  return {
    ...(trimmed.length > 0 ? { query: trimmed } : {}),
    ...(filters.types.length > 0 ? { types: [...filters.types] } : {}),
    ...(filters.statuses.length > 0 ? { statuses: [...filters.statuses] } : {}),
    ...(filters.owner === 'you' ? { owner: 'self' as const } : {}),
    ...(filters.author === 'you' ? { author: 'self' as const } : {}),
    ...(period === null
      ? {}
      : { updatedAfter: new Date(now - period).toISOString() }),
  };
}

/** A mirror row: another device's or a teammate's, read only. */
export function ledgerFeedRowFromMirror(
  entry: LedgerMirrorEntry | LedgerMirrorEntryV2,
): LedgerFeedRow {
  const {
    ledgerId,
    scopeKind,
    scopeArchived,
    source,
    globalOwner,
    organizationName,
    ...item
  } = entry;
  const searchItem: LedgerEntrySearchItem = item;
  return {
    entry: searchItem,
    ledgerId,
    scopeKind,
    scopeArchived,
    // A global row names its owner, and the organization when the reader
    // may see it.
    ...(globalOwner === undefined
      ? {}
      : {
          global: {
            owner: globalOwner,
            ...(organizationName === undefined ? {} : { organizationName }),
          },
        }),
    origin:
      source.kind === 'mine'
        ? { kind: 'other_device', deviceLabel: source.deviceLabel }
        : {
            kind: 'teammate',
            teammateName: source.teammateName,
            organizationName: source.organizationName,
          },
  };
}

/** A mirror actor label, without the ledger it was read from. */
export function ledgerActorLabelFromMirror(
  label: Pick<LedgerMirrorActorLabel, 'actorId' | 'kind' | 'displayName'>,
): LedgerActorLabel {
  return {
    actorId: label.actorId,
    kind: label.kind,
    displayName: label.displayName,
  };
}

/** A history cursor's mirror revision, or null when it is not one. */
export function ledgerMirrorHistoryRevision(cursor: string): number | null {
  return /^[1-9][0-9]{0,8}$/.test(cursor) ? Number(cursor) : null;
}

/** A mirror entry as the read-only detail shows it. */
export function ledgerViewEntryFromMirror(
  response: LedgerMirrorEntryResponse | LedgerMirrorEntryResponseV2,
): LedgerViewEntry {
  return {
    entry: {
      entry: response.entry,
      sourceAvailability: response.sourceAvailability,
      history: {
        mutations: response.history.mutations,
        nextCursor:
          response.history.nextBeforeRevision === null
            ? null
            : String(response.history.nextBeforeRevision),
      },
      actors: response.actors.map(ledgerActorLabelFromMirror),
    },
    // Another device's or a teammate's source never opens here.
    source: { availability: response.sourceAvailability, target: null },
  };
}

/** Search text is cut to the Ledger's query limit, in code points. */
const LEDGER_VIEW_QUERY_MAX_CODE_POINTS = 256;

/** Query text as the Ledger accepts it: no control characters, bounded. */
export function normalizeLedgerViewQuery(text: string): string {
  let result = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    result +=
      codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? ' '
        : character;
  }
  return Array.from(result.trim())
    .slice(0, LEDGER_VIEW_QUERY_MAX_CODE_POINTS)
    .join('')
    .trim();
}
