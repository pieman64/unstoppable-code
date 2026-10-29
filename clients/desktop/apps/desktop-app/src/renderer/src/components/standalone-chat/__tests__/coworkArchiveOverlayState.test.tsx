/**
 * @jest-environment jsdom
 *
 * The Cowork page reports its panel grid hidden while an archive view covers
 * it; these are the shared selectors behind both that report and the overlay.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { registerCoworkWorkspaceIds } from '@/lib/cowork-registry';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  selectArchivedOverviewWorkspaceForSurface,
  selectArchivedViewerForSurface,
  useCoworkArchiveOverlayOpen,
  type CoworkArchiveOverlaySurface,
} from '../coworkArchiveOverlayState';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function Probe({
  surface,
}: {
  surface: CoworkArchiveOverlaySurface;
}): JSX.Element {
  const open = useCoworkArchiveOverlayOpen(surface);
  return <span data-testid="probe">{String(open)}</span>;
}

describe('coworkArchiveOverlayState', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    registerCoworkWorkspaceIds(['cowork-ws-1']);
    useStandaloneChatStore.setState({ archiveOverlayChatId: null });
    useArchivedContainersStore.setState({ viewer: null, overview: null });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('routes viewers and overviews to the surface that owns their workspace', () => {
    const cowork = { workspaceId: 'cowork-ws-1', containerId: 'c-1' };
    const advisor = { workspaceId: APP_ADVISOR_PROJECT_ID, containerId: 'c-2' };
    const code = { workspaceId: 'code-project', containerId: 'c-3' };
    expect(selectArchivedViewerForSurface(cowork, 'cowork')).toBe(cowork);
    expect(selectArchivedViewerForSurface(cowork, 'app-advisor')).toBeNull();
    expect(selectArchivedViewerForSurface(advisor, 'app-advisor')).toBe(
      advisor,
    );
    expect(selectArchivedViewerForSurface(advisor, 'cowork')).toBeNull();
    expect(selectArchivedViewerForSurface(code, 'cowork')).toBeNull();
    expect(selectArchivedViewerForSurface(null, 'cowork')).toBeNull();
    expect(
      selectArchivedOverviewWorkspaceForSurface(
        { workspaceId: 'cowork-ws-1' },
        'cowork',
      ),
    ).toBe('cowork-ws-1');
    expect(
      selectArchivedOverviewWorkspaceForSurface(
        { workspaceId: 'cowork-ws-1' },
        'app-advisor',
      ),
    ).toBeNull();
  });

  it('reports the Cowork grid covered while any archive view is up', () => {
    act(() => {
      root.render(<Probe surface="cowork" />);
    });
    const probe = (): string | null =>
      container.querySelector('[data-testid="probe"]')?.textContent ?? null;
    expect(probe()).toBe('false');

    act(() => {
      useStandaloneChatStore.setState({ archiveOverlayChatId: 'chat-1' });
    });
    expect(probe()).toBe('true');
    act(() => {
      useStandaloneChatStore.setState({ archiveOverlayChatId: null });
      useArchivedContainersStore.setState({
        overview: { workspaceId: 'cowork-ws-1' },
      });
    });
    expect(probe()).toBe('true');
    act(() => {
      useArchivedContainersStore.setState({
        overview: { workspaceId: APP_ADVISOR_PROJECT_ID },
      });
    });
    expect(probe()).toBe('false');
  });
});
