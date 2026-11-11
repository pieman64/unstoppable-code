import { AsyncLocalStorage } from 'node:async_hooks';
import { CanopyClientError } from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import type * as DaemonRouteModule from './daemon-code-graph-route';

/**
 * The daemon route a renderer code-graph build or summary read opened
 * (CAN-5089). Only the code-graph IPC handlers open one, around their
 * dispatch of `worker.codeGraph.build` or `worker.codeGraph.query`, so every
 * other dispatcher caller keeps Electron main's graph hosts. A route serves
 * one operation: work it schedules later inherits the async context, never
 * the route.
 */
export interface DaemonCodeGraphRoute {
  /** Takes the route for this operation; false once one has taken it. */
  claim(): boolean;
  /** The operation the route took went to the daemon, not in process. */
  servedByDaemon(): void;
  /** A reached daemon refused the operation; its refusal is the answer. */
  refusedByDaemon?(): void;
  /** The daemon could not be reached, so the operation ran in process. */
  fellBack?(): void;
}

/**
 * How a selected route settled (CAN-5093 field evidence), whether the work
 * succeeded or failed: `not_dispatched` when nothing took the route.
 */
export type DaemonCodeGraphRouteOutcome =
  | 'served'
  | 'refused'
  | 'fallback'
  | 'not_dispatched';

const routes = new AsyncLocalStorage<DaemonCodeGraphRoute>();

/** A renderer page main can match a caller against: a window, or the view it hosts. */
export interface DaemonCodeGraphSenderSurface {
  isDestroyed(): boolean;
  readonly webContents: unknown;
}

/** Whether `sender` is the live renderer of one of this app's own surfaces. */
export function isOwnRendererSender(
  sender: unknown,
  surfaces: readonly (DaemonCodeGraphSenderSurface | null)[],
): boolean {
  return surfaces.some(
    (surface) =>
      surface !== null &&
      surface.webContents === sender &&
      !surface.isDestroyed(),
  );
}

/**
 * Runs `work` with the daemon route open when `selected`. `settled` hears
 * once how a selected route ended, also when `work` throws.
 */
export async function withDaemonCodeGraphRoute<T>(
  selected: boolean,
  work: () => Promise<T>,
  settled?: (outcome: DaemonCodeGraphRouteOutcome) => void,
): Promise<{ value: T; daemon: boolean }> {
  if (!selected) return { value: await work(), daemon: false };
  let claimed = false;
  const state: { outcome: DaemonCodeGraphRouteOutcome } = {
    outcome: 'not_dispatched',
  };
  try {
    const value = await routes.run(
      {
        claim: () => {
          if (claimed) return false;
          claimed = true;
          return true;
        },
        servedByDaemon: () => {
          state.outcome = 'served';
        },
        refusedByDaemon: () => {
          state.outcome = 'refused';
        },
        fellBack: () => {
          state.outcome = 'fallback';
        },
      },
      work,
    );
    return { value, daemon: state.outcome === 'served' };
  } finally {
    settled?.(state.outcome);
  }
}

/** The route this dispatch may take, if its IPC handler opened one. */
export function currentDaemonCodeGraphRoute():
  | DaemonCodeGraphRoute
  | undefined {
  return routes.getStore();
}

/**
 * A dispatcher handler's daemon branch: an operation the open route may take
 * goes to the daemon, and runs in process only when the daemon can't be
 * reached; any refusal from a reached daemon is the operation's answer.
 */
export async function onDaemonCodeGraphRoute<T>(
  inDaemon: (daemon: typeof DaemonRouteModule) => Promise<T>,
  inProcess: () => Promise<T>,
): Promise<T> {
  const route = routes.getStore();
  if (route === undefined || !route.claim()) return inProcess();
  const daemon = await import('./daemon-code-graph-route');
  try {
    const answer = await inDaemon(daemon);
    route.servedByDaemon();
    return answer;
  } catch (error) {
    if (!daemon.noteDaemonCodeGraphFallback(error)) {
      route.refusedByDaemon?.();
      throw error instanceof CanopyClientError
        ? new CanopyOperationError(error.payload, error)
        : error;
    }
  }
  route.fellBack?.();
  return inProcess();
}
