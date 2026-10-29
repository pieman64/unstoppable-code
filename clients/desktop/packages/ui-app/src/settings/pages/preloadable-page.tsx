'use client';

import { lazy, type ComponentType, type JSX } from 'react';

/**
 * A page component loaded from its own chunk, like `React.lazy`, that can
 * also be loaded ahead of its first render.
 *
 * `React.lazy` suspends on its first render even when the chunk is already
 * downloaded, which would flash the Suspense fallback on every first visit.
 * Once the chunk has loaded (through {@link PreloadablePage.preload} or a
 * first render), this renders the loaded component directly and never
 * suspends again.
 */
export interface PreloadablePage<P extends object> {
  (props: P): JSX.Element;
  /**
   * Load the chunk once. A failed preload can be retried; a chunk that
   * fails during a first render stays failed until a later preload loads it.
   */
  readonly preload: () => Promise<void>;
  /** Whether the chunk has loaded, so rendering will not suspend. */
  readonly isLoaded: () => boolean;
}

/** Takes the same loader as `React.lazy`. */
export function preloadablePage<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): PreloadablePage<P> {
  let loaded: ComponentType<P> | null = null;
  let pending: Promise<ComponentType<P>> | null = null;
  const loadComponent = (): Promise<ComponentType<P>> => {
    pending ??= load().then(
      (module) => {
        loaded = module.default;
        return module.default;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };
  // Used only before the chunk has loaded; it resolves after `loaded` is set,
  // so a page that renders it never commits it and later swaps type.
  const LazyPage = lazy(() =>
    loadComponent().then((component) => ({ default: component })),
  );
  function Page(props: P): JSX.Element {
    const Loaded = loaded;
    return Loaded === null ? <LazyPage {...props} /> : <Loaded {...props} />;
  }
  return Object.assign(Page, {
    preload: (): Promise<void> => loadComponent().then(() => undefined),
    isLoaded: (): boolean => loaded !== null,
  });
}
