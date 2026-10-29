import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import {
  W5CommitLog,
  recoverW5CommitLog,
  type W5RecoveryReport,
} from '@canopy/desktop-shared/node/w5-commit-log';
import {
  isW5CommitLogRequest,
  isW5CommitLogWorkerData,
  readW5CommitLogRequestId,
  type W5CommitLogRequest,
  type W5CommitLogResponse,
  type W5CommitLogStartupMessage,
} from './commit-log-worker-contract';
import {
  MALFORMED_REQUEST_MESSAGE,
  W5CommitLogRequestHandler,
  toW5CommitLogWorkerError,
} from './commit-log-worker-requests';
import { ensureW5DataRoot } from './commit-log-root';

/*
 * The W5 commit log worker: a thread inside the main process that holds the
 * commit log's only connection, so synchronous SQLite stays off the main
 * event loop (CAN-3805). It opens the log, runs launch recovery, reports
 * `ready` or `openFailed`, and then runs each request to completion before it
 * starts the next, so commits and their file writes never interleave.
 *
 * The host stops it with `Worker.terminate()`. Node closes the connection as
 * it tears down the thread, which releases the exclusive lock for the next
 * opener; a commit whose files were not yet written is finished by the next
 * worker's recovery.
 *
 * Nothing here logs. Error messages are fixed text or the commit log's own,
 * which carry no file contents.
 */

const INVALID_CONFIGURATION_MESSAGE =
  'The W5 commit log worker was started without a database path and root';
const UNSENDABLE_RESULT_MESSAGE = 'The W5 commit log result could not be sent';

function respond(port: MessagePort, response: W5CommitLogResponse): void {
  try {
    port.postMessage(response);
  } catch {
    // A result that cannot be cloned must still answer its request.
    port.postMessage({
      id: response.id,
      ok: false,
      error: { kind: 'failed', message: UNSENDABLE_RESULT_MESSAGE },
    } satisfies W5CommitLogResponse);
  }
}

async function answer(
  worker: W5CommitLogRequestHandler,
  request: W5CommitLogRequest,
): Promise<W5CommitLogResponse> {
  try {
    return { id: request.id, ok: true, result: await worker.run(request) };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: toW5CommitLogWorkerError(error),
    };
  }
}

function listen(port: MessagePort, worker: W5CommitLogRequestHandler): void {
  // Requests run one after another even if the host sent a second early.
  let tail: Promise<void> = Promise.resolve();
  port.on('message', (message: unknown): void => {
    tail = tail.then(async (): Promise<void> => {
      if (isW5CommitLogRequest(message)) {
        respond(port, await answer(worker, message));
        return;
      }
      // Answer a malformed request that has an id, so the caller fails at
      // once instead of waiting for its timeout.
      const id = readW5CommitLogRequestId(message);
      if (id !== undefined) {
        respond(port, {
          id,
          ok: false,
          error: { kind: 'malformed', message: MALFORMED_REQUEST_MESSAGE },
        });
      }
    });
  });
}

function report(port: MessagePort, message: W5CommitLogStartupMessage): void {
  port.postMessage(message);
}

async function start(port: MessagePort, data: unknown): Promise<void> {
  if (!isW5CommitLogWorkerData(data)) {
    report(port, {
      type: 'openFailed',
      error: { kind: 'malformed', message: INVALID_CONFIGURATION_MESSAGE },
    });
    return;
  }
  let log: W5CommitLog;
  let recovery: W5RecoveryReport;
  try {
    // Creates and exclusively locks the log. Another holder fails the open
    // with WRITER_UNAVAILABLE, having written nothing.
    log = W5CommitLog.open(data.dbPath);
  } catch (error) {
    // Without a listener the thread then exits on its own.
    report(port, {
      type: 'openFailed',
      error: toW5CommitLogWorkerError(error),
    });
    return;
  }
  try {
    // Before any request, so no change is committed over one an earlier
    // process committed but did not finish writing, and none lands outside
    // a root that does not exist yet.
    await ensureW5DataRoot(data.root);
    recovery = await recoverW5CommitLog(log, { root: data.root });
    const details = log.listRecoveryRequiredCommitDiagnostics();
    if (details.length > 0) recovery.recoveryRequiredDetails = details;
  } catch (error) {
    log.close();
    report(port, {
      type: 'openFailed',
      error: toW5CommitLogWorkerError(error),
    });
    return;
  }
  // Listening keeps the thread, and so the connection and its lock, alive
  // until the host terminates it.
  listen(port, new W5CommitLogRequestHandler(log, data, recovery));
  report(port, { type: 'ready' });
}

const port = parentPort;
if (port === null) {
  throw new Error('The W5 commit log worker must run in a worker thread');
}
void start(port, workerData);
