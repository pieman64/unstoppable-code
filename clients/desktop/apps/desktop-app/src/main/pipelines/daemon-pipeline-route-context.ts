import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The daemon route a renderer workflow start opened (CAN-5086). Only the
 * `pipelines:execute` IPC handler opens one, around its start, so agent
 * tools, hooks, automations, App Advisor tools, Portal and the bridge keep
 * running workflows in process. A route serves one start: work the start
 * schedules later inherits the async context, never the route.
 */

/** Set only by the `pipelines:execute` IPC handler, from the trusted event. */
export interface DaemonPipelineRouteContext {
  /** The sender is this app's main or App Advisor window, not the remote-control bridge. */
  readonly localWindow: boolean;
}

interface OpenRoute {
  claimed: boolean;
}

const routes = new AsyncLocalStorage<OpenRoute>();

/** A renderer page main can match a caller against: a window, or the view it hosts. */
export interface DaemonPipelineSenderSurface {
  isDestroyed(): boolean;
  readonly webContents: unknown;
}

/** Whether `sender` is the live renderer of one of this app's own surfaces. */
export function isOwnRendererSender(
  sender: unknown,
  surfaces: readonly (DaemonPipelineSenderSurface | null)[],
): boolean {
  return surfaces.some(
    (surface) =>
      surface !== null &&
      surface.webContents === sender &&
      !surface.isDestroyed(),
  );
}

/** Runs `work` with a one-start daemon route open when `selected`. */
export function withDaemonPipelineRoute<T>(
  selected: boolean,
  work: () => Promise<T>,
): Promise<T> {
  if (!selected) return work();
  return routes.run({ claimed: false }, work);
}

/** Takes the open route for this start; false outside one or once taken. */
export function claimDaemonPipelineRoute(): boolean {
  const route = routes.getStore();
  if (route === undefined || route.claimed) return false;
  route.claimed = true;
  return true;
}
