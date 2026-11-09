/**
 * E2E-only render faults, so UI automation exercises real boundary containment
 * rather than a story of the fallback. Everything here is reached only through
 * `__CANOPY_E2E__`-gated call sites, and production builds remove it.
 */
import { useSyncExternalStore } from 'react';

export type RenderFaultTarget =
  | `panel:${string}`
  | 'chart'
  | 'lazy-load'
  | 'window';

const RENDER_FAULT_MARKER = 'E2E_RENDER_FAULT_PROBE';

const armedTargets = new Set<RenderFaultTarget>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => {
    listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

export function failRender(target: RenderFaultTarget): void {
  if (!__CANOPY_E2E__) return;
  armedTargets.add(target);
  notify();
}

export function clearRenderFault(target?: RenderFaultTarget): void {
  if (!__CANOPY_E2E__) return;
  if (target === undefined) armedTargets.clear();
  else armedTargets.delete(target);
  notify();
}

/** Renders nothing until armed, then throws during render on every attempt. */
export function RenderFaultProbe({
  target,
}: {
  readonly target: RenderFaultTarget;
}): null {
  const armed = useSyncExternalStore(subscribe, () => armedTargets.has(target));
  if (armed) throw new Error(`${RENDER_FAULT_MARKER} ${target}`);
  return null;
}
