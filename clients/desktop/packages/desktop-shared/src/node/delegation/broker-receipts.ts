import { AsyncLocalStorage } from 'node:async_hooks';
import type { StoredDelegation } from './broker';
import type {
  StoredDelegationV3,
  StoredDelegationV3Control,
  V3CommandReceiptEntry,
  V3StopReceiptEntry,
} from './record-v3';
import { canonicalDelegationJson } from './settlement-identity';
import type {
  DelegationTranscriptPortErrorCode,
  DelegationTranscriptPortResult,
  DelegationTranscriptReceiptAppendResult,
  DelegationTranscriptReceiptEntry,
  DelegationTranscriptReceiptIdentity,
} from './transcript-port';

/** E5: infrastructure failures are never fitted as admission receipts. */
export type ReceiptNotAdmittedCause =
  | 'lookup'
  | 'append'
  | 'pre_write'
  | 'uncertain_commit';

/**
 * E5: no admission is acknowledged and no new execution is dispatched. An
 * uncertain commit may already be durable, so it needs E1 recovery and is not
 * proof of canonical absence.
 */
export interface ReceiptNotAdmitted {
  readonly kind: 'not_admitted';
  readonly cause: ReceiptNotAdmittedCause;
  readonly code?: DelegationTranscriptPortErrorCode;
}

/** E5: construct an infrastructure result without inventing a receipt. */
export function receiptNotAdmitted(
  cause: ReceiptNotAdmittedCause,
  code?: DelegationTranscriptPortErrorCode,
): ReceiptNotAdmitted {
  return {
    kind: 'not_admitted',
    cause,
    ...(code === undefined ? {} : { code }),
  };
}

function thrownPortCode(
  error: unknown,
): DelegationTranscriptPortErrorCode | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  switch (error.code) {
    case 'invalid_request':
    case 'not_found':
    case 'unauthorized':
    case 'stale_identity':
    case 'conflict':
    case 'unsupported_format':
    case 'storage_failure':
    case 'corruption':
    case 'answer_unavailable':
      return error.code;
    default:
      return undefined;
  }
}

/** E4/E5: only a structured not_found establishes absence; throws never do. */
export function classifyRegistryLookup(
  read:
    | DelegationTranscriptPortResult<DelegationTranscriptReceiptEntry>
    | { readonly thrown: unknown },
):
  | { readonly kind: 'hit'; readonly entry: DelegationTranscriptReceiptEntry }
  | { readonly kind: 'absent' }
  | ReceiptNotAdmitted {
  if ('thrown' in read)
    return receiptNotAdmitted('lookup', thrownPortCode(read.thrown));
  if (read.ok) return { kind: 'hit', entry: read.value };
  return read.error.code === 'not_found'
    ? { kind: 'absent' }
    : receiptNotAdmitted('lookup', read.error.code);
}

/** E2: candidate-local receipts required by the strict v3 relationships. */
export interface ReceiptPins {
  readonly operationalKey?: string;
  readonly resumeWitnessKey?: string;
}

/** E2/B8: pin the operational control and latest successful-ack fence witness. */
export function receiptPins(candidate: StoredDelegationV3): ReceiptPins {
  const { commandReceipts, stopReceipts, activeStop, stopFence } =
    candidate.receipts;
  const operationalKey = candidate.control?.key;
  let witness: V3CommandReceiptEntry | undefined;
  if (
    stopReceipts.length > 0 &&
    activeStop === undefined &&
    stopFence === undefined
  ) {
    const latestStop = stopReceipts.reduce(
      (latest, receipt) => Math.max(latest, receipt.admittedAt),
      0,
    );
    for (const receipt of commandReceipts) {
      if (
        receipt.operation === 'resume' &&
        receipt.reply.ack.ok &&
        receipt.admittedAt > latestStop &&
        (witness === undefined || receipt.admittedAt >= witness.admittedAt)
      )
        witness = receipt;
    }
  }
  return {
    ...(operationalKey === undefined ? {} : { operationalKey }),
    ...(witness === undefined ? {} : { resumeWitnessKey: witness.key }),
  };
}

/** E2: only command and stop-alias windows participate in rollover. */
export type ReceiptWindowEntry = V3CommandReceiptEntry | V3StopReceiptEntry;

/** E2/B10: select the first eligible, byte-identical prior-durable entry. */
export function selectReceiptEvictee(
  priorWindow: readonly ReceiptWindowEntry[],
  candidateWindow: readonly ReceiptWindowEntry[],
  kind: ReceiptWindowEntry['receiptKind'],
  pins: ReceiptPins,
): number | undefined {
  const priorBytes = new Set(priorWindow.map(canonicalDelegationJson));
  const index = candidateWindow.findIndex((entry) => {
    if (entry.receiptKind !== kind) return false;
    if (entry.receiptKind === 'command') {
      if (
        entry.key === pins.operationalKey ||
        entry.key === pins.resumeWitnessKey
      )
        return false;
      if (
        entry.reply.ack.ok &&
        entry.reply.ack.outcome !== 'completed' &&
        entry.reply.final === null
      )
        return false;
    }
    return priorBytes.has(canonicalDelegationJson(entry));
  });
  return index < 0 ? undefined : index;
}

/** E3: command admission intent uses operation identity and its immutable key. */
export type ReceiptControlIdentity = Pick<
  StoredDelegationV3Control,
  'operationId' | 'key'
>;

/** E3: a decision for one incoming control, preserving incoming order. */
export interface ReceiptFitPlan {
  readonly control: ReceiptControlIdentity;
  readonly kind: 'fit' | 'finalize' | 'archived';
}

