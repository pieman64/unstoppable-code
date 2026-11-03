import { AsyncLocalStorage } from 'node:async_hooks';
import {
  readNodeW5File,
  type W5FileRead,
} from '@canopy/core-runtime/node/w5/file-store';
import type { W5ReadViewOutcome } from './w5-read-view';

const projectionBrand = Symbol('W5ProjectionOnlyRead');
export interface W5ProjectionOnlyRead {
  readonly [projectionBrand]: true;
}

/** Only the Electron sidebar response may opt in to disk projections. */
export const W5_PROJECTION_ONLY_READ: W5ProjectionOnlyRead = {
  [projectionBrand]: true,
};
const permission = new AsyncLocalStorage<{ closed: boolean } | undefined>();

export async function withW5ProjectionOnlyRead<T>(
  token: W5ProjectionOnlyRead,
  work: () => Promise<T>,
): Promise<T> {
  const scope = { closed: token !== W5_PROJECTION_ONLY_READ };
  try {
    return await permission.run(scope, work);
  } finally {
    scope.closed = true;
  }
}

export function allowsW5ProjectionOnlyRead(): boolean {
  return permission.getStore()?.closed === false;
}

interface FallbackView {
  closed: boolean;
  reads: Map<string, Promise<W5FileRead>>;
}
const context = new AsyncLocalStorage<FallbackView | undefined>();

/** A nested authoritative view must not inherit projection bytes or permission. */
export function withoutW5Projection<T>(work: () => Promise<T>): Promise<T> {
  return context.run(undefined, () => permission.run(undefined, work));
}

export function isW5ProjectionOnlyView(): boolean {
  const view = context.getStore();
  return view !== undefined && !view.closed;
}

export function readW5FallbackFile(
  path: string,
): Promise<W5FileRead> | undefined {
  const view = context.getStore();
  if (!view || view.closed) return undefined;
  let read = view.reads.get(path);
  if (!read) {
    read = readNodeW5File(path);
    view.reads.set(path, read);
  }
  return read;
}

/** Lazy, memoized disk images: no log, readiness, revisions or writer state. */
export async function runW5FallbackRead<T>(
  work: (view: W5ReadViewOutcome) => Promise<T>,
): Promise<T> {
  const view: FallbackView = { closed: false, reads: new Map() };
  try {
    return await context.run(view, () =>
      permission.run(undefined, () =>
        work({ status: 'uncaptured', reason: 'daemon-unavailable' }),
      ),
    );
  } finally {
    view.closed = true;
  }
}
