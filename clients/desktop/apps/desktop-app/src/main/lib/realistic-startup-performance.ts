import { performance } from 'node:perf_hooks';
import { isE2eBuild } from './e2e-gate';

export const REALISTIC_STARTUP_PERFORMANCE_ENV =
  'CANOPY_PERFORMANCE_REALISTIC_STARTUP';

export interface RealisticStartupPerformanceEvent {
  event: string;
  atMs: number;
  details?: Record<string, string | number | boolean | null>;
}

declare global {
  var __CANOPY_PERFORMANCE_REALISTIC_STARTUP_EVENTS__:
    | RealisticStartupPerformanceEvent[]
    | undefined;
}

export function isRealisticStartupPerformanceEnabled(
  e2eEnabled = isE2eBuild(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return e2eEnabled && env[REALISTIC_STARTUP_PERFORMANCE_ENV] === '1';
}

export function recordRealisticStartupPerformanceEvent(
  event: string,
  details?: RealisticStartupPerformanceEvent['details'],
): void {
  if (!isRealisticStartupPerformanceEnabled()) {
    return;
  }
  const events =
    globalThis.__CANOPY_PERFORMANCE_REALISTIC_STARTUP_EVENTS__ ??
    (globalThis.__CANOPY_PERFORMANCE_REALISTIC_STARTUP_EVENTS__ = []);
  events.push({
    event,
    atMs: performance.now(),
    ...(details ? { details } : {}),
  });
}

export function resetRealisticStartupPerformanceEvents(): void {
  delete globalThis.__CANOPY_PERFORMANCE_REALISTIC_STARTUP_EVENTS__;
}
