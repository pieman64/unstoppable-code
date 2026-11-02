import type { CodeGraphRepositoryInput } from '../types/code-graph';
import type { CodeGraphHostChannel } from './channel';
import { fingerprintCodeGraphWorktree } from './worktree-fingerprint';

export interface CodeGraphFingerprintWorkerRequest {
  repositories: readonly CodeGraphRepositoryInput[];
}

export type CodeGraphFingerprintWorkerResponse =
  | { ok: true; fingerprint: string }
  | { ok: false; message: string };

/** Host facts the fingerprint host cannot read for itself. */
export interface CodeGraphFingerprintHostFacts {
  /** The Git executable the host runs. */
  readonly gitExecutable: string;
}

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
  facts: CodeGraphFingerprintHostFacts,
): Promise<CodeGraphFingerprintWorkerResponse> {
  try {
    return {
      ok: true,
      fingerprint: await fingerprintCodeGraphWorktree(
        request.repositories,
        facts.gitExecutable,
      ),
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function respondOnce(
  channel: CodeGraphHostChannel,
  payload: unknown,
  facts: CodeGraphFingerprintHostFacts,
): Promise<void> {
  const response = isWorkerRequest(payload)
    ? await executeCodeGraphFingerprint(payload, facts)
    : { ok: false as const, message: 'Malformed fingerprint request.' };
  try {
    channel.postMessage(response);
  } finally {
    channel.exit(0);
  }
}

/** Serves one fingerprint request on `channel`, then exits. */
export function serveCodeGraphFingerprintHost(
  channel: CodeGraphHostChannel,
  facts: CodeGraphFingerprintHostFacts,
): void {
  channel.once('message', (event: unknown): void => {
    void respondOnce(
      channel,
      isRecord(event) && 'data' in event ? event.data : undefined,
      facts,
    );
  });
}
