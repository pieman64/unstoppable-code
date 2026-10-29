import type { ParentPort } from 'electron';
// Must stay on the worker-safe core module. `code-graph-worktree-fingerprint`
// reaches `read-runner` → `electron`, which inlines the npm launcher stub into
// this bundle and kills the worker at load; see the core module's header.
import { fingerprintCodeGraphWorktree } from '../lib/code-graph-worktree-fingerprint-core';
import type {
  CodeGraphFingerprintWorkerRequest,
  CodeGraphFingerprintWorkerResponse,
} from './fingerprint-runner';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkerRequest(
  value: unknown,
): value is CodeGraphFingerprintWorkerRequest {
  return (
    isRecord(value) &&
    Array.isArray(value.repositories) &&
    value.repositories.every(
      (repository) =>
        isRecord(repository) &&
        typeof repository.repoId === 'string' &&
        typeof repository.rootPath === 'string',
    )
  );
}

export async function executeCodeGraphFingerprint(
  request: CodeGraphFingerprintWorkerRequest,
): Promise<CodeGraphFingerprintWorkerResponse> {
  try {
    return {
      ok: true,
      fingerprint: await fingerprintCodeGraphWorktree(request.repositories),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function respondOnce(
  parentPort: ParentPort,
  payload: unknown,
): Promise<void> {
  const response = isWorkerRequest(payload)
    ? await executeCodeGraphFingerprint(payload)
    : { ok: false as const, message: 'Malformed fingerprint request.' };
  try {
    parentPort.postMessage(response);
  } finally {
    process.exit(0);
  }
}

const workerParentPort: ParentPort | undefined = process.parentPort;
if (workerParentPort) {
  workerParentPort.once('message', (event: unknown): void => {
    void respondOnce(
      workerParentPort,
      isRecord(event) && 'data' in event ? event.data : undefined,
    );
  });
}
