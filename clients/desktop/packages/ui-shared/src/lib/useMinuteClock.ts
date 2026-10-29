'use client';

import { useSyncExternalStore } from 'react';

/**
 * One clock for every row that shows a relative age ("5m", "3h"). A single
 * interval runs while at least one component subscribes and ticks once a
 * minute, so a long list re-renders its age labels together instead of each
 * row running its own timer.
 */
const TICK_MS = 60_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, TICK_MS);
  }
  return (): void => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  // Before the first subscriber starts the interval, catch the clock up so
  // a newly mounted row does not read the time the module loaded. Updating
  // at most once a minute keeps consecutive reads equal, as React requires.
  if (timer === null && Date.now() - now >= TICK_MS) {
    now = Date.now();
  }
  return now;
}

function getServerSnapshot(): number {
  return Date.now();
}

/** The current time, refreshed once a minute while any caller is mounted. */
export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
