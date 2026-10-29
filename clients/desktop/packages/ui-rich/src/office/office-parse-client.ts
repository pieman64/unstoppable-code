import type {
  OfficeParseRequest,
  OfficeParseResponse,
  OfficeParseResult,
} from './office-parse';

export const OFFICE_PARSE_TIMEOUT_MS = 30_000;

export type OfficeParseFailureReason =
  | 'timeout'
  | 'worker-error'
  | 'parse-error'
  | 'aborted';

export class OfficeParseError extends Error {
  constructor(
    readonly reason: OfficeParseFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'OfficeParseError';
  }
}

export interface ParseOfficeDocumentOptions {
  readonly createWorker: () => Worker;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export function parseOfficeDocument(
  request: OfficeParseRequest,
  options: ParseOfficeDocumentOptions,
): Promise<OfficeParseResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new OfficeParseError('aborted', 'Parse aborted.'));
  }
  let worker: Worker;
  try {
    worker = options.createWorker();
  } catch (error) {
    return Promise.reject(
      new OfficeParseError(
        'worker-error',
        error instanceof Error ? error.message : 'Worker creation failed.',
      ),
    );
  }
  return new Promise<OfficeParseResult>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void =>
      finish(() => reject(new OfficeParseError('aborted', 'Parse aborted.')));
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      outcome();
    };
    worker.onmessage = (event: MessageEvent<OfficeParseResponse>): void => {
      const response = event.data;
      if (
        !response ||
        typeof response.ok !== 'boolean' ||
        (response.ok &&
          (!response.result || response.result.kind !== request.kind))
      ) {
        finish(() =>
          reject(
            new OfficeParseError('worker-error', 'Unexpected worker result.'),
          ),
        );
      } else if (response.ok) {
        finish(() => resolve(response.result));
      } else {
        finish(() =>
          reject(new OfficeParseError('parse-error', response.error)),
        );
      }
    };
    worker.onerror = (event: ErrorEvent): void =>
      finish(() =>
        reject(
          new OfficeParseError(
            'worker-error',
            event.message || 'Worker failed.',
          ),
        ),
      );
    worker.onmessageerror = (): void =>
      finish(() =>
        reject(new OfficeParseError('worker-error', 'Invalid worker message.')),
      );
    options.signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new OfficeParseError(
              'timeout',
              `Parsing exceeded ${options.timeoutMs ?? OFFICE_PARSE_TIMEOUT_MS} ms.`,
            ),
          ),
        ),
      options.timeoutMs ?? OFFICE_PARSE_TIMEOUT_MS,
    );
    try {
      const bytes = request.bytes.slice(0);
      worker.postMessage({ kind: request.kind, bytes }, [bytes]);
    } catch (error) {
      finish(() =>
        reject(
          new OfficeParseError(
            'worker-error',
            error instanceof Error ? error.message : 'Worker transfer failed.',
          ),
        ),
      );
    }
  });
}
