import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
// Only the pure time helper: the store itself runs in the storage worker.
import { canonicalizeLedgerInstant } from '@canopy/desktop-shared/node/ledger/time';
import {
  damagedCopiesOf,
  pruneDamagedCopies,
} from '@canopy/desktop-shared/node/lib/damaged-copies';
import { renameWithRetry } from '../lib/atomic-file';
import { fsyncDirectory } from '../lib/fsync-directory';
import { isRecord } from '../lib/type-guards';
import type { LedgerContainerIncarnation } from './lifecycle';
import { isSafeLedgerContainerId } from './lifecycle-containers';
import { ledgerContainerKey } from './scope-bindings';

/*
 * The Ledger lifecycle's durable intent journal: `lifecycle-intents.json`
 * beside the Ledger database, never inside the SQLite files.
 *
 * Some host commits leave the only record of where a container went in
 * memory. A restore purges the archive that maps the archived container to
 * the restored one, and a move can give the worktree a suffixed ID that no
 * later search finds. Before such a commit the host records an intent:
 *
 * - `rebind`: the archived incarnation's scope moves to the restored one;
 * - `move`: the source incarnation's scope moves to the destination.
 *
 * The participant applies the intent after the commit and removes it. The
 * startup pass replays whatever remains, checking persistence first. Intents
 * can chain: a container restored and then moved, or moved twice, before its
 * participants ran records hops whose destination is the next hop's source.
 * The pass follows each chain to where the container is now and moves the
 * scope straight there before it clears the chain, and no scope retires while
 * an unresolved chain names its container.
 *
 * Format, version 1:
 *
 *     { "version": 1,
 *       "intents": [{ "kind": "rebind" | "move",
 *                     "from": { "container": …, "containerCreatedAt": … },
 *                     "to": { "container": …, "containerCreatedAt": … },
 *                     "recordedAt": "<RFC 3339>",
 *                     "conflicted"?: true }],
 *       "damagedAt"?: "<RFC 3339>" }
 *
 * Only the desktop main process writes it, and only once the database
 * exists, so it never creates the Ledger directory. A host waits for the
 * write for a bounded time only; a slower write still completes, and quit
 * waits for it. Writes are serialized in process and atomic: a synced
 * temporary file renamed over the journal, then a synced directory. A write
 * that is not synced whole fails, so a host never relies on it.
 *
 * Every intent in the journal is pending work, and none is ever dropped to
 * make room: participants remove the intents they apply, and the startup pass
 * the ones it resolves or proves never committed, while an unresolved chain
 * stays whole. At most `DEFAULT_MAX_INTENTS` intents are kept. Recording one
 * that matches an earlier intent replaces it; recording past the bound is
 * refused (`full`), and the host learns that its intent is not durable. A
 * restore then keeps its archive, whose `restoredTo` still maps the container,
 * and a move refuses, so it can be retried.
 *
 * A restore whose destination already has a ledger of its own can never be
 * applied: ledgers cannot merge. Its intent stays, marked `conflicted`, so the
 * archived scope is kept, read-only, for as long as the restored container
 * exists, instead of being retired as a container that is gone. Replay skips
 * conflicted intents, and the startup pass drops one once its scope is gone.
 *
 * Losing an intent can lose a ledger: the startup pass would retire a scope
 * whose container is gone, although the lost intent says where it went. So
 * nothing the journal holds is ever dropped for being unreadable. An entry
 * this version cannot read is kept verbatim, for a version that can, and
 * while any is kept the journal reports a gap that covers every scope. A
 * journal that cannot be parsed at all is copied aside to
 * `<name>.corrupt-<time>` (the newest five copies are kept), then replaced
 * by an empty one marked `damagedAt`:
 * any intent recorded until then may be lost, so the gap covers every scope
 * created by then. The startup pass retires no scope a gap covers; it keeps
 * it instead. New intents are recorded as usual, since the journal can hold
 * them durably. `damagedAt` is never cleared. A journal written by a newer
 * version is never overwritten.
 */

export type LedgerLifecycleIntentKind = 'rebind' | 'move';

