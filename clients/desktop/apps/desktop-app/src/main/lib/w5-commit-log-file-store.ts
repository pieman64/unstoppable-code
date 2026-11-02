import { isUtf8 } from 'node:buffer';
import type {
  W5CommitRequest,
  W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import {
  createW5CommitLogFileStore as createCoreW5CommitLogFileStore,
  type W5CommitLogFileStore,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { admitW5Storage } from './w5-storage';
import { currentW5CommitScope, type W5CommitOptions } from './w5-commit-scope';
import { logMainProcessWarn } from './main-process-logging';
import { admitStorageWrite } from '@canopy/desktop-shared/node/lib/storage-admission';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import type { W5CommitLogHost } from '../w5-commit-log/commit-log-host';
import { readWorkspaceIndex } from '@canopy/core-runtime/node';
import {
  isW5CaptureWorkspaceId,
  type W5CaptureRequest,
  type W5CaptureResult,
} from '../w5-commit-log/commit-log-worker-contract';
import {
  assertOutsideW5ReadView,
  failsW5ReadsClosed,
  readFromW5ReadView,
  runInW5CapturedView,
  runInW5UncapturedView,
  type W5ReadViewOutcome,
  type W5ReadViewUncapturedReason,
} from './w5-read-view';
import { nodeW5FileStore, type W5FileStore } from './w5-file-store';
import { noteW5CommitScopeOpened } from './w5-pre-effect-retry';

export {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
  w5ResourceKey,
  type W5CommitLogFileStore,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';

/**
 * The core store bound to desktop main's logger, direct reads and storage
 * admission. Each binding resolves at call time, so test spies still intercept.
 */
export function createW5CommitLogFileStore(
  getHost: () => W5CommitLogHost | Promise<W5CommitLogHost>,
): W5CommitLogFileStore {
  return createCoreW5CommitLogFileStore({
    getHost,
    warn: (message, context) => logMainProcessWarn(message, context),
    readFile: (filePath) => nodeW5FileStore.read(filePath),
    admit: (targets, operation) => admitW5Storage(targets, operation),
    admitWrite: (target, write) => admitStorageWrite(target, write),
  });
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
  read: (path) => {
    const captured = readFromW5ReadView(path);
    return captured
      ? Promise.resolve(captured)
      : (testStore ?? productionStore).read(path);
  },
  replace: async (path, contents, storage, replacement) => {
    assertOutsideW5ReadView();
    await (testStore ?? productionStore).replace(
      path,
      contents,
      storage,
      replacement,
    );
  },
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
export async function withW5Commit<T>(
  options: W5CommitOptions,
  work: () => Promise<T>,
): Promise<T> {
  assertOutsideW5ReadView();
  // A scope's work may run effects, so an enclosing unit never reruns it.
  noteW5CommitScopeOpened();
  const store = testStore ?? productionStore;
  return isCommitLogStore(store) ? store.withCommit(options, work) : work();
}

function captureRefusal(error: unknown): W5ReadViewUncapturedReason {
  if (
    error instanceof W5CommitRefusedError &&
    error.reason === 'invalid-state'
  ) {
    const reason = error.details.capture;
    if (
      reason === 'unsupported-platform' ||
      reason === 'confinement-unavailable' ||
      reason === 'root-changed' ||
      reason === 'root-unavailable'
    )
      return reason;
    if (reason === 'limit-exceeded') return 'capture-limit';
  }
  return 'capture-failed';
}

const loggedLiveReasons = new Set<W5ReadViewUncapturedReason>();

/** A query the capture cannot serve reads live, recorded in its outcome and logged once. */
function runLive<T>(
  reason: W5ReadViewUncapturedReason,
  work: (view: W5ReadViewOutcome) => Promise<T>,
): Promise<T> {
  if (!loggedLiveReasons.has(reason)) {
    loggedLiveReasons.add(reason);
    logMainProcessWarn('W5 query reads are not captured', { reason });
  }
  return runInW5UncapturedView(reason, work);
}

/**
 * Runs one query's W5 reads over one worker capture of `request`. Writes
 * are refused. Where capture is unsupported, over its limits, or cannot name
 * a workspace or decode the index naming it, the whole query reads live and
 * the outcome says so; a failed capture, or a data root that did not
 * resolve or no longer resolves to its anchored path, fails every read
 * closed. Inside a mutation scope, its staged
 * reads apply unchanged.
 */
export async function runW5ReadView<T>(
  request: W5CaptureRequest,
  work: (view: W5ReadViewOutcome) => Promise<T>,
): Promise<T> {
  if (currentW5CommitScope())
    return work({ status: 'uncaptured', reason: 'mutation-scope' });
  const store = testStore ?? productionStore;
  if (!isCommitLogStore(store) || !store.capture)
    return runInW5UncapturedView('direct-store', work);
  if (
    !request.files.every(
      (file) =>
        !('workspaceId' in file) || isW5CaptureWorkspaceId(file.workspaceId),
    )
  )
    return runLive('unsupported-id', work);
  let captured: { capture: W5CaptureResult; root: string };
  try {
    captured = await store.capture(request);
  } catch (error) {
    const reason = captureRefusal(error);
    if (!failsW5ReadsClosed(reason)) return runLive(reason, work);
    logMainProcessWarn('W5 query capture failed; its reads fail closed', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return runInW5UncapturedView(reason, work);
  }
  const skipped = discoverySkippedReads(captured.capture);
  if (skipped) return runLive(skipped, work);
  return runInW5CapturedView(captured.capture, captured.root, work);
}

/**
 * Why discovery left out files of a workspace the query's index will name:
 * one it cannot name, or every one behind bytes it will not decode.
 */
function discoverySkippedReads(
  capture: W5CaptureResult,
): W5ReadViewUncapturedReason | undefined {
  if (capture.discovery !== 'invalid-index') return undefined;
  const index = capture.files.find((file) => file.kind === 'index');
  if (index?.state !== 'present') return undefined;
  const bytes = Buffer.from(index.base64, 'base64');
  // The repositories' own lenient decoding, as the captured view serves it.
  const { entries } = readWorkspaceIndex(
    { state: 'present', raw: bytes.toString('utf8') },
    () => undefined,
  );
  const captured = (
    kind: 'manifest' | 'worktrees',
    workspaceId: string,
  ): boolean =>
    capture.files.some(
      (file) =>
        file.kind === kind &&
        'workspaceId' in file &&
        file.workspaceId === workspaceId,
    );
  if (
    entries.every(
      (entry) =>
        captured('manifest', entry.id) && captured('worktrees', entry.id),
    )
  )
    return undefined;
  return isUtf8(bytes) ? 'unsupported-id' : 'undecodable-index';
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
