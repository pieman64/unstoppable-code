import { useNavigationStore } from '@/stores/navigationStore';
import { createDesktopNavigationController } from '../desktop-navigation-controller';

describe('desktop navigation controller', () => {
  beforeEach(() => {
    useNavigationStore.getState().navigate('overview');
  });

  it('maps the active page to a shared location', () => {
    const controller = createDesktopNavigationController();
    useNavigationStore.getState().navigate('main');
    expect(controller.current).toEqual({ page: 'main' });
  });

  it('maps desktop-only pages to the main fallback', () => {
    const controller = createDesktopNavigationController();
    useNavigationStore.getState().navigate('workers');
    expect(controller.current).toEqual({ page: 'main' });
  });

  it('maps the Feed to its own shared page, not the main fallback', () => {
    const controller = createDesktopNavigationController();
    useNavigationStore.getState().navigate('feed');
    expect(controller.current).toEqual({ page: 'feed' });
  });

  it('navigate() delegates to the store', () => {
    const controller = createDesktopNavigationController();
    controller.navigate({ page: 'chat' });
    expect(useNavigationStore.getState().activePage).toBe('chat');
  });

  it('maps every Workflows tab to the shared Workflows destination and opens Runs for it', () => {
    const controller = createDesktopNavigationController();
    for (const page of [
      'workflows',
      'workflows-schedule',
      'workflows-library',
    ] as const) {
      useNavigationStore.getState().navigate(page);
      expect(controller.current).toEqual({ page: 'pipelines' });
    }

    useNavigationStore.getState().navigate('overview');
    controller.navigate({ page: 'pipelines' });
    expect(useNavigationStore.getState().activePage).toBe('workflows');
  });

  it('notifies only on active-page change, caches current, and unsubscribes', () => {
    const controller = createDesktopNavigationController();
    const seen: string[] = [];
    const unsubscribe = controller.subscribe((loc) => seen.push(loc.page));

    useNavigationStore.getState().navigate('pipelines');
    // An overlay-only change must not notify the page controller.
    useNavigationStore.getState().openSettings();

    // `current` is a stable reference while the page is unchanged.
    expect(controller.current).toBe(controller.current);

    unsubscribe();
    useNavigationStore.getState().navigate('audit');
    expect(seen).toEqual(['pipelines']);
  });
});