export interface LedgerLifecycleIntent {
  readonly kind: LedgerLifecycleIntentKind;
  readonly from: LedgerContainerIncarnation;
  readonly to: LedgerContainerIncarnation;
  /** When the host recorded it (RFC 3339). */
  readonly recordedAt: string;
  /**
   * Set once the intent can never be applied, because `to` already has a
   * ledger of its own. Ledgers cannot merge, so the intent stays only to
   * keep `from`'s scope from being retired while `to` exists. Replay skips it.
   */
  readonly conflicted?: true;
}

/** What identifies an intent: its kind and both incarnations. */
export type LedgerLifecycleIntentKey = Pick<
  LedgerLifecycleIntent,
  'kind' | 'from' | 'to'
>;

/**
 * How recording an intent went: `recorded` durably, or `full`: refused, since
 * the journal holds its bound of pending intents.
 */
export type LedgerLifecycleIntentAddResult = 'recorded' | 'full';

/**
 * Which scopes an intent the journal may have lost could name: `none`; every
 * scope created by `since`, when a damaged journal was set aside then; or
 * `any`, while the journal holds entries this version cannot read.
 */
export type LedgerIntentJournalGap =
  | { readonly kind: 'none' }
  | { readonly kind: 'created_by'; readonly since: string }
  | { readonly kind: 'any' };

/** The journal as read: `unreadable` proves nothing either way. */
export type LedgerLifecycleIntentRead =
  | {
      readonly status: 'ok';
      /** The intents this version can read, oldest first. */
      readonly intents: readonly LedgerLifecycleIntent[];
      readonly gap: LedgerIntentJournalGap;
    }
  | { readonly status: 'unreadable' };

/**
 * Whether a gap covers a scope created at `scopeCreatedAt`: an intent the
 * journal may have lost could then name it. True when a time cannot be read.
 */
export function ledgerIntentGapCovers(
  gap: LedgerIntentJournalGap,
  scopeCreatedAt: string,
): boolean {
  if (gap.kind === 'none') return false;
  if (gap.kind === 'any') return true;
  const created = Date.parse(scopeCreatedAt);
  const since = Date.parse(gap.since);
  if (!Number.isFinite(created) || !Number.isFinite(since)) return true;
  return created <= since;
}

/** The journal's file, as the journal reads and replaces it. */
export interface LedgerLifecycleIntentFile {
  /** The file's content, or null when there is no file. */
  read(): Promise<string | null>;
  /** Replaces the file atomically and durably, or rejects. */
  replace(content: string): Promise<void>;
  /**
   * Durably saves a damaged journal's content beside the file, under a name
   * unique to `detectedAt`, leaving the file itself in place.
   */
  preserveDamaged(content: string, detectedAt: string): Promise<void>;
}

export interface LedgerLifecycleIntentJournalOptions {
  readonly file: LedgerLifecycleIntentFile;
  /** Pending intents kept at most; recording past it is refused. */
  readonly maxIntents?: number;
  /** Told, without content, that a damaged journal was set aside. */
  readonly onQuarantine?: () => void;
  /** The clock that stamps a damaged journal's `damagedAt`. */
  readonly now?: () => Date;
}

