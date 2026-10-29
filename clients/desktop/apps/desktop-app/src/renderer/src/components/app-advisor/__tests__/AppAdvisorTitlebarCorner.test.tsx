/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppAdvisorTitlebarCorner } from '@/components/app-advisor/AppAdvisorTitlebarCorner';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('AppAdvisorTitlebarCorner', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onToggleCollapsed: jest.Mock;
  let onOpenSettings: jest.Mock;
  let createWorkEntryMock: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onToggleCollapsed = jest.fn();
    onOpenSettings = jest.fn();
    createWorkEntryMock = jest.fn().mockResolvedValue(undefined);
    useStandaloneChatStore.setState({ createWorkEntry: createWorkEntryMock });
    useArchivedContainersStore.setState({
      viewer: null,
      restoringContainer: null,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  function render(collapsed = false): void {
    act(() => {
      root.render(
        <AppAdvisorTitlebarCorner
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
          onOpenSettings={onOpenSettings}
        />,
      );
    });
  }

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(window, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  function byTestId(testId: string): HTMLElement {
    const found = container.querySelector<HTMLElement>(
      `[data-testid="${testId}"]`,
    );
    if (!found) throw new Error(`Element not found: ${testId}`);
    return found;
  }

  function click(testId: string): void {
    act(() => {
      byTestId(testId).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
  }

  it('renders the controls in order after the traffic-light drag spacer (toggle left-most)', () => {
    setPlatform('darwin');
    render();
    const corner = byTestId('app-advisor-titlebar-corner');
    // The icon actions sit inside their rich-tooltip wrapper spans (CAN-2799),
    // so read each slot's control rather than the wrapper itself.
    const children = Array.from(corner.children).map(
      (child) => child.querySelector('[data-testid]') ?? child,
    );
    // Drag spacer covering the traffic lights: the 72px reserve stays
    // physical under the interface-scale zoom, the 16px gap zooms with it.
    expect((children[0] as HTMLElement).style.width).toBe(
      'calc(72px / var(--ui-zoom, 1) + 16px)',
    );
    expect(children[1]?.getAttribute('data-testid')).toBe(
      'app-advisor-nav-collapse',
    );
    expect(children[2]?.getAttribute('data-testid')).toBe(
      'app-advisor-nav-settings',
    );
    expect(children[3]?.getAttribute('data-testid')).toBe(
      'app-advisor-nav-new-entry',
    );
  });

  it('uses only the toggle gap as leading space on non-mac platforms', () => {
    setPlatform('win32');
    render();
    const corner = byTestId('app-advisor-titlebar-corner');
    expect((corner.children[0] as HTMLElement).style.width).toBe('16px');
  });

  it('wires toggle / settings / new-entry interactions in both states', () => {
    setPlatform('darwin');
    render(false);
    const toggle = byTestId('app-advisor-nav-collapse');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse navigation');
    click('app-advisor-nav-collapse');
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    click('app-advisor-nav-settings');
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    click('app-advisor-nav-new-entry');
    expect(createWorkEntryMock).toHaveBeenCalledTimes(1);

    render(true);
    const collapsedToggle = byTestId('app-advisor-nav-collapse');
    expect(collapsedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(collapsedToggle.getAttribute('aria-label')).toBe(
      'Expand navigation',
    );
    click('app-advisor-nav-collapse');
    expect(onToggleCollapsed).toHaveBeenCalledTimes(2);
  });

  it('dismisses the archived-container viewer when creating a new entry', () => {
    setPlatform('darwin');
    useArchivedContainersStore.setState({
      viewer: {
        workspaceId: 'app-advisor',
        containerId: 'container-1',
        tab: 'chats',
      },
      restoringContainer: null,
    });
    render(false);

    click('app-advisor-nav-new-entry');

    expect(useArchivedContainersStore.getState().viewer).toBeNull();
    expect(createWorkEntryMock).toHaveBeenCalledTimes(1);
  });

  it('keeps corner controls on the sticky chrome tier above page overlays', () => {
    setPlatform('darwin');
    render(false);
    // The archived-container overlay renders at z-30 up to the titlebar row
    // (the top bar unmounts while it is open); the corner mounts later in
    // document order at the same z-index so its persistent window-chrome
    // controls stay clickable above the overlay.
    expect(byTestId('app-advisor-titlebar-corner').className).toContain(
      'z-sticky',
    );
  });
});
