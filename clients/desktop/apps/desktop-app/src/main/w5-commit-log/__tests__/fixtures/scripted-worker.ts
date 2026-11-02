import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parentPort, threadId, workerData } from 'node:worker_threads';

/*
 * Test double for the W5 commit log worker, run through tsx by the host tests
 * for failures the real worker cannot be made to show on demand. The `root`
 * the host passes names the script:
 *
 * - `never-ready`: stays alive but never reports startup, so only the host's
 *   startup deadline can end it.
 * - `silent`: reports ready, then never answers.
 * - `exit-on-request`: reports ready, then exits on its first request.
 * - `unexpected-result`: reports ready, then answers every request with a
 *   result of the wrong shape.
 * - `other-commit`: reports ready, then answers every request with an
 *   `applied` retry result for a commit one past its first argument.
 * - `failed`: reports ready, then answers every request with a `failed`
 *   error, as after an unexpected failure that may follow a commit.
 * - `blocked`: reports ready, then blocks in a native call for 3 s on its
 *   first request, which `Worker.terminate()` cannot interrupt.
 * - `anchor`: reports ready with a capture root of its own, even when it was
 *   started with one, so the host must ignore a later worker's. It refuses
 *   each `capture` with the root it was started with in the details, and
 *   answers any other request with a `failed` error, which retires it.
 * - `anchor-late`: the host's first worker reports ready without a capture
 *   root, as when resolving the root failed at startup; every later one
 *   anchors its own. `dbPath` marks that the first has started.
 * - `never-anchor`: reports ready without a capture root every time.
 * - `partial-recovery`: writes `recovered` to its `dbPath`, as a launch
 *   recovery that applied part of a commit, then never reports startup.
 *
 *   Both refuse each `capture` with their own capture root (or null) in the
 *   details, and answer any other request with revision 0.
 *
 * Tests must not import this module: it runs only as a worker entry.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const port = parentPort;
if (port === null) throw new Error('Run only as a worker');
const script = isRecord(workerData) ? workerData.root : undefined;
const startedWith = isRecord(workerData) ? workerData.captureRoot : undefined;

/** `anchor-late` and `never-anchor`: this worker's capture root, if any. */
function lateAnchor(): string | undefined {
  if (script === 'never-anchor') return undefined;
  const marker = isRecord(workerData) ? workerData.dbPath : undefined;
  if (typeof marker !== 'string') throw new Error('No dbPath');
  if (existsSync(marker)) return `/anchored/by-worker-${threadId}`;
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, '');
  return undefined;
}
const late = script === 'anchor-late' || script === 'never-anchor';
const lateRoot = late ? lateAnchor() : undefined;

const neverReady = script === 'never-ready' || script === 'partial-recovery';
if (script === 'partial-recovery') {
  const target = isRecord(workerData) ? workerData.dbPath : undefined;
  if (typeof target !== 'string') throw new Error('No dbPath');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'recovered');
}
// Without a pending timer the thread would exit on its own.
if (neverReady) setInterval(() => undefined, 1_000);

if (!neverReady) {
  port.on('message', (message: unknown): void => {
    if (script === 'exit-on-request') process.exit(1);
    if (script === 'unexpected-result' && isRecord(message)) {
      port.postMessage({ id: message.id, ok: true, result: { nope: true } });
    }
    if (
      script === 'other-commit' &&
      isRecord(message) &&
      Array.isArray(message.args) &&
      typeof message.args[0] === 'number'
    ) {
      port.postMessage({
        id: message.id,
        ok: true,
        result: { status: 'applied', commitId: message.args[0] + 1 },
      });
    }
    if (script === 'failed' && isRecord(message)) {
      port.postMessage({
        id: message.id,
        ok: false,
        error: { kind: 'failed', message: 'failed' },
      });
    }
    if (script === 'blocked') execSync('sleep 3');
    if (script === 'anchor' && isRecord(message))
      port.postMessage({
        id: message.id,
        ok: false,
        error:
          message.method === 'capture'
            ? {
                kind: 'refused',
                reason: 'invalid-state',
                message: 'anchor',
                details: { startedWith: startedWith ?? null },
              }
            : { kind: 'failed', message: 'failed' },
      });
    if (late && isRecord(message))
      port.postMessage(
        message.method === 'capture'
          ? {
              id: message.id,
              ok: false,
              error: {
                kind: 'refused',
                reason: 'invalid-state',
                message: 'late anchor',
                details: { anchored: lateRoot ?? null },
              },
            }
          : { id: message.id, ok: true, result: 0 },
      );
  });
  port.postMessage(
    script === 'anchor'
      ? { type: 'ready', captureRoot: `/anchored/by-worker-${threadId}` }
      : lateRoot !== undefined
        ? { type: 'ready', captureRoot: lateRoot }
        : { type: 'ready' },
  );
}
