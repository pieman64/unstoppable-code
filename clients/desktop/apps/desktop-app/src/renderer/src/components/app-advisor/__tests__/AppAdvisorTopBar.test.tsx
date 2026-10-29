/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppAdvisorTopBar } from '@/components/app-advisor/AppAdvisorTopBar';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const archivedControlMock = jest.fn(
  (props: Record<string, unknown>): JSX.Element => {
    void props;
    return <div data-testid="mock-archived-control" />;
  },
);
jest.mock('@/components/chat/ArchivedChatsControl', () => ({
  ArchivedChatsControl: (props: Record<string, unknown>): JSX.Element =>
    archivedControlMock(props),
}));
const openDropdownMock = jest.fn(
  (props: Record<string, unknown>): JSX.Element => {
    void props;
    return <div data-testid="mock-open-dropdown" />;
  },
);
jest.mock('@/components/worktree/OpenDropdown', () => ({
  OpenDropdown: (props: Record<string, unknown>): JSX.Element =>
    openDropdownMock(props),
}));
const saveLayoutMock = jest.fn(
  (props: Record<string, unknown>): JSX.Element => {
    void props;
    return <div data-testid="mock-save-layout" />;
  },
);
jest.mock('@/components/panels/SaveLayoutDefaultControl', () => ({
  SaveLayoutDefaultControl: (props: Record<string, unknown>): JSX.Element =>
    saveLayoutMock(props),
}));

describe('AppAdvisorTopBar', () => {
  let container: HTMLDivElement;
  let root: Root;
  let startNewChatMock: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    startNewChatMock = jest.fn().mockResolvedValue(undefined);
    useStandaloneChatStore.setState({
      activeChatProjectId: 'app-advisor',
      activeWorkEntryId: 'entry-1',
      startNewChat: startNewChatMock,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  function render(navCollapsed = false): void {
    act(() => {
      root.render(<AppAdvisorTopBar navCollapsed={navCollapsed} />);
    });
  }

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(window, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  function corner(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="app-advisor-top-bar-corner"]',
    );
  }

  it('renders the branded bar with entry-scoped controls and no titlebar toggle', () => {
    render();
    const bar = container.querySelector('[data-testid="app-advisor-top-bar"]');
    expect(bar).toBeTruthy();
    expect(bar?.textContent).toContain('App Advisor');
    // New Chat and the archived-chats control moved into the panel tab strip
    // (the `+` and the tab-strip accessory) — the top bar must NOT mount a
    // second instance of either.
    expect(archivedControlMock).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="app-advisor-top-new-chat"]'),
    ).toBeNull();
    expect(openDropdownMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
      }),
    );
    expect(saveLayoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'app-advisor',
        worktreeId: 'entry-1',
      }),
    );
    // No CollapsedTitlebarToggle in the popout top bar.
    expect(
      container.querySelector('[data-testid="collapsed-titlebar-toggle"]'),
    ).toBeNull();
  });

  it('reserves the titlebar-corner overlay footprint only while collapsed', () => {
    setPlatform('darwin');
    render(true);
    // Traffic-light reserve (72, kept physical under the interface-scale
    // zoom) + toggle gap (16) + 3 controls * 28 + 8, which zoom with the UI.
    expect(corner()?.style.width).toBe(
      'calc(72px / var(--ui-zoom, 1) + 108px)',
    );
    // The spacer hosts no controls — the overlay owns them.
    expect(corner()?.childElementCount).toBe(0);

    render(false);
    expect(corner()?.style.width).toBe('0px');
  });

  it('omits the traffic-light reserve on non-mac platforms', () => {
    setPlatform('win32');
    render(true);
    // Toggle gap (16) + 3 controls * 28 + 8.
    expect(corner()?.style.width).toBe('108px');
  });

  it('renders nothing while no entry is active', () => {
    useStandaloneChatStore.setState({ activeWorkEntryId: null });
    render();
    expect(
      container.querySelector('[data-testid="app-advisor-top-bar"]'),
    ).toBeNull();
  });
});
