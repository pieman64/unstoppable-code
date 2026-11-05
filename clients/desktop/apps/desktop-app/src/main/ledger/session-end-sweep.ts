import { createHash } from 'node:crypto';
import { isRecord } from '../lib/type-guards';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { canonicalizeLedgerInstant } from '@canopy/desktop-shared/node/ledger/time';
import type {
  LedgerActorKind,
  LedgerActorRef,
  LedgerContainer,
  LedgerEntrySearchItem,
} from '@canopy/protocol/canopy-core';
import { LEDGER_LIMITS } from '@canopy/protocol/canopy-core';
import type {
  LedgerActorRecord,
  LedgerScopeRecord,
} from '@canopy/desktop-shared/node/ledger';
import type { LedgerLifecycleIntentFile } from './lifecycle-intents';
import { notifyLedgerEntryChanged } from './change-events';
import type { LedgerStoreClient } from './ledger-store-client';
import { LedgerStorageHostError } from './storage-host';
import {
  readLedgerChatArchived,
  readLedgerDelegateGeneration,
  withLedgerDelegateSweepAdmission,
  type LedgerSessionEndActor,
  type LedgerSessionEndTransition,
} from './session-end-sweep-ports';

const JOURNAL_VERSION = 1;
const JOURNAL_LIMIT = 1_024;
const DEFAULT_BATCH_SIZE = 50;
const MAX_INTENT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_INTENT_LEDGER_IDS = 16;
const OPEN_STATUSES: readonly [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
] = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'NEEDS_REVIEW'];

interface SessionEndIntent extends LedgerSessionEndTransition {
  readonly identity: string;
  /**
   * The target's scopes when the intent was recorded, so replay still finds
   * a scope that a lifecycle relocation has since moved to another container.
   */
  readonly ledgerIds?: readonly string[];
}

interface SessionEndJournal {
  readonly version: 1;
  readonly intents: readonly SessionEndIntent[];
}

type JournalRead =
  | { readonly status: 'ok'; readonly intents: readonly SessionEndIntent[] }
  | { readonly status: 'unreadable' };

export interface LedgerSessionEndSweepOptions {
  readonly store: () => LedgerStoreClient;
  readonly statDatabase: () => Promise<{ isFile(): boolean }>;
  readonly file: LedgerLifecycleIntentFile;
  readonly recordFailure: (code: string) => void;
  readonly requestSync?: () => void;
  readonly yieldToEventLoop?: () => Promise<void>;
  readonly batchSize?: number;
  readonly now?: () => Date;
}

function transitionIdentity(transition: LedgerSessionEndTransition): string {
  return JSON.stringify([
    transition.target.projectId,
    transition.target.worktreeId,
    transition.actor.kind,
    transition.actor.originKey,
    transition.transitionKey,
    canonicalizeLedgerInstant(transition.transitionAt),
    transition.runGeneration ?? null,
  ]);
}

function safeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseLedgerIds(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > MAX_INTENT_LEDGER_IDS ||
    !value.every(safeString)
  ) {
    return null;
  }
  return value.filter(safeString);
}

function isActorKind(value: unknown): value is LedgerSessionEndActor['kind'] {
  return (
    value === 'chat' ||
    value === 'managed_delegation' ||
    value === 'pipeline_agent'
  );
}

function isReason(
  value: unknown,
): value is LedgerSessionEndTransition['reason'] {
  return (
    value === 'delegate_settled' ||
    value === 'pipeline_step_finished' ||
    value === 'chat_archived'
  );
}

function parseActor(value: unknown): LedgerSessionEndActor | null {
  if (
    !isRecord(value) ||
    !isActorKind(value.kind) ||
    !safeString(value.originKey)
  ) {
    return null;
  }
  const kind = value.kind;
  if (
    kind !== 'chat' &&
    kind !== 'managed_delegation' &&
    kind !== 'pipeline_agent'
  ) {
    return null;
  }
  return { kind, originKey: value.originKey };
}

function parseRecipient(
  value: unknown,
): LedgerSessionEndTransition['recipient'] | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'user') return { kind: 'user' };
  return parseActor(value);
}

