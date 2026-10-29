import type {
  NavigationController,
  NavigationLocation,
  NavigationUnsubscribe,
} from '@canopy/app-core';
import { isNavigationPage } from '@canopy/app-core';
import { useNavigationStore } from '@/stores/navigationStore';

/** The desktop Workflows tabs (CAN-3981), as navigation pages. */
const WORKFLOWS_TAB_PAGES: ReadonlySet<string> = new Set([
  'workflows',
  'workflows-schedule',
  'workflows-library',
]);

/**
 * Map the desktop's broader page union onto the shared shell's. The shared
 * shell names its Workflows destination `pipelines`, so every desktop
 * Workflows tab maps to it and the shared rail keeps its row selected.
 * Desktop-only top-level pages (`workers`/`statistics`/`environments`) fall
 * back to `main` — provisional, reconfirmed when the shared shell adopts
 * routing (CAN-753). Route `params` are not modelled by the desktop store, so
 * they are intentionally omitted (added if/when a consumer needs them).
 */
function toSharedLocation(page: string): NavigationLocation {
  if (WORKFLOWS_TAB_PAGES.has(page)) return { page: 'pipelines' };
  return { page: isNavigationPage(page) ? page : 'main' };
}

/**
 * Desktop {@link NavigationController} over the in-memory `navigationStore`.
 * `current` is cached and only replaced when the active page actually changes,
 * so `useSyncExternalStore` (in `useNavigation`) sees a stable reference and
 * does not loop. Overlays (settings/command palette/…) stay on the store and
 * are intentionally out of this page-navigation abstraction.
 */
export function createDesktopNavigationController(): NavigationController {
  let cached: NavigationLocation = toSharedLocation(
    useNavigationStore.getState().activePage,
  );
  const compute = (): NavigationLocation => {
    const next = toSharedLocation(useNavigationStore.getState().activePage);
    if (next.page !== cached.page) {
      cached = next;
    }
    return cached;
  };

  return {
    get current(): NavigationLocation {
      return compute();
    },
    navigate(location: NavigationLocation): void {
      // The shared shell's Workflows destination opens Runs, the landing tab.
      useNavigationStore
        .getState()
        .navigate(location.page === 'pipelines' ? 'workflows' : location.page);
    },
    subscribe(
      listener: (location: NavigationLocation) => void,
    ): NavigationUnsubscribe {
      return useNavigationStore.subscribe((state, prev) => {
        if (state.activePage !== prev.activePage) {
          listener(compute());
        }
      });
    },
  };
}

/** Singleton desktop navigation controller for the renderer provider. */
export const desktopNavigationController: NavigationController =
  createDesktopNavigationController();
