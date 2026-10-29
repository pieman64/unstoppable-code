import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from 'react';
import type {
  NavigationController,
  NavigationLocation,
} from '@canopy/app-core';

const NavigationControllerContext = createContext<NavigationController | null>(
  null,
);

export interface NavigationProviderProps {
  /**
   * The platform routing adapter — desktop wraps the in-memory `navigationStore`,
   * web wraps the URL. Shared components consume it through {@link useNavigation}
   * and never import `next/navigation` or the desktop store directly.
   */
  readonly controller: NavigationController;
  readonly children: ReactNode;
}

/** Injects a {@link NavigationController} into the React tree. */
export function NavigationProvider({
  controller,
  children,
}: NavigationProviderProps): JSX.Element {
  return (
    <NavigationControllerContext.Provider value={controller}>
      {children}
    </NavigationControllerContext.Provider>
  );
}

/** The ambient {@link NavigationController}; throws outside a provider. */
export function useNavigationController(): NavigationController {
  const controller = useContext(NavigationControllerContext);
  if (!controller) {
    throw new Error(
      'useNavigationController must be used within a NavigationProvider',
    );
  }
  return controller;
}

/** Reactive navigation state + a `navigate` action for shared components. */
export interface UseNavigationResult {
  readonly location: NavigationLocation;
  readonly navigate: (location: NavigationLocation) => void;
}

/**
 * Subscribe to the current {@link NavigationLocation} and expose `navigate`.
 * Uses `useSyncExternalStore`, so the adapter's `current` must return a stable
 * reference while unchanged (both platform adapters cache it) to avoid a render
 * loop.
 */
export function useNavigation(): UseNavigationResult {
  const controller = useNavigationController();
  const location = useSyncExternalStore(
    (onStoreChange) => controller.subscribe(() => onStoreChange()),
    () => controller.current,
    () => controller.current,
  );
  // Stable across renders (keyed to the controller) so memoized children that
  // receive `navigate` do not re-render on every parent render.
  const navigate = useCallback(
    (next: NavigationLocation) => controller.navigate(next),
    [controller],
  );
  return { location, navigate };
}
