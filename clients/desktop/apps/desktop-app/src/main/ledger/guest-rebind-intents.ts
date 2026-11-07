import { canonicalizeLedgerInstant } from '@canopy/desktop-shared/node/ledger/time';
import { isRecord } from '../lib/type-guards';
import type { LedgerLifecycleIntentFile } from './lifecycle-intents';

/*
 * Pending guest rebinds (LD02): `guest-rebind-intents.json` beside the Ledger
 * database. Once the server merges a guest into the account that signed in,
 * the only record of the guest's ID is the desktop's memory, and the guest's
 * local scopes must move to the new account to sync again. The host records
 * the rebind here before it reports the sign-in, applies it, then removes it.
 * One that a quit or an unavailable storage worker interrupts stays here, and
 * the next time sync starts it is applied again. Applying one twice moves
 * nothing more.
 *
 * Format, version 1:
 *
 *     { "version": 1,
 *       "rebinds": [{ "fromAccountId": …, "toAccountId": …,
 *                     "recordedAt": "<RFC 3339>" }],
 *       "damagedAt"?: "<RFC 3339>" }
 *
 * Only the desktop main process writes it, and only once the database
 * exists. Writes are serialized in process and atomic, through the same file
 * as the lifecycle journal.
 *
 * As in the lifecycle journal, unreadable entries are kept for a version
 * that can read them. A malformed journal is durably copied aside before
 * replacing it with an empty one marked `damagedAt`; that marker stays.
 * A journal from a newer version is never overwritten. Each gap reports
 * only a content-free reason, never the journal's content or account IDs.
 */

export interface LedgerGuestRebind {
  readonly fromAccountId: string;
  readonly toAccountId: string;
}

interface LedgerGuestRebindIntent extends LedgerGuestRebind {
  readonly recordedAt: string;
}

const JOURNAL_VERSION = 1;

function sameRebind(
  left: LedgerGuestRebind,
  right: LedgerGuestRebind,
): boolean {
  return (
    left.fromAccountId === right.fromAccountId &&
    left.toAccountId === right.toAccountId
  );
}

function parseIntent(value: unknown): LedgerGuestRebindIntent | null {
  if (
    !isRecord(value) ||
    typeof value.fromAccountId !== 'string' ||
    typeof value.toAccountId !== 'string' ||
    typeof value.recordedAt !== 'string'
  ) {
    return null;
  }
  return {
    fromAccountId: value.fromAccountId,
    toAccountId: value.toAccountId,
    recordedAt: value.recordedAt,
  };
}

interface LedgerGuestRebindJournalState {
  readonly rebinds: readonly LedgerGuestRebindIntent[];
  readonly unreadable: readonly unknown[];
  readonly damagedAt?: string;
}

function parseJournal(
  raw: string,
): LedgerGuestRebindJournalState | 'corrupt' | 'newer' {
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
  if (!Array.isArray(parsed.rebinds)) return 'corrupt';
  const damagedAt = parsed.damagedAt;
  if (
    damagedAt !== undefined &&
    (typeof damagedAt !== 'string' ||
      canonicalizeLedgerInstant(damagedAt) === null)
  ) {
    return 'corrupt';
  }
  const entries: readonly unknown[] = parsed.rebinds;
  const rebinds: LedgerGuestRebindIntent[] = [];
  const unreadable: unknown[] = [];
  for (const entry of entries) {
    const intent = parseIntent(entry);
    if (intent === null) unreadable.push(entry);
    else rebinds.push(intent);
  }
  return damagedAt === undefined
    ? { rebinds, unreadable }
    : { rebinds, unreadable, damagedAt };
}

function serializeJournal(state: LedgerGuestRebindJournalState): string {
  return `${JSON.stringify(
    {
      version: JOURNAL_VERSION,
      rebinds: [...state.rebinds, ...state.unreadable],
      ...(state.damagedAt === undefined ? {} : { damagedAt: state.damagedAt }),
    },
    null,
    2,
  )}\n`;
}

export interface LedgerGuestRebindJournal {
  /** Durably records a rebind, once. Rejects when it cannot be written. */
  record(rebind: LedgerGuestRebind): Promise<void>;
  /** The readable rebinds still to apply, oldest first. Rejects on read failure. */
  pending(): Promise<readonly LedgerGuestRebind[]>;
  /** Durably removes a rebind once it is applied. */
  remove(rebind: LedgerGuestRebind): Promise<void>;
}

/** A refused journal operation, named by a content-free reason. */
export class LedgerGuestRebindIntentError extends Error {
  readonly reason = 'INTENT_JOURNAL_NEWER';

  constructor() {
    super('Ledger guest rebind intent journal refused: INTENT_JOURNAL_NEWER');
    this.name = 'LedgerGuestRebindIntentError';
  }
}

export interface LedgerGuestRebindJournalOptions {
  readonly now?: () => Date;
  readonly onJournalFailure?: (
    detail:
      | 'INTENT_JOURNAL_QUARANTINED'
      | 'INTENT_JOURNAL_NEWER'
      | 'INTENT_ENTRIES_UNREADABLE',
  ) => void;
}