/** E3: transaction-local intent; stop aliases use their direct producers instead. */
export function planReceiptFits(input: {
  readonly priorWindowKeys: readonly string[];
  readonly priorControl?: ReceiptControlIdentity;
  readonly incomingControls: readonly ReceiptControlIdentity[];
  readonly admittedOperationIds: ReadonlySet<string>;
}): readonly ReceiptFitPlan[] {
  const keys = new Set(input.priorWindowKeys);
  return input.incomingControls.map((control): ReceiptFitPlan => {
    const admitted = input.admittedOperationIds.has(control.operationId);
    if (keys.has(control.key)) {
      if (admitted) {
        const prior = input.priorControl?.operationId === control.operationId;
        throw new Error(
          `Receipt admission defect: ${prior ? 'prior control' : 'operation'} already retained`,
        );
      }
      return { control, kind: 'finalize' };
    }
    return { control, kind: admitted ? 'fit' : 'archived' };
  });
}

/** E6: broker-scoped, non-reentrant serialization of chat receipt identities. */
export interface ChatReceiptLock {
  run<T>(
    identity: DelegationTranscriptReceiptIdentity,
    fn: () => Promise<T>,
  ): Promise<T>;
}

function receiptIdentityKey(
  identity: DelegationTranscriptReceiptIdentity,
): string {
  return JSON.stringify([identity.chatId, identity.receiptKind, identity.key]);
}

/** E6: serialize independent callers, rejecting nested ownership rather than deadlocking. */
export function createChatReceiptLock(): ChatReceiptLock {
  const tails = new Map<string, Promise<void>>();
  const context = new AsyncLocalStorage<
    readonly { key: string; active: boolean }[]
  >();
  return {
    async run<T>(
      identity: DelegationTranscriptReceiptIdentity,
      fn: () => Promise<T>,
    ): Promise<T> {
      const key = receiptIdentityKey(identity);
      const owners = context.getStore() ?? [];
      if (owners.some((owner) => owner.key === key && owner.active))
        throw new Error('Receipt lock defect: non-reentrant identity');
      const prior = tails.get(key) ?? Promise.resolve();
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = prior.then(() => released);
      tails.set(key, tail);
      await prior;
      const owner = { key, active: true };
      try {
        return await context.run([...owners, owner], fn);
      } finally {
        owner.active = false;
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
  };
}

/**
 * E1: archive before removing; callers validate the projected record before
 * append. Precondition: a prior window of at most 64 entries, and a candidate
 * that keeps them (finals aside) plus at most one new receipt.
 */
export async function rollOverReceipt<Entry extends ReceiptWindowEntry>(input: {
  readonly priorWindow: readonly Entry[];
  readonly candidateWindow: readonly Entry[];
  readonly kind: Entry['receiptKind'];
  readonly pins: ReceiptPins;
  readonly append: (
    entry: Entry,
  ) => Promise<
    DelegationTranscriptPortResult<DelegationTranscriptReceiptAppendResult>
  >;
}): Promise<
  | {
      readonly ok: true;
      readonly window: readonly Entry[];
      readonly archived: Entry | undefined;
    }
  | { readonly ok: false; readonly refused: 'capacity' }
  | ReceiptNotAdmitted
> {
  if (input.priorWindow.length > 64 || input.candidateWindow.length > 65)
    throw new Error(
      'Receipt rollover admits one receipt into a bounded window',
    );
  if (input.candidateWindow.length <= 64)
    return { ok: true, window: input.candidateWindow, archived: undefined };
  const index = selectReceiptEvictee(
    input.priorWindow,
    input.candidateWindow,
    input.kind,
    input.pins,
  );
  const entry = index === undefined ? undefined : input.candidateWindow[index];
  if (entry === undefined) return { ok: false, refused: 'capacity' };
  try {
    const appended = await input.append(entry);
    if (!appended.ok) return receiptNotAdmitted('append', appended.error.code);
  } catch (error) {
    return receiptNotAdmitted('append', thrownPortCode(error));
  }
  return {
    ok: true,
    window: input.candidateWindow.filter((_, position) => position !== index),
    archived: entry,
  };
}

/** E1/B9: restart-scoped mutation barriers and chat-key reservations, never mutexes. */
export class ReceiptQuarantine {
  private readonly delegations = new Set<string>();
  private readonly reservations = new Set<string>();

  quarantine(delegationId: string): void {
    this.delegations.add(delegationId);
  }

  isQuarantined(delegationId: string): boolean {
    return this.delegations.has(delegationId);
  }

  /** B2b only: a successful canonical reaffirm does not release reservations. */
  clearAfterOutboxReaffirm(delegationId: string): void {
    this.delegations.delete(delegationId);
  }

  reserve(identity: DelegationTranscriptReceiptIdentity): void {
    this.reservations.add(receiptIdentityKey(identity));
  }

  isReserved(identity: DelegationTranscriptReceiptIdentity): boolean {
    return this.reservations.has(receiptIdentityKey(identity));
  }
}

/** E9: callers pass only admission and first-resolution times, never replay or archival times. */
export function foldReceiptActivity(
  lastActivityAt: number,
  eventTimes: readonly number[],
): number {
  return eventTimes.reduce(
    (latest, time) => Math.max(latest, time),
    lastActivityAt,
  );
}

/**
 * E6: S1 implements updateAsync privately in broker.ts on the shared writes[id]
 * chain. Check quarantine after acquiring that chain and before prepare. No
 * nested update/updateAsync, chat-key lock acquisition, or D1 handoff in prepare.
 */
export interface AsyncRecordTransaction {
  updateAsync(
    id: string,
    prepare: (current: StoredDelegation) => Promise<StoredDelegation>,
  ): Promise<StoredDelegation>;
}
