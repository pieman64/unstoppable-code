import type { CodeGraphReadFailure } from '../types/code-graph-tools';

// The read hosts' closed failures and the errors that carry them. Kept apart
// from the read scheduler so callers that only classify a failure load
// nothing else.

const READ_FAILURE_CODES: readonly CodeGraphReadFailure[] = [
  'queue-timeout',
  'execution-timeout',
  'busy',
  'worker-exit',
  'canceled',
  'invalid-response',
  'database-error',
];

export function isReadFailure(value: unknown): value is CodeGraphReadFailure {
  return READ_FAILURE_CODES.some((code) => value === code);
}

/** Raw worker/provider/database details never become host copy. */
export class CodeGraphReadFailureError extends Error {
  public constructor(public readonly readFailure: CodeGraphReadFailure) {
    super('The retained Code Graph could not be read. Try again.');
    this.name = 'CodeGraphReadFailureError';
  }
}

export function codeGraphReadFailure(error: unknown): CodeGraphReadFailure {
  if (error instanceof CodeGraphReadFailureError) return error.readFailure;
  if (error instanceof CodeGraphWorkerReadError) {
    switch (error.reason) {
      case 'timeout':
        return 'execution-timeout';
      case 'queue-timeout':
        return 'queue-timeout';
      case 'busy':
        return 'busy';
      case 'canceled':
        return 'canceled';
      case 'worker-exit':
      case 'spawn-failed':
        return 'worker-exit';
      case 'post-failed':
      case 'malformed-response':
        return 'invalid-response';
    }
  }
  return 'database-error';
}

export type CodeGraphWorkerReadErrorReason =
  | 'timeout'
  | 'queue-timeout'
  | 'busy'
  | 'canceled'
  | 'worker-exit'
  | 'spawn-failed'
  | 'post-failed'
  | 'malformed-response';

export class CodeGraphWorkerReadError extends Error {
  public constructor(
    public readonly reason: CodeGraphWorkerReadErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'CodeGraphWorkerReadError';
  }
}
