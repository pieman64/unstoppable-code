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
