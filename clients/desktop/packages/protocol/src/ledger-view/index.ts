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
  LedgerOwnerCandidatePage,
  LedgerSourceAvailability,
  LedgerStatus,
  LedgerUpdateEntryParams,
} from '../canopy-core';
import type { LedgerScopeKind } from '../ledger-sync';

/**
 * The work scope a view reads: a panel layout's project and worktree, where a
 * Cowork or App Advisor Work Entry occupies the worktree slot.
 */
export interface LedgerViewScope {
  readonly projectId: string;
  readonly worktreeId: string;
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
       * one is known.
       */
      readonly kind: 'pipeline';
      readonly projectId: string;
      readonly worktreeId: string;
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

/** One entry in the Feed, with where it was recorded. */
export interface LedgerFeedRow {
  readonly entry: LedgerEntrySearchItem;
  readonly ledgerId: string;
  /** What kind of work the entry belongs to. */
  readonly scopeKind: LedgerScopeKind;
  readonly scopeArchived: boolean;
  readonly origin: LedgerFeedOrigin;
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
