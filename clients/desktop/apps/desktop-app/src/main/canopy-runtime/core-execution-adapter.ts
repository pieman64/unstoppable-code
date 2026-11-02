import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createCoreExecutionHandlers,
  type CoreExecutionHandlers,
  type ExecutionAccountingSnapshot,
} from '@canopy/core-runtime';
import type { ResourceMetadata } from '@canopy/desktop-shared/types';
import type { DesktopExecutionAccounting } from '../execution-accounting';

/*
 * Registers `core.execution.*` (CAN-5080) over the in-process execution
 * accounting that Electron main hosts (CAN-4135), so every client reads the
 * same accounting. The accounting loads on the first call, never when the
 * runtime is built. A compatibility projection can capture the host snapshot
 * behind a read, to keep desktop metadata the portable status leaves with the
 * host.
 */

export interface ExecutionStatusProjection {
  snapshot?: ExecutionAccountingSnapshot<ResourceMetadata>;
}

const projectionContext = new AsyncLocalStorage<ExecutionStatusProjection>();

export async function captureExecutionStatusProjection<Result>(
  dispatch: () => Promise<Result>,
): Promise<{ result: Result; projection: ExecutionStatusProjection }> {
  const projection: ExecutionStatusProjection = {};
  const result = await projectionContext.run(projection, dispatch);
  return { result, projection };
}

async function loadExecutionAccounting(): Promise<DesktopExecutionAccounting> {
  const { getExecutionAccounting } = await import('../execution-accounting');
  return getExecutionAccounting();
}

export function createCoreExecutionAdapter(
  accounting: () => Promise<DesktopExecutionAccounting> = loadExecutionAccounting,
): CoreExecutionHandlers {
  let handlers: Promise<CoreExecutionHandlers> | null = null;
  const resolve = (): Promise<CoreExecutionHandlers> => {
    handlers ??= accounting().then((source) =>
      createCoreExecutionHandlers(source, {
        observeRead: (snapshot): void => {
          const projection = projectionContext.getStore();
          if (projection) projection.snapshot = snapshot;
        },
      }),
    );
    return handlers;
  };
  return {
    queries: {
      'core.execution.status.get': async (params, context) =>
        (await resolve()).queries['core.execution.status.get'](params, context),
    },
    streams: {
      'core.execution.status.events': async (params, context, sink) =>
        (await resolve()).streams['core.execution.status.events'](
          params,
          context,
          sink,
        ),
    },
  };
}