function parseTransition(value: unknown): SessionEndIntent | null {
  if (!isRecord(value) || !isRecord(value.target)) {
    return null;
  }
  const actor = parseActor(value.actor);
  const recipient = parseRecipient(value.recipient);
  const reason = value.reason;
  const transitionAt = safeString(value.transitionAt)
    ? canonicalizeLedgerInstant(value.transitionAt)
    : null;
  if (
    actor === null ||
    recipient === null ||
    !safeString(value.target.projectId) ||
    !safeString(value.target.worktreeId) ||
    !isReason(reason) ||
    !safeString(value.transitionKey) ||
    transitionAt === null ||
    (value.runGeneration !== undefined &&
      (typeof value.runGeneration !== 'number' ||
        !Number.isSafeInteger(value.runGeneration) ||
        value.runGeneration < 0))
  ) {
    return null;
  }
  const transition: LedgerSessionEndTransition = {
    target: {
      projectId: value.target.projectId,
      worktreeId: value.target.worktreeId,
    },
    actor,
    recipient,
    reason,
    transitionKey: value.transitionKey,
    transitionAt,
    ...(value.runGeneration === undefined
      ? {}
      : { runGeneration: value.runGeneration }),
  };
  if (
    transition.actor.kind === 'managed_delegation' &&
    transition.runGeneration === undefined
  ) {
    return null;
  }
  if (
    (transition.actor.kind === 'managed_delegation' &&
      transition.reason !== 'delegate_settled') ||
    (transition.actor.kind === 'pipeline_agent' &&
      transition.reason !== 'pipeline_step_finished') ||
    (transition.actor.kind === 'chat' && transition.reason !== 'chat_archived')
  ) {
    return null;
  }
  const identity = transitionIdentity(transition);
  if (value.ledgerIds === undefined) return { ...transition, identity };
  const ledgerIds = parseLedgerIds(value.ledgerIds);
  return ledgerIds === null ? null : { ...transition, identity, ledgerIds };
}

function readJournal(raw: string | null): JournalRead {
  if (raw === null) return { status: 'ok', intents: [] };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { status: 'unreadable' };
  }
  if (
    !isRecord(value) ||
    value.version !== JOURNAL_VERSION ||
    !Array.isArray(value.intents)
  ) {
    return { status: 'unreadable' };
  }
  const rawIntents: readonly unknown[] = value.intents;
  const intents: SessionEndIntent[] = [];
  for (const rawIntent of rawIntents) {
    if (!isRecord(rawIntent)) return { status: 'unreadable' };
    const parsed = parseTransition(rawIntent);
    if (parsed === null || parsed.identity !== rawIntent.identity) {
      return { status: 'unreadable' };
    }
    intents.push(parsed);
  }
  return { status: 'ok', intents };
}

function serializeJournal(intents: readonly SessionEndIntent[]): string {
  const journal: SessionEndJournal = { version: JOURNAL_VERSION, intents };
  return `${JSON.stringify(journal, null, 2)}\n`;
}

function actorOriginKey(actor: {
  readonly kind: LedgerActorKind;
  readonly originKey: string;
}): string {
  return actor.kind === 'user'
    ? 'user:local'
    : `${actor.kind}:${actor.originKey}`;
}

function actorDisplayName(actor: { readonly kind: LedgerActorKind }): string {
  switch (actor.kind) {
    case 'user':
      return 'You';
    case 'chat':
      return 'Chat';
    case 'managed_delegation':
      return 'Delegate';
    case 'pipeline_agent':
      return 'Pipeline agent';
    case 'background':
      return 'Background task';
    case 'ledger_sidecar':
      return 'Feed sidecar';
  }
}

function recipientKind(
  actor: LedgerSessionEndTransition['recipient'],
): LedgerActorKind {
  return actor.kind;
}

function recipientOriginKey(
  actor: LedgerSessionEndTransition['recipient'],
): string {
  return actor.kind === 'user' ? 'user:local' : actorOriginKey(actor);
}

/**
 * Follows a recipient chat whose own archive is still pending to that
 * archive's recipient, so a hand-back never lands on an archived chat that its
 * own (earlier-fenced) sweep has passed. Replay passes its startup snapshot,
 * so the order intents settle in does not matter.
 */
