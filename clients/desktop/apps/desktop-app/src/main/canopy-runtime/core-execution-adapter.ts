import { AsyncLocalStorage } from 'node:async_hooks';
import { BRAND } from '@canopy/brand/current';
import {
  createCoreExecutionHandlers,
  type CoreExecutionHandlers,
  type ExecutionAccountingSnapshot,
  type ExecutionStatusView,
} from '@canopy/core-runtime';
import type { ResourceMetadata } from '@canopy/desktop-shared/types';
import type { DesktopExecutionAccounting } from '../execution-accounting';
import { mergeDaemonExecutionStatus } from '../resource-monitor/daemon-status';
import {
  getDaemonExecutionStatus,
  type DaemonExecutionStatusSource,
} from './daemon-execution-status';

/*
 * Registers `core.execution.*` (CAN-5080) over the in-process execution
 * accounting that Electron main hosts (CAN-4135), so every client reads the
 * same accounting. The accounting loads on the first call, never when the
 * runtime is built. A compatibility projection can capture the host snapshot
 * behind a read, to keep desktop metadata the portable status leaves with the
 * host.
 *
 * Clients read one execution status: Electron main's accounting with the
 * daemon's status folded in by the resource monitor's merge (CAN-5693), so
 * Portal and other clients see daemon-hosted work as the resource monitor
 * does. With no daemon status (no session, an older daemon, a dropped
 * connection) or a stale one, they read Electron main's accounting alone.
 * Family counts and the memory guard stay Electron main's, as admission does.
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

type DaemonStatus = Pick<DaemonExecutionStatusSource, 'current' | 'subscribe'>;

/** Electron main's accounting with the daemon's current status merged in. */
function daemonExecutionStatusView(
  daemon: DaemonStatus,
): ExecutionStatusView<ResourceMetadata> {
  return {
    project: (snapshot): ExecutionAccountingSnapshot<ResourceMetadata> => {
      const status = daemon.current();
      return status
        ? mergeDaemonExecutionStatus(snapshot, status, {
            productName: BRAND.displayName,
            now: Date.now(),
          })
        : snapshot;
    },
    subscribe: (onChange): (() => void) => daemon.subscribe(() => onChange()),
  };
}

export function createCoreExecutionAdapter(
  accounting: () => Promise<DesktopExecutionAccounting> = loadExecutionAccounting,
  daemon: () => DaemonStatus = getDaemonExecutionStatus,
): CoreExecutionHandlers {
  let handlers: Promise<CoreExecutionHandlers> | null = null;
  const resolve = (): Promise<CoreExecutionHandlers> => {
    handlers ??= accounting().then((source) =>
      createCoreExecutionHandlers(source, {
        observeRead: (snapshot): void => {
          const projection = projectionContext.getStore();
          if (projection) projection.snapshot = snapshot;
        },
        view: daemonExecutionStatusView(daemon()),
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
