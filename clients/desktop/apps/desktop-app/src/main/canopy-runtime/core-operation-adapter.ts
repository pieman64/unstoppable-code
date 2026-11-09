import {
  OperationService,
  createCoreOperationHandlers,
  type CoreOperationHandlers,
  type OperationLedger,
} from '@canopy/core-runtime/node/operations';
import {
  logMainProcessInfo,
  logMainProcessWarn,
} from '../lib/main-process-logging';
import { getOperationLedgerPath } from '../lib/paths';

/*
 * Registers `core.operation.*` on the desktop dispatcher (CAN-4130). The
 * operation service in `@canopy/core-runtime/node/operations` owns the
 * durable operation ledger; this adapter is its only owner in Electron main
 * and resolves the ledger with main's canonical path helper. The ledger and
 * `node:sqlite` load on the first operation call or domain admission, never
 * at startup. Domains (pipelines, scripts, hooks) register with `service`
 * as they adopt operation records.
 */

export interface CoreOperationAdapter extends CoreOperationHandlers {
  readonly service: OperationService;
  close(): void;
}

export function createCoreOperationAdapter(
  options: { ledgerPath?: () => string } = {},
): CoreOperationAdapter {
  const ledgerPath = options.ledgerPath ?? getOperationLedgerPath;
  const service = new OperationService({
    openLedger: async (): Promise<OperationLedger> => {
      const { OperationLedger } =
        await import('@canopy/core-runtime/node/operations/ledger');
      return OperationLedger.open(ledgerPath(), {
        onIdentityRetention: (result): void => {
          if (result.status === 'pruned')
            logMainProcessInfo(
              `[operations] deleted ${result.operations} settled helper-run operation rows past retention`,
            );
          else if (result.status === 'indexed')
            logMainProcessInfo(
              `[operations] built the identity retention index in ${result.durationMs} ms`,
            );
          else
            logMainProcessWarn(
              '[operations] identity retention batch failed; rows kept',
              result.error,
            );
        },
      });
    },
    onError: (error, context): void => {
      logMainProcessWarn(`[operations] ${context} failed`, error);
    },
  });
  const handlers = createCoreOperationHandlers(service);
  return {
    queries: {
      'core.operation.get': handlers.queries['core.operation.get'],
      'core.operation.list': handlers.queries['core.operation.list'],
    },
    instructions: {
      'core.operation.cancel': handlers.instructions['core.operation.cancel'],
    },
    streams: {
      'core.operation.events': handlers.streams['core.operation.events'],
    },
    service,
    close: (): void => {
      service.close();
    },
  };
}