function liveRecipient(
  intent: SessionEndIntent,
  pending: readonly SessionEndIntent[],
): LedgerSessionEndTransition['recipient'] {
  let recipient = intent.recipient;
  const followed = new Set<string>([intent.identity]);
  while (recipient.kind === 'chat') {
    const key = recipientOriginKey(recipient);
    const archived = pending.find(
      (other) =>
        !followed.has(other.identity) &&
        other.reason === 'chat_archived' &&
        other.target.projectId === intent.target.projectId &&
        other.target.worktreeId === intent.target.worktreeId &&
        actorOriginKey(other.actor) === key,
    );
    if (archived === undefined) break;
    followed.add(archived.identity);
    recipient = archived.recipient;
  }
  return recipient;
}

function targetContainers(
  target: LedgerSessionEndTransition['target'],
): LedgerContainer[] {
  const containers: LedgerContainer[] = [
    {
      kind: 'code_worktree',
      workspaceId: target.projectId,
      worktreeId: target.worktreeId,
    },
    {
      kind: 'cowork_entry',
      workspaceId: target.projectId,
      entryId: target.worktreeId,
    },
  ];
  if (target.projectId === APP_ADVISOR_PROJECT_ID) {
    containers.push({
      kind: 'advisor_entry',
      appWorkspaceId: APP_ADVISOR_PROJECT_ID,
      entryId: target.worktreeId,
    });
  }
  return containers;
}

function isLaterThanTransition(
  updatedAt: string,
  transitionAt: string,
): boolean {
  const updated = Date.parse(updatedAt);
  const transition = Date.parse(transitionAt);
  return (
    !Number.isFinite(updated) ||
    !Number.isFinite(transition) ||
    updated > transition
  );
}

function entryCommandKey(intent: SessionEndIntent, entryId: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([intent.identity, entryId]), 'utf8')
    .digest('hex');
  return `session-end:${digest}`;
}

function checkNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('SESSION_END_ADMISSION_ABORTED');
}

