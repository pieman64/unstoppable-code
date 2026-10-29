import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  LedgerActorKind,
  LedgerActorRef,
  LedgerAddEntryParams,
  LedgerAttribution,
  LedgerAuthorDetails,
  LedgerContainer,
  LedgerOrigin,
  LedgerUpdateEntryParams,
} from '@canopy/protocol/canopy-core';

import { LedgerStoreError } from '../errors';
import { LedgerRepository } from '../repository';
import { LEDGER_PURGE_SCOPE_SQL } from '../statements';
import type {
  LedgerAddEntryInput,
  LedgerCommitHookContext,
  LedgerRepositoryOptions,
  LedgerStoreOperation,
  LedgerUpdateEntryInput,
} from '../types';

export const AUTHORITY_ID = 'desktop-authority-1';
export const START_TIME_MS = Date.parse('2026-09-28T12:00:00.000Z');
/** A worktree container tuple in the test workspace. */
export function worktreeContainer(
  worktreeId: string,
  workspaceId = 'workspace-1',
): LedgerContainer {
  return { kind: 'code_worktree', workspaceId, worktreeId };
}

export const WORKTREE_CONTAINER: LedgerContainer =
  worktreeContainer('worktree-1');
export const CONTAINER_CREATED_AT = '2026-09-01T08:00:00.000Z';

export const NO_DETAILS: LedgerAuthorDetails = {
  harness: null,
  model: null,
  thinkingEffort: null,
  mode: null,
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: 'not_applicable',
};

export const CHAT_DETAILS: LedgerAuthorDetails = {
  harness: 'claude',
  model: 'claude-sonnet',
  thinkingEffort: 'medium',
  mode: 'default',
  pipelineExecutionId: null,
  settingsRevision: null,
  unavailableReason: null,
};

/** A controllable clock for deterministic entry, receipt and cursor times. */
export class TestClock {
  private currentMs: number;

  constructor(startMs: number = START_TIME_MS) {
    this.currentMs = startMs;
  }

  readonly now = (): Date => new Date(this.currentMs);

  advance(ms: number): void {
    this.currentMs += ms;
  }

  get ms(): number {
    return this.currentMs;
  }

  iso(): string {
    return new Date(this.currentMs).toISOString();
  }
}

/** Deterministic version-4 UUIDs that sort in creation order. */
export function sequentialUuids(): () => string {
  let counter = 0;
  return (): string => {
    counter += 1;
    return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
  };
}

/**
 * Drives the repository's test-only `beforeCommit` hook: runs a callback, or
 * throws, inside the next command of one kind, just before it commits.
 */
export class CommitHooks {
  private pending: {
    readonly operation: LedgerStoreOperation;
    readonly run: () => void;
  } | null = null;

  failNext(operation: LedgerStoreOperation): void {
    this.runNext(operation, (): void => {
      throw new Error('Injected fault before commit');
    });
  }

  runNext(operation: LedgerStoreOperation, run: () => void): void {
    this.pending = { operation, run };
  }

  readonly beforeCommit = (context: LedgerCommitHookContext): void => {
    const pending = this.pending;
    if (pending === null || pending.operation !== context.operation) return;
    this.pending = null;
    pending.run();
  };
}

/**
 * Simulates an untyped caller, such as a message crossing the storage worker
 * boundary, sending field values that the TypeScript types forbid.
 */
export function withUncheckedFields<Value extends object>(
  value: Value,
  fields: object,
): Value {
  return Object.assign({}, value, fields);
}

export function createTempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'canopy-ledger-'));
}

/**
 * Reads a database directly, read-only. Its repository must be closed first:
 * no other connection can open the file while one holds it.
 */
export function readLedgerDatabase<Result>(
  databasePath: string,
  read: (database: DatabaseSync) => Result,
): Result {
  const raw = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return read(raw);
  } finally {
    raw.close();
  }
}

/**
 * The query-plan steps of a scope purge that read a table without an index,
 * including the foreign key checks its deletes trigger, as
 * `<statement> → <step>`. Empty when the purge reaches every row it reads or
 * checks through an index; full-text rows count only when found by rowid.
 */
export function unindexedPurgeSteps(
  databasePath: string,
  ledgerId: string,
): string[] {
  return readLedgerDatabase(databasePath, (raw) => {
    // An older database lacks the tables later versions added.
    const tables = new Set(
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row): string => String(row.name)),
    );
    const statements = LEDGER_PURGE_SCOPE_SQL.filter((sql: string): boolean =>
      tables.has(/^DELETE FROM (\w+)/.exec(sql)?.[1] ?? ''),
    );
    return statements.flatMap((sql: string): string[] =>
      raw
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(ledgerId)
        .map((row): string => String(row.detail))
        .filter((detail: string): boolean =>
          detail.includes('VIRTUAL TABLE')
            ? !/INDEX \d+:=/.test(detail)
            : detail.startsWith('SCAN '),
        )
        .map((detail: string): string => `${sql} → ${detail}`),
    );
  });
}

export function removeTempDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

