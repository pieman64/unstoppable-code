import { execSync } from 'node:child_process';
import { parentPort, workerData } from 'node:worker_threads';

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
 * - `failed`: reports ready, then answers every request with a `failed`
 *   error, as after an unexpected failure that may follow a commit.
 * - `blocked`: reports ready, then blocks in a native call for 3 s on its
 *   first request, which `Worker.terminate()` cannot interrupt.
 *
 * Tests must not import this module: it runs only as a worker entry.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const port = parentPort;
if (port === null) throw new Error('Run only as a worker');
const script = isRecord(workerData) ? workerData.root : undefined;

// Without a pending timer the thread would exit on its own.
if (script === 'never-ready') setInterval(() => undefined, 1_000);

if (script !== 'never-ready') {
  port.on('message', (message: unknown): void => {
    if (script === 'exit-on-request') process.exit(1);
    if (script === 'unexpected-result' && isRecord(message)) {
      port.postMessage({ id: message.id, ok: true, result: { nope: true } });
    }
    if (script === 'failed' && isRecord(message)) {
      port.postMessage({
        id: message.id,
        ok: false,
        error: { kind: 'failed', message: 'failed' },
      });
    }
    if (script === 'blocked') execSync('sleep 3');
  });
  port.postMessage({ type: 'ready' });
}