function isMissingDatabase(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

/** Durable, replayable hand-back work owned by Ledger core. */
export class LedgerSessionEndSweep {
  private readonly options: LedgerSessionEndSweepOptions;
  private journalTail: Promise<void> = Promise.resolve();
  private readonly active = new Set<Promise<unknown>>();

  constructor(options: LedgerSessionEndSweepOptions) {
    this.options = options;
  }

  /** Persists one transition before returning and schedules, but never awaits, its sweep. */
  record(
    transition: LedgerSessionEndTransition,
  ): Promise<'recorded' | 'not_needed' | 'failed'> {
    return this.track(this.recordTransition(transition));
  }

  private async recordTransition(
    transition: LedgerSessionEndTransition,
  ): Promise<'recorded' | 'not_needed' | 'failed'> {
    let exists: boolean;
    try {
      exists = (await this.options.statDatabase()).isFile();
    } catch (error) {
      if (isMissingDatabase(error)) return 'not_needed';
      this.fail('DATABASE_CHECK_FAILED');
      return 'failed';
    }
    if (!exists) return 'not_needed';
    const parsed = parseTransition(transition);
    if (parsed === null) {
      this.fail('INVALID_TRANSITION');
      return 'failed';
    }
    const ledgerIds = await this.targetLedgerIds(parsed.target);
    const intent =
      ledgerIds === null ? parsed : { ...parsed, ledgerIds: ledgerIds };
    try {
      await this.withJournal(async (): Promise<void> => {
        const journal = await this.readJournal();
        if (journal.status !== 'ok') throw new Error('JOURNAL_UNREADABLE');
        if (
          journal.intents.some(
            (current) => current.identity === intent.identity,
          )
        ) {
          return;
        }
        if (journal.intents.length >= JOURNAL_LIMIT) {
          throw new Error('JOURNAL_FULL');
        }
        await this.options.file.replace(
          serializeJournal([...journal.intents, intent]),
        );
      });
    } catch {
      this.fail('INTENT_WRITE_FAILED');
      return 'failed';
    }
    this.scheduleReplay(intent);
    return 'recorded';
  }

  /** Replays every durable transition; unresolved work remains in the journal. */
  async replay(): Promise<'settled' | 'incomplete'> {
    let exists: boolean;
    try {
      exists = (await this.options.statDatabase()).isFile();
    } catch (error) {
      if (isMissingDatabase(error)) return 'settled';
      this.fail('DATABASE_CHECK_FAILED');
      return 'incomplete';
    }
    if (!exists) return 'settled';
    const journal = await this.readJournal();
    if (journal.status !== 'ok') {
      this.fail('JOURNAL_UNREADABLE');
      return 'incomplete';
    }
    let complete = true;
    const batchSize = Math.max(1, this.options.batchSize ?? DEFAULT_BATCH_SIZE);
    const pause = this.options.yieldToEventLoop ?? yieldToEventLoop;
    for (let start = 0; start < journal.intents.length; start += batchSize) {
      if (start > 0) await pause();
      for (const intent of journal.intents.slice(start, start + batchSize)) {
        const result = await this.applyIntent(intent, journal.intents);
        if (result === 'failed') {
          complete = false;
          continue;
        }
        if (result === 'unknown') {
          complete = false;
          continue;
        }
        await this.removeIntent(intent.identity);
      }
    }
    return complete ? 'settled' : 'incomplete';
  }

  async whenIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.all(this.active);
  }

  private track<Result>(work: Promise<Result>): Promise<Result> {
    this.active.add(work);
    void work.then(
      (): void => {
        this.active.delete(work);
      },
      (): void => {
        this.active.delete(work);
      },
    );
    return work;
  }

  private scheduleReplay(intent: SessionEndIntent): void {
    const work = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.readJournal()
          .then((journal) =>
            this.applyIntent(
              intent,
              journal.status === 'ok' ? journal.intents : [],
            ),
          )
          .then(async (result): Promise<void> => {
            if (result === 'applied') await this.removeIntent(intent.identity);
          })
          .catch((): void => this.fail('SWEEP_FAILED'))
          .finally(resolve);
      });
    });
    // Replay handles its failures above; the host awaits only intent durability.
    void this.track(work);
  }

  private async applyIntent(
    intent: SessionEndIntent,
    pending: readonly SessionEndIntent[],
  ): Promise<'applied' | 'unknown' | 'failed'> {
    if (this.isExpired(intent)) {
      this.fail('INTENT_RETIRED');
      return 'applied';
    }
    if (intent.actor.kind === 'managed_delegation') {
      const generation = await readLedgerDelegateGeneration(
        intent.target,
        intent.actor.originKey,
      );
      if (generation === 'gone') {
        this.fail('INTENT_RETIRED');
        return 'applied';
      }
      if (generation === null || intent.runGeneration === undefined) {
        this.fail('DELEGATE_GENERATION_UNKNOWN');
        return 'unknown';
      }
      if (generation > intent.runGeneration) return 'applied';
      if (generation !== intent.runGeneration) {
        this.fail('DELEGATE_GENERATION_MISMATCH');
        return 'unknown';
      }
      let result: 'applied' | 'superseded' | 'unknown';
      try {
        result = await withLedgerDelegateSweepAdmission(
          intent.target,
          intent.actor.originKey,
          intent.runGeneration,
          (signal): Promise<void> => this.sweep(intent, pending, signal),
        );
      } catch {
        this.fail('ADMISSION_UNAVAILABLE');
        return 'unknown';
      }
      if (result === 'unknown') {
        this.fail('ADMISSION_UNAVAILABLE');
        return 'unknown';
      }
      return 'applied';
    }
    try {
      await this.sweep(intent, pending, new AbortController().signal);
      return 'applied';
    } catch {
      this.fail('SWEEP_FAILED');
      return 'failed';
    }
  }

  private isExpired(intent: SessionEndIntent): boolean {
    try {
      const now = (this.options.now ?? ((): Date => new Date()))().getTime();
      const transitionAt = Date.parse(intent.transitionAt);
      return (
        Number.isFinite(now) &&
        Number.isFinite(transitionAt) &&
        now - transitionAt > MAX_INTENT_AGE_MS
      );
    } catch {
      this.fail('CLOCK_UNAVAILABLE');
      return false;
    }
  }

  private async sweep(
    intent: SessionEndIntent,
    pending: readonly SessionEndIntent[],
    signal: AbortSignal,
  ): Promise<void> {
    checkNotAborted(signal);
    const store = this.options.store();
    const scopesById = new Map<string, LedgerScopeRecord>();
    for (const container of targetContainers(intent.target)) {
      checkNotAborted(signal);
      const scopes = await store.findContainerScopes(container);
      checkNotAborted(signal);
      for (const scope of scopes) {
        // An archived scope takes no entries, here or in its mirror.
        if (scope.lifecycleState === 'active') {
          scopesById.set(scope.scope.ledgerId, scope);
        }
      }
    }
    const moved = (intent.ledgerIds ?? []).filter((id) => !scopesById.has(id));
    if (moved.length > 0) {
      for (const scope of await store.listScopes()) {
        if (
          moved.includes(scope.scope.ledgerId) &&
          scope.lifecycleState === 'active'
        ) {
          scopesById.set(scope.scope.ledgerId, scope);
        }
      }
      checkNotAborted(signal);
    }
    let visitedCount = 0;
    const batchSize = Math.max(1, this.options.batchSize ?? DEFAULT_BATCH_SIZE);
    for (const scope of Array.from(scopesById.values())) {
      checkNotAborted(signal);
      const actors = await store.listActors(scope.scope.ledgerId);
      checkNotAborted(signal);
      const ended = actors.find(
        (record) => record.originKey === actorOriginKey(intent.actor),
      );
      if (ended === undefined) continue;
      const to = liveRecipient(intent, pending);
      let recipient = await this.findOrRegisterRecipient(
        store,
        scope,
        actors,
        to,
      );
      // A chat recipient may be archived after the journal was read, and its
      // own sweep may already have run past this hand-back's revision, so
      // each commit re-checks it; an archived chat's work goes to the person.
      let checkArchived = to.kind === 'chat';
      checkNotAborted(signal);
      let cursor: string | undefined;
      while (true) {
        checkNotAborted(signal);
        const page = await store.searchEntries({
          ledgerId: scope.scope.ledgerId,
          ownerActorId: ended.actor.actorId,
          statuses: OPEN_STATUSES,
          types: ['TASK', 'ACTION'],
          sort: 'updated_desc',
          limit: LEDGER_LIMITS.searchPageMax,
          ...(cursor === undefined ? {} : { cursor }),
        });
        checkNotAborted(signal);
        for (const entry of page.entries) {
          checkNotAborted(signal);
          if (
            checkArchived &&
            to.kind === 'chat' &&
            (await readLedgerChatArchived(intent.target, to.originKey)) === true
          ) {
            checkNotAborted(signal);
            recipient = await this.findOrRegisterRecipient(
              store,
              scope,
              actors,
              { kind: 'user' },
            );
            checkArchived = false;
          }
          await this.handBack(
            store,
            scope.scope.container,
            intent,
            ended,
            recipient,
            entry,
            signal,
          );
          visitedCount += 1;
          if (visitedCount % batchSize === 0) {
            await (this.options.yieldToEventLoop ?? yieldToEventLoop)();
            checkNotAborted(signal);
          }
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor === undefined) break;
      }
    }
  }

  /** Best effort: replay falls back to the target's current containers. */
  private async targetLedgerIds(
    target: LedgerSessionEndTransition['target'],
  ): Promise<string[] | null> {
    try {
      const store = this.options.store();
      const ledgerIds: string[] = [];
      for (const container of targetContainers(target)) {
        for (const scope of await store.findContainerScopes(container)) {
          if (scope.lifecycleState !== 'retirement_pending') {
            ledgerIds.push(scope.scope.ledgerId);
          }
        }
      }
      return ledgerIds.length > MAX_INTENT_LEDGER_IDS ? null : ledgerIds;
    } catch {
      return null;
    }
  }

  private async findOrRegisterRecipient(
    store: LedgerStoreClient,
    scope: LedgerScopeRecord,
    actors: readonly LedgerActorRecord[],
    recipient: LedgerSessionEndTransition['recipient'],
  ): Promise<LedgerActorRef> {
    const originKey = recipientOriginKey(recipient);
    const existing = actors.find((actor) => actor.originKey === originKey);
    if (existing !== undefined) return existing.actor;
    const registered = await store.registerActor({
      ledgerId: scope.scope.ledgerId,
      kind: recipientKind(recipient),
      authorityId: scope.scope.authorityId,
      originKey,
      displayName: actorDisplayName({ kind: recipientKind(recipient) }),
    });
    return registered.actor.actor;
  }

  private async handBack(
    store: LedgerStoreClient,
    container: LedgerContainer,
    intent: SessionEndIntent,
    ended: LedgerActorRecord,
    recipient: LedgerActorRef,
    candidate: LedgerEntrySearchItem,
    signal: AbortSignal,
  ): Promise<void> {
    if (candidate.owner.actorId !== ended.actor.actorId) return;
    if (isLaterThanTransition(candidate.updatedAt, intent.transitionAt)) return;
    const input = {
      ledgerId: ended.ledgerId,
      entryId: candidate.entryId,
      expectedRevision: candidate.revision,
      endedActorId: ended.actor.actorId,
      newOwner: recipient,
      transitionAt: intent.transitionAt,
      reason: intent.reason,
      idempotencyKey: entryCommandKey(intent, candidate.entryId),
    };
    checkNotAborted(signal);
    try {
      const receipt = await store.handBackEntry(input);
      this.announce(
        container,
        ended.ledgerId,
        receipt.entry.entryId,
        receipt.entry.revision,
        receipt,
      );
      this.options.requestSync?.();
      checkNotAborted(signal);
      return;
    } catch (error) {
      checkNotAborted(signal);
      if (
        !(error instanceof LedgerStorageHostError) ||
        error.reason !== 'REVISION_CONFLICT'
      ) {
        throw error;
      }
    }
    checkNotAborted(signal);
    const reread = await store.getEntry({
      ledgerId: ended.ledgerId,
      entryId: candidate.entryId,
    });
    checkNotAborted(signal);
    if (
      reread.entry.owner.actorId !== ended.actor.actorId ||
      isLaterThanTransition(reread.entry.updatedAt, intent.transitionAt)
    ) {
      return;
    }
    checkNotAborted(signal);
    const retryInput = { ...input, expectedRevision: reread.entry.revision };
    const receipt = await store.handBackEntry(retryInput);
    this.announce(
      container,
      ended.ledgerId,
      receipt.entry.entryId,
      receipt.entry.revision,
      receipt,
    );
    this.options.requestSync?.();
    checkNotAborted(signal);
  }

  private announce(
    container: LedgerContainer,
    ledgerId: string,
    entryId: string,
    revision: number,
    receipt: Awaited<ReturnType<LedgerStoreClient['handBackEntry']>>,
  ): void {
    if (!receipt.changed) return;
    try {
      notifyLedgerEntryChanged({ container, ledgerId, entryId, revision });
      for (const change of receipt.relatedChanges ?? []) {
        notifyLedgerEntryChanged({
          container,
          ledgerId,
          entryId: change.entryId,
          revision: change.revision,
        });
      }
    } catch {
      // The store committed; an interface listener cannot undo its receipt.
    }
  }

  private async removeIntent(identity: string): Promise<void> {
    await this.withJournal(async (): Promise<void> => {
      const journal = await this.readJournal();
      if (journal.status !== 'ok') throw new Error('JOURNAL_UNREADABLE');
      const intents = journal.intents.filter(
        (intent) => intent.identity !== identity,
      );
      if (intents.length !== journal.intents.length) {
        await this.options.file.replace(serializeJournal(intents));
      }
    });
  }

  private async readJournal(): Promise<JournalRead> {
    try {
      return readJournal(await this.options.file.read());
    } catch {
      return { status: 'unreadable' };
    }
  }

  private async withJournal<Result>(
    work: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.journalTail;
    let release = (): void => undefined;
    this.journalTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private fail(code: string): void {
    try {
      this.options.recordFailure(code);
    } catch {
      // Diagnostics do not change durable Ledger work.
    }
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}
