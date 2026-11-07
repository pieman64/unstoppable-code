import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import {
  LedgerRepository,
  isLedgerStoreError,
} from '@canopy/desktop-shared/node/ledger';
import {
  isLedgerStorageArguments,
  isLedgerStorageMethod,
  isLedgerStorageRequest,
  isLedgerStorageWorkerData,
  readLedgerStorageRequestId,
  toLedgerStorageJson,
  type LedgerStorageArguments,
  type LedgerStorageError,
  type LedgerStorageMethod,
  type LedgerStorageRequest,
  type LedgerStorageResponse,
  type LedgerStorageStartupMessage,
} from './storage-worker-contract';

/*
 * The Ledger storage worker: a thread inside the main process that holds the
 * Ledger database's only connection, so synchronous SQLite stays off the main
 * event loop. It opens the database once, reports `ready` or `openFailed`, and
 * then runs each request's repository method to completion before it reads the
 * next, so every command is serialized on that one connection.
 *
 * `Worker.terminate()` cannot interrupt native SQLite: a timed-out write may
 * have committed while its caller receives `STORAGE_UNAVAILABLE` (CAN-5329).
 * Node closes the connection during teardown, before the host sees `exit`,
 * releasing the database lock for the next opener.
 *
 * Nothing here logs. Error messages are fixed, content-free text with no entry
 * text, paths or SQL values; only a store error's protocol details can carry
 * the current entry.
 */

const INVALID_CONFIGURATION_MESSAGE =
  'The Ledger storage worker was started without a database path';
const UNKNOWN_METHOD_MESSAGE = 'The Ledger storage method is not supported';
const MALFORMED_REQUEST_MESSAGE = 'The Ledger storage request is malformed';
const UNEXPECTED_FAILURE_MESSAGE =
  'The Ledger storage call failed unexpectedly';
const UNSENDABLE_RESULT_MESSAGE = 'The Ledger storage result could not be sent';

type LedgerStorageHandler<Method extends LedgerStorageMethod> = (
  repository: LedgerRepository,
  ...args: LedgerStorageArguments[Method]
) => unknown;

type LedgerStorageHandlers = {
  readonly [Method in LedgerStorageMethod]: LedgerStorageHandler<Method>;
};

const HANDLERS: LedgerStorageHandlers = {
  getAuthorityId: (repository) => repository.authorityId,
  bindScope: (repository, input) => repository.bindScope(input),
  findScope: (repository, input) => repository.findScope(input),
  bindGlobalScope: (repository, input) => repository.bindGlobalScope(input),
  findGlobalScope: (repository, input) => repository.findGlobalScope(input),
  getScope: (repository, ledgerId) => repository.getScope(ledgerId),
  registerActor: (repository, input) => repository.registerActor(input),
  listActors: (repository, ledgerId) => repository.listActors(ledgerId),
  addEntry: (repository, input) => repository.addEntry(input),
  listPendingTitles: (repository) => repository.listPendingTitles(),
  recordPendingTitleAttempt: (repository, input) =>
    repository.recordPendingTitleAttempt(input),
  resolvePendingTitle: (repository, input) =>
    repository.resolvePendingTitle(input),
  updateEntry: (repository, input) => repository.updateEntry(input),
  handBackEntry: (repository, input) => repository.handBackEntry(input),
  publishSummary: (repository, input) => repository.publishSummary(input),
  listReceiptKeys: (repository, input) => repository.listReceiptKeys(input),
  getEntry: (repository, input) => repository.getEntry(input),
  searchEntries: (repository, input) => repository.searchEntries(input),
  listChanges: (repository, input) => repository.listChanges(input),
  listRollups: (repository, input) => repository.listRollups(input),
  getWorkSummary: (repository, input) => repository.getWorkSummary(input),
  getStorageCounts: (repository) => repository.getStorageCounts(),
  listScopes: (repository) => repository.listScopes(),
  findContainerScopes: (repository, container) =>
    repository.findContainerScopes(container),
  setScopeLifecycle: (repository, input) => repository.setScopeLifecycle(input),
  rebindScope: (repository, input) => repository.rebindScope(input),
  purgeScope: (repository, ledgerId) => repository.purgeScope(ledgerId),
  listSyncScopes: (repository) => repository.listSyncScopes(),
  getScopeSync: (repository, ledgerId) => repository.getScopeSync(ledgerId),
  readOutbox: (repository, input) => repository.readOutbox(input),
  acknowledgeOutbox: (repository, input) => repository.acknowledgeOutbox(input),
  recordMirrorAudience: (repository, input) =>
    repository.recordMirrorAudience(input),
  setScopeRepair: (repository, input) => repository.setScopeRepair(input),
  rebindAccount: (repository, input) => repository.rebindAccount(input),
};

