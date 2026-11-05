import type * as HelperRunsModule from '../../helper-runs/helper-runs';
import type { HelperRunRequest } from '../../helper-runs/helper-runs';
import { runInHelperWorker } from '../../helper-runs/helper-worker-context';

export interface RecordedHelperRun {
  kind: HelperRunRequest<unknown>['kind'];
  model: string;
  scope: HelperRunRequest<unknown>['scope'];
  origin: HelperRunRequest<unknown>['origin'];
  signal: AbortSignal | undefined;
}

export function inlineHelperRunsModule(): {
  runs: RecordedHelperRun[];
  runHelperThroughWorker: <T>(request: HelperRunRequest<T>) => Promise<T>;
  linkHelperAbort: typeof HelperRunsModule.linkHelperAbort;
  HelperWorkerUnavailableError: typeof HelperRunsModule.HelperWorkerUnavailableError;
} {
  const actual = jest.requireActual<typeof HelperRunsModule>(
    '../../helper-runs/helper-runs',
  );
  const runs: RecordedHelperRun[] = [];
  return {
    runs,
    linkHelperAbort: actual.linkHelperAbort,
    HelperWorkerUnavailableError: actual.HelperWorkerUnavailableError,
    runHelperThroughWorker: async <T>(
      request: HelperRunRequest<T>,
    ): Promise<T> => {
      runs.push({
        kind: request.kind,
        model: request.model,
        scope: request.scope,
        origin: request.origin,
        signal: request.signal,
      });
      const controller = new AbortController();
      const abort = (): void => controller.abort(request.signal?.reason);
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener('abort', abort, { once: true });
      try {
        return await runInHelperWorker(
          { helperRunId: `test-${runs.length}`, kind: request.kind },
          () => request.launch(controller.signal),
        );
      } finally {
        request.signal?.removeEventListener('abort', abort);
      }
    },
  };
}