export interface LedgerTestContext {
  readonly directory: string;
  readonly databasePath: string;
  readonly clock: TestClock;
  readonly faults: CommitHooks;
  readonly repository: LedgerRepository;
  readonly ledgerId: string;
  readonly user: LedgerActorRef;
  readonly chat: LedgerActorRef;
  readonly otherChat: LedgerActorRef;
  readonly helper: LedgerActorRef;
  readonly sidecar: LedgerActorRef;
  /** Opens another repository on the same file with the same clock. */
  reopen(options?: Partial<LedgerRepositoryOptions>): LedgerRepository;
  dispose(): void;
}

export function registerTestActor(
  repository: LedgerRepository,
  ledgerId: string,
  kind: LedgerActorKind,
  originKey: string,
  displayName: string,
): LedgerActorRef {
  return repository.registerActor({
    ledgerId,
    kind,
    authorityId: AUTHORITY_ID,
    originKey,
    displayName,
  }).actor.actor;
}

/**
 * A repository on a real SQLite file in a fresh temporary directory, with one
 * bound worktree scope and a user, two chats, a Summary helper and a sidecar.
 */
export function setUpLedger(): LedgerTestContext {
  const directory = createTempDirectory();
  const databasePath = join(directory, 'ledger', 'ledger.sqlite');
  const clock = new TestClock();
  const faults = new CommitHooks();
  const uuid = sequentialUuids();
  const repository = LedgerRepository.open({
    databasePath,
    now: clock.now,
    randomUUID: uuid,
    beforeCommit: faults.beforeCommit,
  });
  const ledgerId = repository.bindScope({
    authorityId: AUTHORITY_ID,
    container: WORKTREE_CONTAINER,
    containerCreatedAt: CONTAINER_CREATED_AT,
    accountId: 'account-1',
  }).scope.scope.ledgerId;
  const opened: LedgerRepository[] = [repository];
  return {
    directory,
    databasePath,
    clock,
    faults,
    repository,
    ledgerId,
    user: registerTestActor(repository, ledgerId, 'user', 'user:local', 'You'),
    chat: registerTestActor(repository, ledgerId, 'chat', 'chat:1', 'Chat 1'),
    otherChat: registerTestActor(
      repository,
      ledgerId,
      'chat',
      'chat:2',
      'Chat 2',
    ),
    helper: registerTestActor(
      repository,
      ledgerId,
      'background',
      'summary:generation-1',
      'Summary',
    ),
    sidecar: registerTestActor(
      repository,
      ledgerId,
      'ledger_sidecar',
      'sidecar:1',
      'Feed sidecar',
    ),
    reopen(options: Partial<LedgerRepositoryOptions> = {}): LedgerRepository {
      const reopened = LedgerRepository.open({
        databasePath,
        now: clock.now,
        randomUUID: uuid,
        ...options,
      });
      opened.push(reopened);
      return reopened;
    },
    dispose(): void {
      for (const candidate of opened) {
        if (candidate.isOpen) candidate.close();
      }
      removeTempDirectory(directory);
    },
  };
}

export function chatOrigin(ledgerId: string, chatId = 'chat-1'): LedgerOrigin {
  return { kind: 'chat', ledgerId, chatId };
}

export function userOrigin(
  ledgerId: string,
  user: LedgerActorRef,
): LedgerOrigin {
  return { kind: 'user', ledgerId, userActorId: user.actorId };
}

export function attributionFor(actor: LedgerActorRef): LedgerAttribution {
  return {
    kind: actor.kind === 'user' ? 'user' : 'self_reported',
    effectiveActor: actor,
    recordedBy: actor,
    executorDetails: actor.kind === 'user' ? NO_DETAILS : CHAT_DETAILS,
  };
}

function originFor(ledgerId: string, actor: LedgerActorRef): LedgerOrigin {
  return actor.kind === 'user'
    ? userOrigin(ledgerId, actor)
    : chatOrigin(ledgerId);
}

export function addInput(
  context: Pick<LedgerTestContext, 'ledgerId'>,
  actor: LedgerActorRef,
  params: LedgerAddEntryParams,
  idempotencyKey: string,
  overrides: Partial<LedgerAddEntryInput> = {},
): LedgerAddEntryInput {
  return {
    ledgerId: context.ledgerId,
    author: actor,
    authorDetails: actor.kind === 'user' ? NO_DETAILS : CHAT_DETAILS,
    origin: originFor(context.ledgerId, actor),
    attribution: attributionFor(actor),
    owner: actor,
    params,
    idempotencyKey,
    ...overrides,
  };
}

export function updateInput(
  context: Pick<LedgerTestContext, 'ledgerId'>,
  actor: LedgerActorRef,
  params: LedgerUpdateEntryParams,
  idempotencyKey: string,
  overrides: Partial<LedgerUpdateEntryInput> = {},
): LedgerUpdateEntryInput {
  return {
    ledgerId: context.ledgerId,
    attribution: attributionFor(actor),
    invocationOrigin: originFor(context.ledgerId, actor),
    params,
    newOwner: null,
    mayUpdateAnyOpenEntry: actor.kind === 'user',
    idempotencyKey,
    ...overrides,
  };
}

/** Captures the `LedgerStoreError` a call throws, failing if it does not. */
export function captureLedgerError(run: () => unknown): LedgerStoreError {
  try {
    run();
  } catch (error) {
    if (error instanceof LedgerStoreError) return error;
    throw error;
  }
  throw new Error('Expected a LedgerStoreError');
}
