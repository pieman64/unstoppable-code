import type { DesktopCanopyDispatcher } from './desktop-runtime';

let currentRuntime: DesktopCanopyDispatcher | null = null;

export function setDesktopCanopyRuntime(
  runtime: DesktopCanopyDispatcher | null,
): void {
  currentRuntime = runtime;
}

export function getDesktopCanopyRuntime(): DesktopCanopyDispatcher {
  if (!currentRuntime) throw new Error('Desktop Canopy runtime is not ready.');
  return currentRuntime;
}

/** The runtime when it is ready, for bookkeeping that may skip without it. */
export function peekDesktopCanopyRuntime(): DesktopCanopyDispatcher | null {
  return currentRuntime;
}
