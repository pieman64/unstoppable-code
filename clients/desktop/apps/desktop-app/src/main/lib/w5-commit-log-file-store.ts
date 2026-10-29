import type { WorkspaceCreationDiagnostics } from './w5-workspace-creation-diagnostics';
import type {
  W5CommitRequest,
  W5Resource,
  W5ReceiptLookup,
  W5ReservationFailureDiagnostics,
  W5Reservation,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { createSerialQueue } from './w5-file-store';
import { withStorageAdmission } from './w5-storage';
import {
  currentW5CommitScope,
  runW5Commit,
  type W5CommitOptions,
  type W5ObservedFile,
} from './w5-commit-scope';
import { workspaceCreationDiagnosticsSchema } from './w5-workspace-creation-diagnostics';
import { logMainProcessWarn } from './main-process-logging';
import {
  assertStorageWriteAllowed,
  STORAGE_OWNERSHIP,
} from '@canopy/core-runtime/storage';
import { admitStorageWrite } from '@canopy/desktop-shared/node/lib/storage-admission';
import { fingerprintW5File } from '@canopy/desktop-shared/node/w5-commit-log/fingerprint';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import type { W5CommitLogHost } from '../w5-commit-log/commit-log-host';
import {
  nodeW5FileStore,
  type W5FileStore,
  type W5FileRead,
} from './w5-file-store';

/** Refused before the durable decision: the repository's read is stale. */
export class W5FileWriteRefusedError extends Error {
  readonly reason = 'fingerprint-conflict';
  constructor(readonly path: string) {
    super('This was changed since it was read. Reload and try again.');
    this.name = 'W5FileWriteRefusedError';
  }
}

/** A caller precondition refused by SQLite, distinct from a file conflict. */
export class W5RevisionConflictError extends Error {
  readonly reason = 'revision-conflict';
  constructor(
    readonly resource: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super('This was changed since it was read. Reload and try again.');
    this.name = 'W5RevisionConflictError';
  }
}

export interface W5CommitLogFileStore extends W5FileStore {
  withCommit<T>(options: W5CommitOptions, work: () => Promise<T>): Promise<T>;
  lookupReceipt(
    receipt: NonNullable<W5CommitRequest['receipt']>,
  ): Promise<W5ReceiptLookup>;
  reserve(input: {
    reservationId: string;
    operation: string;
    receipt?: NonNullable<W5CommitRequest['receipt']>;
    diagnostics?: unknown;
  }): Promise<void>;
  readReservations(): Promise<W5Reservation[]>;
  updateReservationDiagnostics(
    reservationId: string,
    diagnostics: WorkspaceCreationDiagnostics,
  ): Promise<void>;
  releaseReservation(reservationId: string): Promise<void>;
  markReservationRecoveryRequired(
    reservationId: string,
    diagnostics: W5ReservationFailureDiagnostics,
  ): Promise<void>;
  readRevisions(
    resources: readonly W5Resource[],
  ): Promise<NonNullable<W5CommitRequest['expectedRevisions']>>;
}

export function w5ResourceKey(resource: W5Resource): string {
  // Keep main free of the index entrypoint's node:sqlite runtime import.
  switch (resource.kind) {
    case 'workspaces':
      return 'workspaces';
    case 'workspace':
      return `workspace:${resource.workspaceId}`;
    case 'worktrees':
      return `worktrees:${resource.workspaceId}`;
    case 'worktree':
      return `worktree:${resource.workspaceId}/${resource.worktreeId}`;
  }
}

// All stores using a host share its final decision queue. The worker itself
// serializes requests; this also keeps main's preflight in the same order.
const commitQueues = new WeakMap<
  W5CommitLogHost,
  ReturnType<typeof createSerialQueue>
>();
function commitQueue(
  host: W5CommitLogHost,
): ReturnType<typeof createSerialQueue> {
  const existing = commitQueues.get(host);
  if (existing) return existing;
  const queue = createSerialQueue();
  commitQueues.set(host, queue);
  return queue;
}

/** One launch barrier shared by all three repositories using this store. */
export function createW5CommitLogFileStore(
  getHost: () => W5CommitLogHost | Promise<W5CommitLogHost>,
): W5CommitLogFileStore {
  let ready: Promise<W5CommitLogHost> | undefined;
  function recover(): Promise<W5CommitLogHost> {
    if (ready) return ready;
    const attempt = (async (): Promise<W5CommitLogHost> => {
      const host = await getHost();
      const report = await host.recoveryReport();
      for (const commitId of report.recoveryRequired) {
        const detail = report.recoveryRequiredDetails?.find(
          (entry) => entry.commitId === commitId,
        );
        logMainProcessWarn('W5 commit requires recovery', {
          commitId,
          reason: 'file-apply-incomplete',
          ...(detail
            ? {
                diagnostics: {
                  conflictCount: detail.conflictCount,
                  writtenFileCount: detail.writtenFileCount,
                  unexpectedFailure: detail.unexpectedFailure,
                },
              }
            : {}),
        });
      }
      for (const reservationId of report.recoveryRequiredReservations ?? []) {
        const diagnostic = workspaceCreationDiagnosticsSchema.safeParse(
          report.reservations?.find(
            (entry) => entry.reservationId === reservationId,
          )?.diagnostics,
        );
        logMainProcessWarn('W5 reservation requires recovery', {
          reservationId,
          reason: 'interrupted-operation',
          ...(diagnostic.success ? { diagnostics: diagnostic.data } : {}),
        });
      }
      return host;
    })();
    ready = attempt;
    // Share each attempt, retaining only successful recovery. A later call
    // can ask the host's replacement worker to recover after startup fails.
    void attempt.catch((): void => {
      if (ready === attempt) ready = undefined;
    });
    return attempt;
  }

  // Only final preflight/decision/application is serialized. This queue
  // never acquires repository locks and is never held while work runs.
  async function commitFiles(
    options: W5CommitOptions,
    files: readonly W5ObservedFile[],
    advance: readonly W5Resource[],
  ): Promise<void> {
    if (
      !files.length &&
      !options.expectedRevisions?.length &&
      !options.receipt &&
      !options.reservationId
    )
      return;
    const queuedHost = await recover();
    await commitQueue(queuedHost)(async (): Promise<void> => {
      // A preceding queued commit can invalidate recovery while this scope
      // waits. Finish the replacement worker's recovery before preflight.
      const host = await recover();
      for (const file of files) {
        const current = await nodeW5FileStore.read(file.path);
        if (
          current.state === 'unreadable' ||
          fingerprintW5File(
            current.state === 'present' ? current.raw : null,
          ) !== fingerprintW5File(file.previousRaw)
        ) {
          throw new W5FileWriteRefusedError(file.path);
        }
      }
      let outcome: Awaited<ReturnType<W5CommitLogHost['commit']>>;
      try {
        options.beforeDecision?.();
        outcome = await host.commit({
          operation: options.operation,
          receipt: options.receipt,
          reservationId: options.reservationId,
          expectedRevisions: options.expectedRevisions,
          advance,
          files: files.map(({ path, contents, previousRaw }) => ({
            path,
            contents,
            previousFingerprint: fingerprintW5File(previousRaw),
          })),
          outcome: options.outcome ?? null,
        });
      } catch (error) {
        // A failed worker call may have left a durable, unapplied decision.
        // The next read/queued preflight must await recovery again.
        ready = undefined;
        if (
          error instanceof W5CommitRefusedError &&
          error.reason === 'revision-conflict'
        ) {
          const { resource, expected, actual } = error.details;
          if (
            typeof resource === 'string' &&
            typeof expected === 'number' &&
            typeof actual === 'number'
          ) {
            throw new W5RevisionConflictError(resource, expected, actual);
          }
        }
        throw error;
      }
      if (outcome.status === 'recovery-required') {
        throw new W5CommitRefusedError(
          'recovery-required',
          'This change was saved but did not finish and needs recovery.',
          { commitId: outcome.commitId },
        );
      }
    });
  }

  async function fenceLockedFiles(options: W5CommitOptions): Promise<void> {
    if (!options.fenceLockedFiles) return;
    const scope = currentW5CommitScope();
    if (!scope) throw new Error('Missing W5 commit scope');
    for (const { path } of options.locks ?? []) {
      // Nested scopes retain the first observation or staged preimage.
      if (scope.observed.has(path) || scope.files.has(path)) continue;
      const read = await store.read(path);
      if (read.state === 'unreadable') throw new W5FileWriteRefusedError(path);
      const raw = read.state === 'present' ? read.raw : null;
      if (!scope.observed.has(path))
        scope.observed.set(path, { path, contents: raw, previousRaw: raw });
    }
  }

  const store: W5CommitLogFileStore = {
    withCommit: (options, work) =>
      runW5Commit(
        store,
        options,
        async () => {
          await fenceLockedFiles(options);
          return work();
        },
        (scope) => {
          const files = new Map<string, W5ObservedFile>(scope.observed);
          for (const [path, observed] of Array.from(scope.observed)) {
            const staged = scope.files.get(path);
            if (
              staged &&
              fingerprintW5File(staged.previousRaw) !==
                fingerprintW5File(observed.previousRaw)
            )
              throw new W5FileWriteRefusedError(path);
          }
          scope.files.forEach((file, path) => files.set(path, file));
          return withStorageAdmission(Array.from(scope.storage.values()), () =>
            commitFiles(
              scope.options,
              Array.from(files.values()),
              Array.from(scope.advance.values()),
            ),
          );
        },
      ),
    async lookupReceipt(receipt) {
      return (await recover()).lookupReceipt(receipt);
    },
    async readReservations() {
      return (await (await recover()).recoveryReport()).reservations ?? [];
    },
    async reserve(input) {
      await (await recover()).reserve(input);
    },
    async updateReservationDiagnostics(reservationId, diagnostics) {
      await (
        await recover()
      ).updateReservationDiagnostics(reservationId, diagnostics);
    },
    async releaseReservation(reservationId) {
      await (await recover()).releaseReservation(reservationId);
    },
    async markReservationRecoveryRequired(reservationId, diagnostics) {
      await (
        await recover()
      ).markReservationRecoveryRequired(reservationId, diagnostics);
    },
    async readRevisions(resources) {
      const host = await recover();
      return Promise.all(
        resources.map(async (resource) => ({
          resource,
          revision: await host.revision(resource),
        })),
      );
    },
    async read(filePath): Promise<W5FileRead> {
      const scope = currentW5CommitScope();
      if (scope && scope.store !== store)
        throw new Error('A W5 scope cannot span stores');
      const staged = scope?.files.get(filePath);
      if (staged) return { state: 'present', raw: staged.contents };
      try {
        await recover();
      } catch (error) {
        return {
          state: 'unreadable',
          ...(error instanceof Error ? { error } : {}),
        };
      }
      return nodeW5FileStore.read(filePath);
    },
    async replace(filePath, contents, storage, replacement): Promise<void> {
      assertStorageWriteAllowed(
        storage.namespace,
        storage.writer,
        STORAGE_OWNERSHIP,
      );
      await admitStorageWrite(storage, async (): Promise<void> => {
        await recover();
        const files = [
          { path: filePath, contents, previousRaw: replacement.previousRaw },
          ...(replacement.backup ? [replacement.backup] : []),
        ];
        const scope = currentW5CommitScope();
        if (!scope) {
          await commitFiles(
            { operation: replacement.operation },
            files,
            replacement.advance,
          );
          return;
        }
        if (scope.store !== store)
          throw new Error('A W5 scope cannot span stores');
        scope.storage.set(storage.namespace, storage);
        // Preserve the fingerprint of the first read, while subsequent writes
        // read their own staged image. Keep the original rolling backup.
        for (const file of files) {
          const staged = scope.files.get(file.path);
          if (
            staged &&
            fingerprintW5File(staged.contents) !==
              fingerprintW5File(file.previousRaw)
          ) {
            throw new W5FileWriteRefusedError(file.path);
          }
        }
        for (const file of files) {
          const staged = scope.files.get(file.path);
          if (file.path !== filePath) {
            const main = scope.files.get(filePath);
            if (staged || main?.previousRaw === null) continue;
            if (main) file.contents = main.previousRaw ?? file.contents;
          }
          scope.files.set(file.path, {
            ...file,
            previousRaw: staged ? staged.previousRaw : file.previousRaw,
          });
        }
        for (const resource of replacement.advance)
          scope.advance.set(w5ResourceKey(resource), resource);
      });
    },
  };
  return store;
}

const productionStore = createW5CommitLogFileStore(
  async (): Promise<W5CommitLogHost> => {
    const { getW5CommitLogHost } =
      await import('../w5-commit-log/commit-log-host');
    return getW5CommitLogHost();
  },
);
let testStore: W5FileStore | undefined;

/** Explicit test injection; production never falls back to direct writes. */
export function __setDesktopW5FileStoreForTests(
  store: W5FileStore | undefined,
): void {
  testStore = store;
}

export const desktopW5FileStore: W5FileStore = {
  read: (path) => (testStore ?? productionStore).read(path),
  replace: (path, contents, storage, replacement) =>
    (testStore ?? productionStore).replace(
      path,
      contents,
      storage,
      replacement,
    ),
};

export type { W5CommitOptions } from './w5-commit-scope';

function isCommitLogStore(store: W5FileStore): store is W5CommitLogFileStore {
  return (
    'withCommit' in store &&
    typeof store.withCommit === 'function' &&
    'readRevisions' in store &&
    typeof store.readRevisions === 'function'
  );
}

/** Existing Jest direct stores retain their explicit injection; production always stages. */
export function withW5Commit<T>(
  options: W5CommitOptions,
  work: () => Promise<T>,
): Promise<T> {
  const store = testStore ?? productionStore;
  return isCommitLogStore(store) ? store.withCommit(options, work) : work();
}

/** Current revisions through the recovered worker, for a later edit's preconditions. */
export function readW5Revisions(
  resources: readonly W5Resource[],
): Promise<NonNullable<W5CommitRequest['expectedRevisions']>> {
  const store = testStore ?? productionStore;
  if (!isCommitLogStore(store))
    throw new Error('Revision reads require the W5 commit log store');
  return store.readRevisions(resources);
}

/** Keyed admission never acquires repository leases or the final decision queue. */
export function getW5ReceiptStore(): Pick<
  W5CommitLogFileStore,
  | 'lookupReceipt'
  | 'reserve'
  | 'releaseReservation'
  | 'markReservationRecoveryRequired'
> {
  const store = testStore ?? productionStore;
  if (!isCommitLogStore(store))
    throw new Error('Keyed changes require the W5 commit log store');
  return store;
}

/** Only explicitly injected legacy test stores bypass identity reservations. */
export function getW5IdentityStore(): W5CommitLogFileStore | undefined {
  const store = testStore ?? productionStore;
  return isCommitLogStore(store) ? store : undefined;
}
