/**
 * Routing abstraction so one shared shell works under both the desktop's
 * in-memory page switching (`navigationStore`) and the web's URL-based Next.js
 * router. Shared components call a `useNavigation()` hook (added later) and
 * never import `next/navigation` or the desktop store directly.
 *
 * CAN-751 migrates the desktop `navigationStore` onto this canonical
 * {@link NavigationPage} union; until then the values mirror the desktop's.
 */

/** Top-level destinations the shared shell can show. */
export type NavigationPage =
  | 'main'
  | 'overview'
  | 'chat'
  | 'pipelines'
  /** The Ledger Feed; the desktop serves it while the Ledger is on. */
  | 'feed'
  | 'plugins'
  | 'audit'
  | 'usage';

/** A resolved location: the active page plus any opaque route params. */
export interface NavigationLocation {
  readonly page: NavigationPage;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * Narrow an arbitrary string to a {@link NavigationPage}. Single source of truth
 * for both platform adapters so the shared page union stays in sync when it
 * grows (a new member is added here, not in two hand-maintained guards).
 */
export function isNavigationPage(page: string): page is NavigationPage {
  return (
    page === 'main' ||
    page === 'overview' ||
    page === 'chat' ||
    page === 'pipelines' ||
    page === 'feed' ||
    page === 'plugins' ||
    page === 'audit' ||
    page === 'usage'
  );
}

/** Returned by {@link NavigationController.subscribe}; call to stop listening. */
export type NavigationUnsubscribe = () => void;

/**
 * Implemented per platform: desktop wraps `navigationStore`, web wraps
 * `next/navigation` and serializes {@link NavigationLocation} to/from the URL.
 */
export interface NavigationController {
  /** The currently active location. */
  readonly current: NavigationLocation;
  /** Navigate to a new location. */
  navigate(location: NavigationLocation): void;
  /** Subscribe to location changes; returns an unsubscribe handle. */
  subscribe(
    listener: (location: NavigationLocation) => void,
  ): NavigationUnsubscribe;
}
