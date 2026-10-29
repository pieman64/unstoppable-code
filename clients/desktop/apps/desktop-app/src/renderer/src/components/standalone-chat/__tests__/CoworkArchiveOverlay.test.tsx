/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArchivedContainerSummary } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { CoworkArchiveOverlay } from '@/components/standalone-chat/CoworkArchiveOverlay';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/components/standalone-chat/StandaloneArchiveViewer', () => ({
  StandaloneArchiveViewer: ({
    summary,
  }: {
    summary: string | null;
  }): JSX.Element => <div data-testid="mock-archive-viewer">{summary}</div>,
}));

jest.mock('@/components/archive/ArchivedContainersOverviewPage', () => ({
  ArchivedContainersOverviewPage: ({
    workspaceId,
    surface,
    onClose,
  }: {
    workspaceId: string;
    surface: string;
    onClose: () => void;
  }): JSX.Element => (
    <div data-testid="mock-archived-overview-page" data-surface={surface}>
      <span>{workspaceId}</span>
      <button
        type="button"
        data-testid="mock-archived-overview-close"
        onClick={onClose}
      >
        Back
      </button>
    </div>
  ),
}));

jest.mock('@/components/archive/ArchivedContainerView', () => ({
  ArchivedContainerView: ({
    workspaceId,
    containerId,
    onClose,
  }: {
    workspaceId: string;
    containerId: string;
    onClose: () => void;
  }): JSX.Element => (
    <div data-testid="mock-archived-container-view">
      <span>{`${workspaceId}:${containerId}`}</span>
      <button
        type="button"
        data-testid="mock-archived-container-view-close"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  ),
}));

function makeContainerSummary(
  id: string,
  projectId: string,
  kind: 'worktree' | 'work-entry',
): ArchivedContainerSummary {
  return {
    version: 1,
    id,
    kind,
    projectId,
    name: `Container ${id}`,
    createdAt: '2026-07-01T00:00:00.000Z',
    archivedAt: '2026-07-20T00:00:00.000Z',
    retentionDays: 30,
    expiresAt: '2026-08-19T00:00:00.000Z',
    chatCount: 1,
    archivedChatCount: 0,
    executionCount: 0,
  };
}

