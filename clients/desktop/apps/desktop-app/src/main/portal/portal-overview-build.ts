import { performance } from 'node:perf_hooks';
import type { BuiltPortalSnapshot } from './portal-snapshot-builders';

/**
 * Overview builds read the whole fleet and can take minutes on large desktops,
 * so structural pushes and `portal.state.request` overviews share one build at
 * a time. A caller may only reuse a build that started at or after it arrived:
 * an older build may predate the change the caller is reporting, and handing
 * it back would overwrite newer state. Callers arriving during an older build
 * share exactly one follow-up build that starts when it settles.
 */
export interface PortalFreshSingleFlight<T> {
  acquire: (arrivedAt: number, start: () => Promise<T>) => Promise<T>;
}

export function createPortalFreshSingleFlight<T>(
  now: () => number,
): PortalFreshSingleFlight<T> {
  let current: { startedAt: number; promise: Promise<T> } | null = null;
  let next: Promise<T> | null = null;
  const run = (start: () => Promise<T>): Promise<T> => {
    next = null;
    const flight = { startedAt: now(), promise: start() };
    current = flight;
    const clear = (): void => {
      if (current === flight) current = null;
    };
    flight.promise.then(clear, clear);
    return flight.promise;
  };
  return {
    acquire: (arrivedAt, start): Promise<T> => {
      // A pending follow-up has not started, so it is fresh for everyone.
      if (next) return next;
      if (current && current.startedAt >= arrivedAt) return current.promise;
      if (!current) return run(start);
      next = current.promise.then(
        () => run(start),
        () => run(start),
      );
      return next;
    },
  };
}

const overviewFlight = createPortalFreshSingleFlight<BuiltPortalSnapshot>(() =>
  performance.now(),
);

/**
 * Build, or join, an untargeted overview snapshot that started no earlier than
 * `arrivedAt` (a `performance.now()` mark). `commandId` attributes section
 * timings when this call starts the build.
 */
export function acquirePortalOverviewSnapshot(
  arrivedAt: number,
  commandId?: string,
): Promise<BuiltPortalSnapshot> {
  return overviewFlight.acquire(arrivedAt, async () => {
    // Dynamic import keeps this module a leaf: the builders reach persistence
    // modules that notify the event bus, which imports this module.
    const { buildPortalSnapshot } = await import('./portal-snapshot-builders');
    return commandId
      ? buildPortalSnapshot({ scope: 'overview' }, { commandId })
      : buildPortalSnapshot({ scope: 'overview' });
  });
}
