import {
  createWorkerCatalogHandlers,
  type WorkerCatalogHost,
  type WorkerCatalogMaterializationReader,
} from '@canopy/core-runtime/node/catalog';
import { getDesktopExecutionSecrets } from '../execution-secrets/owner';
import { createDesktopWorkerCatalogHost } from './catalog-materialization-host';
import type { DesktopDomainAdapter } from './desktop-runtime';

/** `worker.catalog.*` on the desktop's in-process worker (CAN-4123), with its worker-local reader. */
export function createWorkerCatalogAdapter(
  host?: WorkerCatalogHost,
): DesktopDomainAdapter & { reader: WorkerCatalogMaterializationReader } {
  const handlers = createWorkerCatalogHandlers({
    host: host ?? createDesktopWorkerCatalogHost(),
    secrets: getDesktopExecutionSecrets(),
  });
  return {
    queries: {
      'worker.catalog.materialization.get': (params, context) =>
        handlers.queries['worker.catalog.materialization.get'](params, context),
    },
    instructions: {
      'worker.catalog.materialize': (params, context) =>
        handlers.instructions['worker.catalog.materialize'](params, context),
      'worker.catalog.materialization.release': (params, context) =>
        handlers.instructions['worker.catalog.materialization.release'](
          params,
          context,
        ),
    },
    reader: handlers.reader,
  };
}