describe('CoworkArchiveOverlay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        standaloneChat: {
          list: jest.fn().mockResolvedValue({ chats: [] }),
        },
      },
    });
    useStandaloneChatStore.setState({
      archiveOverlayChatId: null,
      activeSummary: null,
      activeArchiveData: null,
      activeChatProjectId: 'cowork-default',
      legacyArchivedByProject: { 'cowork-default': [] },
    });
    useArchivedContainersStore.setState({
      byWorkspace: {},
      loadedWorkspaces: {},
      viewer: null,
      overview: null,
    });
    // The cowork-surface gate resolves the owning workspace through the
    // cowork registry (synchronously, without waiting on summaries).
    registerCoworkWorkspaceIds(['cowork-default', 'cowork-ws-1']);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  function render(surface?: 'cowork' | 'app-advisor'): void {
    act(() => {
      root.render(
        surface === undefined ? (
          <CoworkArchiveOverlay />
        ) : (
          <CoworkArchiveOverlay surface={surface} />
        ),
      );
    });
  }

  it('renders nothing when no archived chat is selected', () => {
    render();
    expect(
      container.querySelector('[data-testid="cowork-archive-overlay"]'),
    ).toBeNull();
  });

  it('shows a loading state while the summary is generating', () => {
    act(() => {
      useStandaloneChatStore.setState({
        archiveOverlayChatId: 'chat-1',
        activeSummary: '__loading__',
      });
    });
    render();
    expect(
      container.querySelector('[data-testid="cowork-archive-overlay"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain('Loading archive…');
  });

  it('uses the highest context-local tier below semantic overlays', () => {
    // Chat grid/composer surfaces (e.g. ChatInput's banner root) reach z-30;
    // semantic app modals sit above local layers. The overlay must fully cover the composer so it
    // cannot be focused or clicked while an archive is open — in both the
    // cowork page and the App Advisor popout, which share this component.
    act(() => {
      useStandaloneChatStore.setState({
        archiveOverlayChatId: 'chat-1',
        activeSummary: '__loading__',
      });
    });
    render();
    const overlay = container.querySelector(
      '[data-testid="cowork-archive-overlay"]',
    );
    if (!overlay) throw new Error('Overlay not found');
    expect(overlay.className).toContain('z-30');
    expect(overlay.className).not.toContain('z-20');
    expect(overlay.className).toContain('absolute');
    expect(overlay.className).toContain('inset-0');
  });

  it('renders the archive viewer and closes without touching chat selection', () => {
    act(() => {
      useStandaloneChatStore.setState({
        archiveOverlayChatId: 'chat-1',
        activeSummary: 'A summary',
        activeArchiveData: {
          summary: 'A summary',
          legacySummaryOnly: true,
          tab: null,
        },
      });
    });
    render();
    expect(
      container.querySelector('[data-testid="mock-archive-viewer"]')
        ?.textContent,
    ).toBe('A summary');

    const close = container.querySelector(
      '[data-testid="cowork-archive-overlay-close"]',
    );
    if (!close) throw new Error('Overlay close button not found');
    act(() => {
      close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useStandaloneChatStore.getState().archiveOverlayChatId).toBeNull();
    expect(
      container.querySelector('[data-testid="cowork-archive-overlay"]'),
    ).toBeNull();
  });

  describe('archived work-entry container viewer', () => {
    function openWorkEntryViewer(
      workspaceId: string,
      containerId: string,
    ): void {
      act(() => {
        useArchivedContainersStore.setState({
          byWorkspace: {
            [workspaceId]: [
              makeContainerSummary(containerId, workspaceId, 'work-entry'),
            ],
          },
          loadedWorkspaces: { [workspaceId]: true },
          viewer: { workspaceId, containerId, tab: 'chats' },
        });
      });
    }

    it('renders ArchivedContainerView in the z-30 overlay wrapper for a cowork work entry', () => {
      openWorkEntryViewer('cowork-ws-1', 'container-1');
      render();

      const overlay = container.querySelector(
        '[data-testid="cowork-archive-overlay"]',
      );
      if (!overlay) throw new Error('Overlay not found');
      expect(overlay.className).toContain('z-30');
      expect(overlay.className).toContain('absolute');
      expect(overlay.className).toContain('inset-0');
      expect(
        container.querySelector('[data-testid="mock-archived-container-view"]')
          ?.textContent,
      ).toContain('cowork-ws-1:container-1');
    });

    it('takes precedence over the legacy single-chat archive viewer', () => {
      act(() => {
        useStandaloneChatStore.setState({
          archiveOverlayChatId: 'chat-1',
          activeSummary: 'A summary',
          activeArchiveData: {
            summary: 'A summary',
            legacySummaryOnly: true,
            tab: null,
          },
        });
      });
      openWorkEntryViewer('cowork-ws-1', 'container-1');
      render();

      expect(
        container.querySelector('[data-testid="mock-archived-container-view"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="mock-archive-viewer"]'),
      ).toBeNull();
    });

    it('closes the container viewer via onClose', () => {
      openWorkEntryViewer('cowork-ws-1', 'container-1');
      render();

      const close = container.querySelector(
        '[data-testid="mock-archived-container-view-close"]',
      );
      if (!close) throw new Error('Container viewer close button not found');
      act(() => {
        close.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(useArchivedContainersStore.getState().viewer).toBeNull();
      // Back lands on the workspace's "Archived and deleted" list rather than
      // dropping straight to the live chat surface.
      expect(
        container.querySelector('[data-testid="mock-archived-overview-page"]')
          ?.textContent,
      ).toContain('cowork-ws-1');
    });

    it('cowork instance ignores App Advisor containers', () => {
      openWorkEntryViewer(APP_ADVISOR_PROJECT_ID, 'container-adv');
      render();

      expect(
        container.querySelector('[data-testid="cowork-archive-overlay"]'),
      ).toBeNull();
    });

    it('app-advisor instance renders only App Advisor containers', () => {
      openWorkEntryViewer(APP_ADVISOR_PROJECT_ID, 'container-adv');
      render('app-advisor');

      expect(
        container.querySelector('[data-testid="mock-archived-container-view"]')
          ?.textContent,
      ).toContain(`${APP_ADVISOR_PROJECT_ID}:container-adv`);
      // The popout unmounts AppAdvisorTopBar while the viewer is open; the
      // overlay reserves the 43px titlebar row (drag region + the strip the
      // persistent corner controls sit over) in its place.
      const overlay = container.querySelector(
        '[data-testid="cowork-archive-overlay"]',
      );
      expect(overlay?.firstElementChild?.className).toContain('electron-drag');
      expect(overlay?.firstElementChild?.className).toContain('h-10.75');
    });

    it('cowork instance renders the container viewer without a titlebar spacer', () => {
      openWorkEntryViewer('cowork-ws-1', 'container-1');
      render('cowork');

      const overlay = container.querySelector(
        '[data-testid="cowork-archive-overlay"]',
      );
      expect(overlay?.firstElementChild?.getAttribute('data-testid')).toBe(
        'mock-archived-container-view',
      );
    });

    it('app-advisor instance ignores non-advisor cowork containers', () => {
      openWorkEntryViewer('cowork-ws-1', 'container-1');
      render('app-advisor');

      expect(
        container.querySelector('[data-testid="cowork-archive-overlay"]'),
      ).toBeNull();
    });

    it('renders nothing for a worktree-kind container (WorktreeManager owns those)', () => {
      act(() => {
        useArchivedContainersStore.setState({
          byWorkspace: {
            'code-ws-1': [
              makeContainerSummary('container-wt', 'code-ws-1', 'worktree'),
            ],
          },
          loadedWorkspaces: { 'code-ws-1': true },
          viewer: {
            workspaceId: 'code-ws-1',
            containerId: 'container-wt',
            tab: 'chats',
          },
        });
      });
      render();

      expect(
        container.querySelector('[data-testid="cowork-archive-overlay"]'),
      ).toBeNull();
    });
  });

  describe('archived and deleted overview page', () => {
    it('renders the overview for a cowork project and closes it via Back', () => {
      act(() => {
        useArchivedContainersStore.setState({
          overview: { workspaceId: 'cowork-ws-1' },
          viewer: null,
        });
      });
      render();

      const page = container.querySelector<HTMLElement>(
        '[data-testid="mock-archived-overview-page"]',
      );
      expect(page?.textContent).toContain('cowork-ws-1');
      expect(page?.getAttribute('data-surface')).toBe('cowork');
      expect(
        container.querySelector('[data-testid="cowork-archive-overlay"]')
          ?.className,
      ).toContain('z-30');

      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="mock-archived-overview-close"]',
          )
          ?.click();
      });
      expect(useArchivedContainersStore.getState().overview).toBeNull();
      expect(
        container.querySelector('[data-testid="mock-archived-overview-page"]'),
      ).toBeNull();
    });

    it('stacks the container viewer above the overview and returns to it on Back', () => {
      act(() => {
        useArchivedContainersStore.setState({
          byWorkspace: {
            'cowork-ws-1': [
              makeContainerSummary('container-1', 'cowork-ws-1', 'work-entry'),
            ],
          },
          loadedWorkspaces: { 'cowork-ws-1': true },
        });
        useArchivedContainersStore
          .getState()
          .openViewer('cowork-ws-1', 'container-1');
      });
      render();

      expect(
        container.querySelector('[data-testid="mock-archived-container-view"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="mock-archived-overview-page"]'),
      ).toBeNull();

      act(() => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="mock-archived-container-view-close"]',
          )
          ?.click();
      });
      expect(useArchivedContainersStore.getState().viewer).toBeNull();
      expect(useArchivedContainersStore.getState().overview).toEqual({
        workspaceId: 'cowork-ws-1',
      });
      expect(
        container.querySelector('[data-testid="mock-archived-overview-page"]'),
      ).toBeTruthy();
    });

    it('lets the legacy single-chat viewer sit above the overview', () => {
      act(() => {
        useArchivedContainersStore.setState({
          overview: { workspaceId: 'cowork-ws-1' },
          viewer: null,
        });
        useStandaloneChatStore.setState({
          archiveOverlayChatId: 'chat-1',
          activeSummary: 'A summary',
          activeArchiveData: {
            summary: 'A summary',
            legacySummaryOnly: true,
            tab: null,
          },
        });
      });
      render();
      expect(
        container.querySelector('[data-testid="mock-archive-viewer"]'),
      ).toBeTruthy();
      expect(
        container.querySelector('[data-testid="mock-archived-overview-page"]'),
      ).toBeNull();
    });

    it('app-advisor instance renders only the App Advisor overview, with the titlebar spacer', () => {
      act(() => {
        useArchivedContainersStore.setState({
          overview: { workspaceId: 'cowork-ws-1' },
          viewer: null,
        });
      });
      render('app-advisor');
      expect(
        container.querySelector('[data-testid="mock-archived-overview-page"]'),
      ).toBeNull();

      act(() => {
        useArchivedContainersStore.setState({
          overview: { workspaceId: APP_ADVISOR_PROJECT_ID },
        });
      });
      const page = container.querySelector<HTMLElement>(
        '[data-testid="mock-archived-overview-page"]',
      );
      expect(page?.getAttribute('data-surface')).toBe('app-advisor');
      expect(container.querySelector('.electron-drag.h-10\\.75')).toBeTruthy();
    });
  });
});
