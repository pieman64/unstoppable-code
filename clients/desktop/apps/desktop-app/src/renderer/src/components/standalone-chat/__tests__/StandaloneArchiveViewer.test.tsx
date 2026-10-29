/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { StandaloneArchiveViewer } from '@/components/standalone-chat/StandaloneArchiveViewer';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/components/standalone-chat/focusChatTextarea', () => ({
  focusChatTextarea: jest.fn(),
}));

describe('StandaloneArchiveViewer', () => {
  let container: HTMLDivElement;
  let root: Root;
  const resumeArchivedChat = jest.fn().mockResolvedValue(undefined);
  const startNewChat = jest.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    resumeArchivedChat.mockClear();
    startNewChat.mockClear();
    useStandaloneChatStore.setState({ resumeArchivedChat, startNewChat });
    // The legacy viewer opens from the "Archived and deleted" overview, which
    // stays mounted beneath it until an explicit live-target navigation.
    useArchivedContainersStore.setState({
      overview: { workspaceId: 'cowork-1' },
      viewer: null,
    });
    act(() => {
      root.render(
        <StandaloneArchiveViewer
          summary="Summary"
          meta={{
            id: 'legacy-1',
            title: 'Legacy chat',
            description: 'A finished conversation',
            createdAt: '2026-01-01T00:00:00.000Z',
            archived: true,
          }}
          tab={null}
          legacySummaryOnly
        />,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function clickButton(name: string): void {
    const button = Array.from(container.querySelectorAll('button')).find(
      (candidate) =>
        candidate.textContent?.trim() === name ||
        candidate.getAttribute('aria-label') === name,
    );
    if (!button) throw new Error(`Button not found: ${name}`);
    act(() => {
      button.click();
    });
  }

  it('resuming lands in a live chat and dismisses the overview beneath the viewer', () => {
    clickButton('Resume as new chat');
    expect(resumeArchivedChat).toHaveBeenCalledWith('legacy-1');
    expect(useArchivedContainersStore.getState().overview).toBeNull();
  });

  it('blocks the archived chat summary in session replay', () => {
    const summary = container.querySelector(
      '[data-testid="standalone-archive-summary"]',
    );
    expect(summary?.textContent).toContain('Summary');
    expect(summary?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('starting a new chat dismisses the overview too', () => {
    clickButton('New chat');
    expect(startNewChat).toHaveBeenCalledTimes(1);
    expect(useArchivedContainersStore.getState().overview).toBeNull();
  });
});