/** A request this worker cannot run; reported as `INTERNAL`. */
class LedgerStorageRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerStorageRequestError';
  }
}

function internalError(message: string): LedgerStorageError {
  return { reason: 'INTERNAL', message };
}

/**
 * A store error keeps its reason and fixed message, with the protocol
 * `LedgerErrorDetails` from `toDetails()` as plain JSON. Anything else is
 * `INTERNAL` with a fixed message: its own text could quote stored content.
 */
function toStorageError(error: unknown): LedgerStorageError {
  if (error instanceof LedgerStorageRequestError) {
    return internalError(error.message);
  }
  if (!isLedgerStoreError(error)) {
    return internalError(UNEXPECTED_FAILURE_MESSAGE);
  }
  return {
    reason: error.reason,
    message: error.message,
    details: toLedgerStorageJson(error.toDetails()) ?? { reason: error.reason },
  };
}

function runMethod<Method extends LedgerStorageMethod>(
  repository: LedgerRepository,
  method: Method,
  args: unknown,
): unknown {
  if (!isLedgerStorageArguments(method, args)) {
    throw new LedgerStorageRequestError(MALFORMED_REQUEST_MESSAGE);
  }
  const handler: LedgerStorageHandler<Method> = HANDLERS[method];
  return handler(repository, ...args);
}

function answer(
  repository: LedgerRepository,
  request: LedgerStorageRequest,
): LedgerStorageResponse {
  try {
    if (!isLedgerStorageMethod(request.method)) {
      throw new LedgerStorageRequestError(UNKNOWN_METHOD_MESSAGE);
    }
    const result = runMethod(repository, request.method, request.args);
    return { id: request.id, ok: true, result };
  } catch (error) {
    return { id: request.id, ok: false, error: toStorageError(error) };
  }
}

function respond(port: MessagePort, response: LedgerStorageResponse): void {
  try {
    port.postMessage(response);
  } catch {
    // A result that cannot be cloned must still answer its request.
    const failure: LedgerStorageResponse = {
      id: response.id,
      ok: false,
      error: internalError(UNSENDABLE_RESULT_MESSAGE),
    };
    port.postMessage(failure);
  }
}

function receive(
  port: MessagePort,
  repository: LedgerRepository,
  message: unknown,
): void {
  if (isLedgerStorageRequest(message)) {
    respond(port, answer(repository, message));
    return;
  }
  // The host sends only requests. Answer a malformed one when it has an id,
  // so the caller fails at once instead of waiting for its timeout.
  const id = readLedgerStorageRequestId(message);
  if (id !== undefined) {
    respond(port, {
      id,
      ok: false,
      error: internalError(MALFORMED_REQUEST_MESSAGE),
    });
  }
}

function report(port: MessagePort, message: LedgerStorageStartupMessage): void {
  port.postMessage(message);
}

function start(port: MessagePort, data: unknown): void {
  if (!isLedgerStorageWorkerData(data)) {
    report(port, {
      type: 'openFailed',
      error: internalError(INVALID_CONFIGURATION_MESSAGE),
    });
    return;
  }
  let repository: LedgerRepository;
  try {
    // Creates, migrates and exclusively locks the database. Another holder
    // fails the open with WRITER_UNAVAILABLE, having written nothing.
    repository = LedgerRepository.open({ databasePath: data.dbPath });
  } catch (error) {
    // Without a listener the thread then exits on its own.
    report(port, { type: 'openFailed', error: toStorageError(error) });
    return;
  }
  // Listening keeps the thread, and so the connection and its lock, alive
  // until the host terminates it.
  port.on('message', (message: unknown): void =>
    receive(port, repository, message),
  );
  report(port, { type: 'ready' });
}

const port = parentPort;
if (port === null) {
  throw new Error('The Ledger storage worker must run in a worker thread');
}
start(port, workerData);
