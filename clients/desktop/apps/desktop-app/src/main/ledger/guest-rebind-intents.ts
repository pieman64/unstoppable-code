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
 *                     "recordedAt": "<RFC 3339>" }] }
 *
 * Only the desktop main process writes it, and only once the database
 * exists. Writes are serialized in process and atomic, through the same file
 * as the lifecycle journal.
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

/** The journal's rebinds; an unreadable journal holds none. */
function parseJournal(raw: string | null): LedgerGuestRebindIntent[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== JOURNAL_VERSION ||
    !Array.isArray(parsed.rebinds)
  ) {
    return [];
  }
  const entries: readonly unknown[] = parsed.rebinds;
  return entries.flatMap((entry) => {
    const intent = parseIntent(entry);
    return intent === null ? [] : [intent];
  });
}

function serializeJournal(rebinds: readonly LedgerGuestRebindIntent[]): string {
  return `${JSON.stringify({ version: JOURNAL_VERSION, rebinds }, null, 2)}\n`;
}

export interface LedgerGuestRebindJournal {
  /** Durably records a rebind, once. Rejects when it cannot be written. */
  record(rebind: LedgerGuestRebind): Promise<void>;
  /** The rebinds still to apply, oldest first. */
  pending(): Promise<readonly LedgerGuestRebind[]>;
  /** Durably removes a rebind once it is applied. */
  remove(rebind: LedgerGuestRebind): Promise<void>;
}

export function createLedgerGuestRebindJournal(
  file: LedgerLifecycleIntentFile,
  now: () => Date = (): Date => new Date(),
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
  const read = async (): Promise<LedgerGuestRebindIntent[]> =>
    parseJournal(await file.read());

  return {
    record: (rebind) =>
      serialize(async (): Promise<void> => {
        const rebinds = await read();
        if (rebinds.some((existing) => sameRebind(existing, rebind))) return;
        await file.replace(
          serializeJournal([
            ...rebinds,
            {
              fromAccountId: rebind.fromAccountId,
              toAccountId: rebind.toAccountId,
              recordedAt: now().toISOString(),
            },
          ]),
        );
      }),
    pending: () =>
      serialize(
        async (): Promise<readonly LedgerGuestRebind[]> =>
          (await read()).map(({ fromAccountId, toAccountId }) => ({
            fromAccountId,
            toAccountId,
          })),
      ),
    remove: (rebind) =>
      serialize(async (): Promise<void> => {
        const rebinds = await read();
        const next = rebinds.filter(
          (existing) => !sameRebind(existing, rebind),
        );
        if (next.length < rebinds.length) {
          await file.replace(serializeJournal(next));
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