/** A refused journal operation, named by a content-free reason. */
export class LedgerLifecycleIntentError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Ledger lifecycle intent journal refused: ${reason}`);
    this.name = 'LedgerLifecycleIntentError';
    this.reason = reason;
  }
}

export const DEFAULT_MAX_INTENTS = 1024;
const JOURNAL_VERSION = 1;
const UNREADABLE: LedgerLifecycleIntentRead = { status: 'unreadable' };
const INTENT_KINDS: readonly LedgerLifecycleIntentKind[] = ['rebind', 'move'];

function canonicalInstant(value: string): string {
  return canonicalizeLedgerInstant(value) ?? value;
}

/**
 * An incarnation's identity: its container and its creation time as an
 * instant, whatever the spelling.
 */
export function ledgerIncarnationKey(
  incarnation: LedgerContainerIncarnation,
): string {
  return JSON.stringify([
    ledgerContainerKey(incarnation.container),
    canonicalInstant(incarnation.containerCreatedAt),
  ]);
}

/**
 * An intent's identity: its kind and both incarnations' identities. Intents
 * with one identity move the same incarnation to the same place, so the
 * journal keeps only one of them.
 */
export function ledgerIntentIdentity(intent: LedgerLifecycleIntentKey): string {
  return JSON.stringify([
    intent.kind,
    ledgerIncarnationKey(intent.from),
    ledgerIncarnationKey(intent.to),
  ]);
}

function safeId(value: unknown): string | null {
  return typeof value === 'string' && isSafeLedgerContainerId(value)
    ? value
    : null;
}

function parseContainer(value: unknown): LedgerContainer | null {
  if (!isRecord(value)) return null;
  switch (value.kind) {
    case 'code_worktree': {
      const workspaceId = safeId(value.workspaceId);
      const worktreeId = safeId(value.worktreeId);
      return workspaceId === null || worktreeId === null
        ? null
        : { kind: 'code_worktree', workspaceId, worktreeId };
    }
    case 'cowork_entry': {
      const workspaceId = safeId(value.workspaceId);
      const entryId = safeId(value.entryId);
      return workspaceId === null || entryId === null
        ? null
        : { kind: 'cowork_entry', workspaceId, entryId };
    }
    case 'advisor_entry': {
      const entryId = safeId(value.entryId);
      return value.appWorkspaceId !== APP_ADVISOR_PROJECT_ID || entryId === null
        ? null
        : {
            kind: 'advisor_entry',
            appWorkspaceId: APP_ADVISOR_PROJECT_ID,
            entryId,
          };
    }
    default:
      return null;
  }
}

function parseIncarnation(value: unknown): LedgerContainerIncarnation | null {
  if (!isRecord(value)) return null;
  const container = parseContainer(value.container);
  const createdAt = value.containerCreatedAt;
  if (
    container === null ||
    typeof createdAt !== 'string' ||
    canonicalizeLedgerInstant(createdAt) === null
  ) {
    return null;
  }
  return { container, containerCreatedAt: createdAt };
}

function parseIntent(value: unknown): LedgerLifecycleIntent | null {
  if (!isRecord(value) || typeof value.recordedAt !== 'string') return null;
  const kind = INTENT_KINDS.find((candidate) => candidate === value.kind);
  const from = parseIncarnation(value.from);
  const to = parseIncarnation(value.to);
  if (kind === undefined || from === null || to === null) return null;
  return {
    kind,
    from,
    to,
    recordedAt: value.recordedAt,
    ...(value.conflicted === true ? { conflicted: true } : {}),
  };
}

/** The journal's content, as this version holds it. */
interface LedgerIntentJournalState {
  /** The intents this version can read, oldest first. */
  readonly intents: LedgerLifecycleIntent[];
  /** Entries this version cannot read, kept verbatim for one that can. */
  readonly unreadable: readonly unknown[];
  /** When a damaged journal was set aside, so intents may be lost. */
  readonly damagedAt?: string;
}

/**
 * A journal's content, `corrupt` when it cannot be read as one, or `newer`
 * when a newer version wrote it. An entry this version cannot read is kept
 * as it is.
 */
function parseJournal(
  raw: string,
): LedgerIntentJournalState | 'corrupt' | 'newer' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'corrupt';
  }
  if (!isRecord(parsed)) return 'corrupt';
  if (parsed.version !== JOURNAL_VERSION) {
    return typeof parsed.version === 'number' &&
      parsed.version > JOURNAL_VERSION
      ? 'newer'
      : 'corrupt';
  }
  if (!Array.isArray(parsed.intents)) return 'corrupt';
  const damagedAt = parsed.damagedAt;
  if (
    damagedAt !== undefined &&
    (typeof damagedAt !== 'string' ||
      canonicalizeLedgerInstant(damagedAt) === null)
  ) {
    return 'corrupt';
  }
  const entries: readonly unknown[] = parsed.intents;
  const intents: LedgerLifecycleIntent[] = [];
  const unreadable: unknown[] = [];
  for (const entry of entries) {
    const intent = parseIntent(entry);
    if (intent === null) unreadable.push(entry);
    else intents.push(intent);
  }
  return damagedAt === undefined
    ? { intents, unreadable }
    : { intents, unreadable, damagedAt };
}

function serializeJournal(state: LedgerIntentJournalState): string {
  return `${JSON.stringify(
    {
      version: JOURNAL_VERSION,
      intents: [...state.intents, ...state.unreadable],
      ...(state.damagedAt === undefined ? {} : { damagedAt: state.damagedAt }),
    },
    null,
    2,
  )}\n`;
}

function gapOf(state: LedgerIntentJournalState): LedgerIntentJournalGap {
  if (state.unreadable.length > 0) return { kind: 'any' };
  return state.damagedAt === undefined
    ? { kind: 'none' }
    : { kind: 'created_by', since: state.damagedAt };
}

/**
 * The durable intent journal. Every operation runs after the previous one
 * settles, and the journal keeps the last content it read or wrote, since
 * nothing else writes the file.
 */
export class LedgerLifecycleIntentJournal {
  private readonly file: LedgerLifecycleIntentFile;
  private readonly maxIntents: number;
  private readonly onQuarantine: (() => void) | undefined;
  private readonly now: () => Date;
  private tail: Promise<void> = Promise.resolve();
  /**
   * The journal's content once read; undefined before the first read, and
   * again after a write that failed, which may or may not have landed.
   */
  private state: LedgerIntentJournalState | undefined;

  constructor(options: LedgerLifecycleIntentJournalOptions) {
    this.file = options.file;
    this.maxIntents = Math.max(1, options.maxIntents ?? DEFAULT_MAX_INTENTS);
    this.onQuarantine = options.onQuarantine;
    this.now = options.now ?? ((): Date => new Date());
  }

  /** Every pending intent this version can read, and the gap. Never rejects. */
  read(): Promise<LedgerLifecycleIntentRead> {
    return this.serialize(async (): Promise<LedgerLifecycleIntentRead> => {
      try {
        const state = await this.load();
        return state === null
          ? UNREADABLE
          : { status: 'ok', intents: [...state.intents], gap: gapOf(state) };
      } catch {
        return UNREADABLE;
      }
    });
  }

  /**
   * Durably records an intent, replacing one that matches it. Refuses, with
   * `full`, an intent that would take the journal past its bound: no pending
   * intent is ever dropped to make room. Rejects when the journal cannot be
   * written, leaving it as it was.
   */
  add(intent: LedgerLifecycleIntent): Promise<LedgerLifecycleIntentAddResult> {
    return this.serialize(async (): Promise<LedgerLifecycleIntentAddResult> => {
      const state = await this.load();
      if (state === null) {
        throw new LedgerLifecycleIntentError('INTENT_JOURNAL_NEWER');
      }
      const identity = ledgerIntentIdentity(intent);
      const next = state.intents.filter(
        (existing) => ledgerIntentIdentity(existing) !== identity,
      );
      if (next.length + state.unreadable.length >= this.maxIntents) {
        // A matching intent is already durable as it is.
        return next.length < state.intents.length ? 'recorded' : 'full';
      }
      next.push(intent);
      await this.write({ ...state, intents: next });
      return 'recorded';
    });
  }

  /**
   * Durably marks an intent conflicted, recording it conflicted when the
   * journal does not hold it yet (the host's own write may have failed).
   * Refuses, with `full`, only a new entry past the bound.
   */
  markConflicted(
    intent: LedgerLifecycleIntentKey,
    recordedAt: string,
  ): Promise<LedgerLifecycleIntentAddResult> {
    return this.serialize(async (): Promise<LedgerLifecycleIntentAddResult> => {
      const state = await this.load();
      if (state === null) {
        throw new LedgerLifecycleIntentError('INTENT_JOURNAL_NEWER');
      }
      const intents = state.intents;
      const identity = ledgerIntentIdentity(intent);
      const index = intents.findIndex(
        (existing) => ledgerIntentIdentity(existing) === identity,
      );
      const existing = index === -1 ? undefined : intents[index];
      if (existing?.conflicted === true) return 'recorded';
      if (
        existing === undefined &&
        intents.length + state.unreadable.length >= this.maxIntents
      ) {
        return 'full';
      }
      const conflicted: LedgerLifecycleIntent = {
        kind: intent.kind,
        from: intent.from,
        to: intent.to,
        recordedAt: existing?.recordedAt ?? recordedAt,
        conflicted: true,
      };
      const next =
        existing === undefined
          ? [...intents, conflicted]
          : intents.map((entry, position) =>
              position === index ? conflicted : entry,
            );
      await this.write({ ...state, intents: next });
      return 'recorded';
    });
  }

  /** Durably removes the intents that match. True when one was removed. */
  remove(intent: LedgerLifecycleIntentKey): Promise<boolean> {
    return this.removeAll([intent]).then((removed) => removed > 0);
  }

  /**
   * Durably removes every intent that matches one of `intents`, in a single
   * write. Resolves to how many were removed.
   */
  removeAll(intents: readonly LedgerLifecycleIntentKey[]): Promise<number> {
    return this.serialize(async (): Promise<number> => {
      const state = await this.load();
      if (state === null) return 0;
      const removing = new Set(intents.map(ledgerIntentIdentity));
      const next = state.intents.filter(
        (existing) => !removing.has(ledgerIntentIdentity(existing)),
      );
      const removed = state.intents.length - next.length;
      if (removed > 0) await this.write({ ...state, intents: next });
      return removed;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  }

  /** The current content, or null when a newer version wrote the journal. */
  private async load(): Promise<LedgerIntentJournalState | null> {
    if (this.state !== undefined) return this.state;
    const raw = await this.file.read();
    if (raw === null) {
      this.state = { intents: [], unreadable: [] };
      return this.state;
    }
    const parsed = parseJournal(raw);
    if (parsed === 'newer') return null;
    if (parsed === 'corrupt') return this.setAsideDamaged(raw);
    this.state = parsed;
    return this.state;
  }

  /**
   * Keeps a damaged journal's content aside, then replaces the journal with
   * an empty one marked damaged now. In that order, an exit between the two
   * leaves the damaged journal in place, to be set aside again.
   */
  private async setAsideDamaged(
    raw: string,
  ): Promise<LedgerIntentJournalState> {
    const damagedAt = this.now().toISOString();
    await this.file.preserveDamaged(raw, damagedAt);
    const fresh: LedgerIntentJournalState = {
      intents: [],
      unreadable: [],
      damagedAt,
    };
    await this.write(fresh);
    this.onQuarantine?.();
    return fresh;
  }

  private async write(state: LedgerIntentJournalState): Promise<void> {
    try {
      await this.file.replace(serializeJournal(state));
    } catch (error) {
      // The file may hold either content now: read it again next time.
      this.state = undefined;
      throw error;
    }
    this.state = state;
  }
}

function isMissingPath(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'ENOENT';
}

/**
 * Writes a complete, synced sibling file, then renames it over `path`. The
 * directory is created first, as for every persisted file; the journal is
 * only written once the Ledger database exists, so this never brings the
 * Ledger directory into being on its own.
 */
async function replaceDurably(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let installed = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, path);
    installed = true;
  } finally {
    if (!installed) await unlink(temporary).catch(() => undefined);
  }
  // Until the directory is synced, a crash can undo the rename, so a failure
  // here fails the write. On Windows, where Node cannot open a directory,
  // `fsyncDirectory` does nothing.
  await fsyncDirectory(directory);
}

/** The journal's file at `path`, for the desktop. */
export function createLedgerLifecycleIntentFile(
  path: string,
): LedgerLifecycleIntentFile {
  return {
    read: async (): Promise<string | null> => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (isMissingPath(error)) return null;
        throw error;
      }
    },
    replace: (content: string): Promise<void> => replaceDurably(path, content),
    preserveDamaged: async (
      content: string,
      detectedAt: string,
    ): Promise<void> => {
      await replaceDurably(
        `${path}.corrupt-${detectedAt.replace(/[^0-9A-Za-z]/g, '-')}`,
        content,
      );
      await pruneDamagedCopies(damagedCopiesOf(path, '.corrupt-'));
    },
  };
}
