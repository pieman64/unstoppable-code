/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useNavigationStore } from '@/stores/navigationStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  CoworkWorkEntryListResponse,
  WorkspaceContextState,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { syncSelectionForContextChange } from '@/lib/workspaceContextSelection';
import { openForkedContainer } from '@/lib/shared-containers/open-forked-container';
import { ForkedContainerNotice } from '../ForkedContainerNotice';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let readForkProvenance: jest.Mock;

beforeEach(() => {
  readForkProvenance = jest.fn(() =>
    Promise.resolve({
      sourceContainerId: 'container-1',
      sourceRevisionId: 'revision-1',
      sourceOwnerDisplayName: 'Dana',
      organizationId: 'org-1',
      forkedAt: '2026-09-09T10:00:00.000Z',
    }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { sharedContainers: { readForkProvenance } },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  useNavigationStore.setState({
    activePage: 'main',
    pendingForkedContainerFocus: undefined,
    forkedContainerFocusHolds: 0,
  });
  useSharedContainerReplicasStore.setState({ viewer: null });
  useWorkspaceContextStore.setState({ accountEpoch: 0 });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('surfaces durable provenance for the selected local container', async () => {
  await act(async () => {
    root.render(
      <ForkedContainerNotice projectId="workspace-1" worktreeId="worktree-1" />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(readForkProvenance).toHaveBeenCalledWith({
    projectId: 'workspace-1',
    worktreeId: 'worktree-1',
  });
  expect(
    container.querySelector('[data-testid="shared-container-fork-provenance"]')
      ?.textContent,
  ).toContain('Dana');
});

it('renders nothing for an ordinary local container', async () => {
  readForkProvenance.mockResolvedValueOnce(null);

  await act(async () => {
    root.render(
      <ForkedContainerNotice projectId="workspace-1" worktreeId="worktree-1" />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  expect(container.textContent).toBe('');
});

describe('focus after a copy opens (CAN-4782)', () => {
  const FOCUS_TARGET = { page: 'main', headerTestId: 'test-header' } as const;

  function requestFocus(
    overrides: Partial<{ projectId: string; worktreeId: string }> = {},
  ): void {
    useNavigationStore.getState().requestForkedContainerFocus({
      projectId: 'workspace-1',
      worktreeId: 'worktree-1',
      page: 'main',
      accountEpoch: 0,
      ...overrides,
    });
  }

  async function renderNotice(
    projectId = 'workspace-1',
    worktreeId = 'worktree-1',
  ): Promise<void> {
    await act(async () => {
      root.render(
        <>
          <div data-testid="test-header">
            <button type="button" data-testid="test-header-button">
              Header
            </button>
          </div>
          <ForkedContainerNotice
            projectId={projectId}
            worktreeId={worktreeId}
            focusTarget={FOCUS_TARGET}
          />
        </>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function blurActiveElement(): void {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function provenanceLine(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      '[data-testid="shared-container-fork-provenance"]',
    );
  }

  it('focuses the provenance line once and consumes the request', async () => {
    requestFocus();
    await renderNotice();

    expect(document.activeElement).toBe(provenanceLine());
    expect(provenanceLine()?.getAttribute('tabindex')).toBe('-1');
    expect(
      useNavigationStore.getState().pendingForkedContainerFocus,
    ).toBeUndefined();

    // A rerender does not take focus back.
    blurActiveElement();
    await renderNotice();
    expect(document.activeElement).not.toBe(provenanceLine());
  });

  it('focuses provenance that is already loaded when the request arrives', async () => {
    await renderNotice();
    expect(provenanceLine()).not.toBeNull();

    await act(async () => {
      requestFocus();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(provenanceLine());
  });

  it('waits for delayed provenance instead of falling back early', async () => {
    let resolveRead: (value: unknown) => void = () => undefined;
    readForkProvenance.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    requestFocus();
    await renderNotice();

    expect(document.activeElement).toBe(document.body);
    expect(
      useNavigationStore.getState().pendingForkedContainerFocus,
    ).toBeDefined();

    await act(async () => {
      resolveRead({
        sourceContainerId: 'container-1',
        sourceRevisionId: 'revision-1',
        sourceOwnerDisplayName: 'Dana',
        organizationId: 'org-1',
        forkedAt: '2026-09-09T10:00:00.000Z',
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(provenanceLine());
  });

  it('cancels delayed focus when deselection unmounts the destination', async () => {
    useChatStore.setState({
      selectedWorktree: { projectId: 'workspace-1', worktreeId: 'worktree-1' },
    });
    readForkProvenance.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    requestFocus();
    await renderNotice();
    act(() => {
      useChatStore.setState({ selectedWorktree: null });
      root.render(null);
    });
    expect(
      useNavigationStore.getState().pendingForkedContainerFocus,
    ).toBeUndefined();
  });

  it('delivers delayed provenance focus after real cold context restoration reselects the copy', async () => {
    const chatBefore = useChatStore.getState();
    const projectsBefore = useProjectsStore.getState();
    const standaloneBefore = useStandaloneChatStore.getState();
    const contextBefore = useWorkspaceContextStore.getState();
    const flagsBefore = useFeatureFlagsStore.getState().snapshot;
    const apiBefore = window.api;
    const personal: WorkspaceContext = { kind: 'personal' };
    const organization: WorkspaceContext = {
      kind: 'organization',
      organizationId: 'org-1',
    };
    const copy = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
    const remembered = {
      projectId: 'cowork-1',
      worktreeId: 'remembered-entry',
    };
    let finishListing: (result: CoworkWorkEntryListResponse) => void = () =>
      undefined;
    const listing = new Promise<CoworkWorkEntryListResponse>((resolve) => {
      finishListing = resolve;
    });
    let finishRead: () => void = () => undefined;
    readForkProvenance.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = (): void =>
            resolve({
              sourceContainerId: 'share-1',
              sourceRevisionId: 'revision-1',
              sourceOwnerDisplayName: 'Dana',
              organizationId: 'org-1',
              forkedAt: '2026-10-22T10:00:00.000Z',
            });
        }),
    );
    Object.assign(window.api, {
      standaloneChat: { init: jest.fn(() => Promise.resolve()) },
      workEntries: { list: jest.fn(() => listing) },
    });
    useFeatureFlagsStore.setState({
      snapshot: {
        ...flagsBefore,
        values: {
          ...flagsBefore.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    useChatStore.setState({
      selectedWorktree: null,
      selectWorktree: (projectId, worktreeId): void => {
        useChatStore.setState({ selectedWorktree: { projectId, worktreeId } });
      },
      deselectWorktree: (): void => {
        useChatStore.setState({ selectedWorktree: null });
      },
      ensureModelDefaultsLoaded: jest.fn(() => Promise.resolve(null)),
      loadTabs: jest.fn(() => Promise.resolve()),
      syncActiveEmptyTabToDefaults: jest.fn(() => Promise.resolve()),
      setWorktreeDefaultPlugins: jest.fn(),
    });
    useProjectsStore.setState({
      loadProjects: jest.fn(() => Promise.resolve()),
      projects: [
        {
          type: 'single-repo',
          id: 'workspace-1',
          name: 'Code',
          repoPath: '/code',
          color: '#000000',
          collapsed: false,
          order: 0,
          worktrees: [],
        },
        {
          type: 'cowork',
          id: 'cowork-1',
          name: 'Cowork',
          color: '#000000',
          collapsed: false,
          order: 1,
        },
      ],
    });
    useStandaloneChatStore.setState({
      initialized: false,
      scopedWorkspaceId: null,
      activeChatProjectId: 'cowork-1',
      activeWorkEntryId: null,
      workEntries: [],
      chatProjects: [
        { id: 'cowork-1', name: 'Cowork', createdAt: '2026-07-01' },
      ],
      loadChatProjects: jest.fn(() => Promise.resolve()),
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: organization,
        revision: 1,
        organizations: [{ id: 'org-1', name: 'Acme', role: 'MEMBER' }],
      },
      lastSelectionByContext: { personal: remembered },
      setContext: (context): Promise<WorkspaceContextState> => {
        useWorkspaceContextStore.setState((state) => ({
          state: { ...state.state, context },
        }));
        syncSelectionForContextChange(organization, context);
        return Promise.resolve(useWorkspaceContextStore.getState().state);
      },
    });
    let sawRemembered = false;
    let stopObserving: () => void = () => undefined;
    const restored = new Promise<void>((resolve) => {
      stopObserving = useChatStore.subscribe((state): void => {
        const selected = state.selectedWorktree;
        if (
          selected?.projectId === remembered.projectId &&
          selected.worktreeId === remembered.worktreeId
        )
          sawRemembered = true;
        if (
          sawRemembered &&
          selected?.projectId === copy.projectId &&
          selected.worktreeId === copy.worktreeId
        ) {
          stopObserving();
          resolve();
        }
      });
    });
    try {
      const opened = await openForkedContainer({
        containerType: 'CODE_WORKTREE',
        ...copy,
        warnings: [],
        provenance: {
          sourceContainerId: 'share-1',
          sourceRevisionId: 'revision-1',
          sourceOwnerDisplayName: 'Dana',
          organizationId: 'org-1',
          forkedAt: '2026-10-22T10:00:00.000Z',
        },
      });
      expect(opened).toEqual({ switchedTo: personal });
      await renderNotice();
      await act(async () => {
        finishListing({
          entries: [
            {
              id: remembered.worktreeId,
              title: 'Remembered worktree',
              createdAt: '2026-07-01',
              chatCount: 0,
            },
          ],
        });
        await restored;
      });
      expect(useChatStore.getState().selectedWorktree).toEqual(copy);
      expect(
        useNavigationStore.getState().pendingForkedContainerFocus,
      ).toBeDefined();
      await act(async () => {
        finishRead();
        await Promise.resolve();
      });
      expect(document.activeElement).toBe(provenanceLine());
      expect(
        useNavigationStore.getState().pendingForkedContainerFocus,
      ).toBeUndefined();
    } finally {
      stopObserving();
      await act(async () => {
        finishListing({
          entries: [
            {
              id: remembered.worktreeId,
              title: 'Remembered worktree',
              createdAt: '2026-07-01',
              chatCount: 0,
            },
          ],
        });
        finishRead();
        useChatStore.setState(chatBefore);
        useProjectsStore.setState(projectsBefore);
        useStandaloneChatStore.setState(standaloneBefore);
        useWorkspaceContextStore.setState(contextBefore);
        useFeatureFlagsStore.setState({ snapshot: flagsBefore });
        await Promise.resolve();
      });
      Object.defineProperty(window, 'api', {
        configurable: true,
        writable: true,
        value: apiBefore,
      });
    }
  });

  it.each(['page', 'account'])(
    'does not focus after leaving the %s while provenance is pending',
    async (departure) => {
      let finishRead: () => void = () => undefined;
      readForkProvenance.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = (): void => resolve(null);
          }),
      );
      requestFocus();
      await renderNotice();
      await act(async () => {
        if (departure === 'page') {
          useNavigationStore.getState().navigate('chat');
        } else {
          useWorkspaceContextStore.setState({ accountEpoch: 1 });
        }
        finishRead();
        await Promise.resolve();
      });
      act(() => useNavigationStore.getState().navigate('main'));
      expect(document.activeElement).toBe(document.body);
      expect(
        useNavigationStore.getState().pendingForkedContainerFocus,
      ).toBeUndefined();
    },
  );

  it.each([
    [
      'is missing',
      (): void => void readForkProvenance.mockResolvedValueOnce(null),
    ],
    [
      'fails to load',
      (): void =>
        void readForkProvenance.mockRejectedValueOnce(new Error('unreadable')),
    ],
  ])('focuses the header when provenance %s', async (_label, arrange) => {
    arrange();
    requestFocus();
    await renderNotice();

    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'test-header-button',
    );
    expect(
      useNavigationStore.getState().pendingForkedContainerFocus,
    ).toBeUndefined();
  });

  it('cancels a request for another destination without taking focus', async () => {
    requestFocus({ worktreeId: 'worktree-2' });
    await renderNotice();

    expect(document.activeElement).toBe(document.body);
    expect(
      useNavigationStore.getState().pendingForkedContainerFocus,
    ).toBeUndefined();
  });

  it('cancels a request that outlived an account change', async () => {
    requestFocus();
    useWorkspaceContextStore.setState({ accountEpoch: 1 });
    await renderNotice();

    expect(document.activeElement).toBe(document.body);
    expect(
      useNavigationStore.getState().pendingForkedContainerFocus,
    ).toBeUndefined();
  });

  it('waits while the share viewer covers the copy', async () => {
    useSharedContainerReplicasStore.setState({
      viewer: {
        containerId: 'container-1',
        replica: null,
        openError: null,
        loading: false,
      },
    });
    requestFocus();
    await renderNotice();
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      useSharedContainerReplicasStore.setState({ viewer: null });
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(provenanceLine());
  });

  it('waits until the fork dialog is gone', async () => {
    const release = useNavigationStore.getState().holdForkedContainerFocus();
    requestFocus();
    await renderNotice();
    expect(document.activeElement).toBe(document.body);

    await act(async () => {
      release();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(provenanceLine());
  });

  it('waits while another page is shown', async () => {
    requestFocus();
    useNavigationStore.setState({ activePage: 'chat' });
    await renderNotice();

    expect(document.activeElement).toBe(document.body);
    expect(
      useNavigationStore.getState().pendingForkedContainerFocus,
    ).toBeDefined();
  });

  it('focuses again for a repeated request for the same copy', async () => {
    requestFocus();
    await renderNotice();
    blurActiveElement();

    await act(async () => {
      requestFocus();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(provenanceLine());
  });

  it('leaves requests alone where no fork can land', async () => {
    requestFocus();
    await act(async () => {
      root.render(
        <ForkedContainerNotice
          projectId="workspace-1"
          worktreeId="worktree-1"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.activeElement).toBe(document.body);
    expect(
      useNavigationStore.getState().pendingForkedContainerFocus,
    ).toBeDefined();
  });
});