export function createLedgerGuestRebindJournal(
  file: LedgerLifecycleIntentFile,
  {
    now = (): Date => new Date(),
    onJournalFailure,
  }: LedgerGuestRebindJournalOptions = {},
): LedgerGuestRebindJournal {
  let tail: Promise<void> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      (): void => undefined,
      (): void => undefined,
    );
    return result;
  };
  const read = async (): Promise<LedgerGuestRebindJournalState> => {
    const raw = await file.read();
    if (raw === null) return { rebinds: [], unreadable: [] };
    const state = parseJournal(raw);
    if (state === 'newer') {
      onJournalFailure?.('INTENT_JOURNAL_NEWER');
      throw new LedgerGuestRebindIntentError();
    }
    if (state === 'corrupt') {
      const damagedAt = now().toISOString();
      // Preserve first: an exit between these writes leaves the original.
      await file.preserveDamaged(raw, damagedAt);
      const fresh: LedgerGuestRebindJournalState = {
        rebinds: [],
        unreadable: [],
        damagedAt,
      };
      await file.replace(serializeJournal(fresh));
      onJournalFailure?.('INTENT_JOURNAL_QUARANTINED');
      return fresh;
    }
    if (state.unreadable.length > 0) {
      onJournalFailure?.('INTENT_ENTRIES_UNREADABLE');
    }
    return state;
  };

  return {
    record: (rebind) =>
      serialize(async (): Promise<void> => {
        const state = await read();
        const rebinds = state.rebinds;
        if (rebinds.some((existing) => sameRebind(existing, rebind))) return;
        await file.replace(
          serializeJournal({
            ...state,
            rebinds: [
              ...rebinds,
              {
                fromAccountId: rebind.fromAccountId,
                toAccountId: rebind.toAccountId,
                recordedAt: now().toISOString(),
              },
            ],
          }),
        );
      }),
    pending: () =>
      serialize(
        async (): Promise<readonly LedgerGuestRebind[]> =>
          (await read()).rebinds.map(({ fromAccountId, toAccountId }) => ({
            fromAccountId,
            toAccountId,
          })),
      ),
    remove: (rebind) =>
      serialize(async (): Promise<void> => {
        const state = await read();
        const rebinds = state.rebinds;
        const next = rebinds.filter(
          (existing) => !sameRebind(existing, rebind),
        );
        if (next.length < rebinds.length) {
          await file.replace(serializeJournal({ ...state, rebinds: next }));
        }
      }),
  };
}

export interface LedgerGuestRebinderOptions {
  readonly journal: LedgerGuestRebindJournal;
  readonly databaseExists: () => Promise<boolean>;
  /** Moves the guest's scopes to the account; rejects when it cannot. */
  readonly rebind: (rebind: LedgerGuestRebind) => Promise<void>;
  /** Why a rebind could not be applied; it stays pending. */
  readonly onRebindError: (error: unknown) => void;
  /** A content-free reason the journal could not be read or written. */
  readonly onJournalFailure: (detail: string) => void;
}

export interface LedgerGuestRebinder {
  /**
   * Records a merged guest's rebind, then applies it in the background.
   * Resolves once the rebind is durable, or could not be made so. Never
   * rejects.
   */
  record(fromAccountId: string, toAccountId: string): Promise<void>;
  /** Applies every rebind still pending. Never rejects. */
  replay(): Promise<void>;
}

export function createLedgerGuestRebinder(
  options: LedgerGuestRebinderOptions,
): LedgerGuestRebinder {
  const apply = async (rebind: LedgerGuestRebind): Promise<void> => {
    try {
      await options.rebind(rebind);
    } catch (error) {
      options.onRebindError(error);
      return;
    }
    await options.journal.remove(rebind).catch((): void => {
      // Still pending: applying it again moves nothing more.
      options.onJournalFailure('INTENT_NOT_REMOVED');
    });
  };

  return {
    record: async (fromAccountId, toAccountId): Promise<void> => {
      const rebind: LedgerGuestRebind = {
        fromAccountId: fromAccountId.trim(),
        toAccountId: toAccountId.trim(),
      };
      if (
        rebind.fromAccountId.length === 0 ||
        rebind.toAccountId.length === 0 ||
        rebind.fromAccountId === rebind.toAccountId
      ) {
        return;
      }
      if (!(await options.databaseExists().catch((): boolean => false))) {
        return;
      }
      try {
        await options.journal.record(rebind);
      } catch {
        // Not durable, but this launch can still apply it.
        options.onJournalFailure('INTENT_NOT_RECORDED');
      }
      void apply(rebind);
    },
    replay: async (): Promise<void> => {
      if (!(await options.databaseExists().catch((): boolean => false))) {
        return;
      }
      let pending: readonly LedgerGuestRebind[];
      try {
        pending = await options.journal.pending();
      } catch {
        options.onJournalFailure('INTENT_UNREADABLE');
        return;
      }
      for (const rebind of pending) await apply(rebind);
    },
  };
}
