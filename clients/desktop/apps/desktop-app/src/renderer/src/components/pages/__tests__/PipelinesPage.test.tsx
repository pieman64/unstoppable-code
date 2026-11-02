/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '../../../stores/featureFlagsStore';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PipelinesPage, type PipelinesPageListApi } from '../PipelinesPage';
import {
  consumePipelineAssistantOpenRequest,
  requestPipelineAssistantOpen,
} from '../../../lib/pipelineAssistantEvents';
import {
  registerNavigationGuard,
  useNavigationStore,
} from '../../../stores/navigationStore';
import { useChatStore } from '../../../stores/chatStore';
import {
  usePipelineEditorBridgeStore,
  type PipelineEditorControllerTarget,
  type PipelineEditorPageController,
} from '../../../stores/pipelineEditorBridgeStore';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';

let mockPipelines: PipelineInfo[] = [];
const mockRefresh = jest.fn(() => Promise.resolve());
const mockDuplicatePipeline = jest.fn<
  Promise<PipelineInfo | null>,
  [PipelineInfo]
>(() => Promise.resolve(null));

jest.mock('../../../hooks/usePipelineList', (): unknown => ({
  usePipelineList: () => ({
    pipelines: mockPipelines,
    loading: false,
    error: null,
    refresh: mockRefresh,
    deletePipeline: jest.fn(() => Promise.resolve(true)),
    duplicatePipeline: (pipeline: PipelineInfo): Promise<PipelineInfo | null> =>
      mockDuplicatePipeline(pipeline),
    disabledPipelineIds: new Set(),
    setPipelineEnabled: jest.fn(() => Promise.resolve()),
    shared: {
      cloudAccount: null,
      cloudLoading: false,
      rows: [],
      loading: false,
      loadingMore: false,
      nextCursor: null,
      error: null,
      loaded: false,
      refreshShared: jest.fn(() => Promise.resolve()),
      loadMoreShared: jest.fn(() => Promise.resolve()),
      setFilters: jest.fn(),
      removeSharedRow: jest.fn(),
    },
    deleteSharedPipeline: jest.fn(() => Promise.resolve(true)),
    setSharedFilters: jest.fn(),
    refreshSharedList: jest.fn(() => Promise.resolve()),
    loadMoreShared: jest.fn(() => Promise.resolve()),
  }),
}));

interface CapturedListProps {
  pipelines?: PipelineInfo[];
  onEdit?: (pipeline: PipelineInfo) => void;
  onCreateNew?: () => void;
  onShare?: (info: PipelineInfo) => void;
  sharePendingId?: string | null;
  actionError?: string | null;
}
let capturedListProps: CapturedListProps = {};

jest.mock('../../pipeline/PipelineListView', () => ({
  PipelineListView: (props: CapturedListProps): JSX.Element => {
    capturedListProps = props;
    const firstPipeline = props.pipelines?.[0];
    return (
      <div data-testid="pipeline-list">
        Pipeline list
        {firstPipeline && props.onEdit ? (
          <button
            type="button"
            data-testid="open-first-pipeline"
            onClick={() => props.onEdit?.(firstPipeline)}
          >
            Open
          </button>
        ) : null}
      </div>
    );
  },
}));

jest.mock('../../pipeline/SharePipelineModal', () => ({
  SharePipelineModal: ({
    localPipelineInfo,
    worktree,
  }: {
    localPipelineInfo: PipelineInfo;
    worktree?: { projectId: string; worktreeId: string };
  }): JSX.Element => (
    <div
      data-testid="share-modal"
      data-project-id={worktree?.projectId}
      data-worktree-id={worktree?.worktreeId}
    >
      {localPipelineInfo.id}
    </div>
  ),
}));

// `useShareAccess.requestShare` NEVER calls `proceed` synchronously in
// production: the connected path defers it behind
// `await window.api.loadCanopyCloudAccount()`, and the gated path defers it
// until the user closes `CloudSyncModal`. `deferProceed` lets a test reproduce
// that real shape; the default stays synchronous for the simple race cases.
let deferProceed = false;
// An ARRAY, not a single slot: `requestShare` runs an independent async chain
// per call with no dedupe, so two clicks can be gated at once. A single slot
// would silently overwrite the first and make that interleaving untestable.
let pendingProceeds: Array<() => void> = [];

jest.mock('../../../hooks/useShareAccess', () => ({
  useShareAccess: (): unknown => ({
    requestShare: (_context: string, proceed: () => void): void => {
      if (deferProceed) {
        pendingProceeds.push(proceed);
        return;
      }
      proceed();
    },
    shareGateModal: null,
  }),
}));

const mockFetchPipelineDocument = jest.fn<
  Promise<unknown>,
  [PipelineInfo, string?]
>();
jest.mock('@/lib/pipelineDocument', () => ({
  fetchPipelineDocument: (...args: [PipelineInfo, string?]): Promise<unknown> =>
    mockFetchPipelineDocument(...args),
  pipelineInfoToDocumentLocator: (
    info: PipelineInfo,
    cwd?: string,
  ): unknown => ({
    pipelineId: info.id,
    ...(info.source === 'project' && cwd ? { cwd } : {}),
    ...(info.source === 'project' && info.filePath
      ? { pipelineFilePath: info.filePath }
      : {}),
    ...(info.source === 'bundled' ||
    info.source === 'user' ||
    info.source === 'curated'
      ? { pipelineSource: info.source }
      : {}),
    ...(info.source === 'shared' && info.remoteId
      ? { sharedRemoteId: info.remoteId }
      : {}),
  }),
}));

jest.mock('../../pipeline/PipelineChatPanel', () => ({
  PipelineChatPanel: (): JSX.Element => (
    <div data-testid="pipeline-chat-panel">Pipeline chat</div>
  ),
}));

let mockHasConversation = false;
jest.mock('../../pipeline/pipelineAssistantConversation', () => ({
  pipelineAssistantHasConversation: jest.fn(() =>
    Promise.resolve(mockHasConversation),
  ),
}));

jest.mock('../../pipeline/PipelineEditorRuntimeBridge', () => ({
  PipelineEditorRuntimeBridge: (): JSX.Element => (
    <div data-testid="pipeline-editor-runtime-bridge" />
  ),
}));

describe('PipelinesPage edit shell (CAN-4072)', () => {
  let container: HTMLElement;
  let root: Root;
  let api: PipelinesPageListApi | null = null;
  let disposeGuard: (() => void) | null = null;

  const PROJECT_REVIEW: PipelineInfo = {
    id: 'project-review',
    name: 'Project review',
    filename: 'review.yml',
    description: '',
    icon: '',
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    source: 'project',
    readonly: true,
    filePath: '/repo-a/.canopy/pipelines/review.yml',
  };
  const USER_REVIEW: PipelineInfo = {
    ...PROJECT_REVIEW,
    id: 'review',
    name: 'Review',
    source: 'user',
    readonly: false,
    filePath: undefined,
  };

  function pageController(): PipelineEditorPageController {
    const controller = usePipelineEditorBridgeStore.getState().pageController;
    if (!controller) throw new Error('No page controller registered');
    return controller;
  }

  /** A dirty item's guard whose prompt the person answers with Keep editing. */
  function keepEditing(): void {
    disposeGuard = registerNavigationGuard(() => Promise.resolve(false));
  }

  async function renderPage(
    props: { assistantEnabled?: boolean; withList?: boolean } = {},
  ): Promise<void> {
    await act(async () => {
      root.render(
        <PipelinesPage
          assistantEnabled={props.assistantEnabled}
          {...(props.withList
            ? {
                renderList: (next: PipelinesPageListApi): JSX.Element => {
                  api = next;
                  return <div data-testid="custom-list" />;
                },
              }
            : {})}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function listApi(): PipelinesPageListApi {
    if (!api) throw new Error('The list was not rendered');
    return api;
  }

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        getWorktreePath: jest.fn(),
        loadPreferences: jest.fn(() => Promise.resolve({})),
        savePreferences: jest.fn(() => Promise.resolve()),
      },
    });
    useNavigationStore.setState({
      activePage: 'workflows-library',
      workflowEdit: undefined,
    });
    usePipelineEditorBridgeStore.setState({
      editorController: null,
      pageController: null,
    });
    useChatStore.setState({ selectedWorktree: null });
    mockPipelines = [];
    mockHasConversation = false;
    mockDuplicatePipeline.mockReset();
    mockDuplicatePipeline.mockResolvedValue(null);
    capturedListProps = {};
    api = null;
    consumePipelineAssistantOpenRequest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    disposeGuard?.();
    disposeGuard = null;
    act(() => {
      root.unmount();
    });
    container.remove();
    usePipelineEditorBridgeStore.setState({
      editorController: null,
      pageController: null,
    });
    useNavigationStore.setState({ workflowEdit: undefined });
  });

  it('opens a row in the edit shell and keeps its own list', async () => {
    mockPipelines = [USER_REVIEW];
    await renderPage();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-first-pipeline"]')
        ?.click();
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'pipeline',
      pipelineId: 'review',
      source: 'user',
    });
    // The page no longer draws an editor: WorkflowsPage shows the shell.
    expect(container.querySelector('[data-testid="pipeline-list"]')).not.toBe(
      null,
    );
  });

  it("opens a project row with the selected worktree's checkout", async () => {
    mockPipelines = [PROJECT_REVIEW];
    jest
      .mocked(window.api.getWorktreePath)
      .mockResolvedValueOnce('/repo-a')
      .mockResolvedValueOnce('/repo-b');
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'worktree-a' },
    });
    await renderPage();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-first-pipeline"]')
        ?.click();
      await Promise.resolve();
    });
    const opened = {
      kind: 'pipeline',
      pipelineId: 'project-review',
      cwd: '/repo-a',
      filePath: '/repo-a/.canopy/pipelines/review.yml',
    };
    expect(useNavigationStore.getState().workflowEdit).toEqual(opened);

    // Another worktree does not move the open pipeline to its checkout.
    await act(async () => {
      useChatStore.setState({
        selectedWorktree: { projectId: 'project-b', worktreeId: 'worktree-b' },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useNavigationStore.getState().workflowEdit).toEqual(opened);
  });

  it('opens a new draft from New', async () => {
    await renderPage();

    act(() => {
      capturedListProps.onCreateNew?.();
    });

    const shown = useNavigationStore.getState().workflowEdit;
    expect(shown).toMatchObject({ kind: 'pipeline', pipelineId: null });
    expect(shown?.kind === 'pipeline' ? typeof shown.draftKey : undefined).toBe(
      'string',
    );
  });

  it('reports the project context, and that it is pending, to the list', async () => {
    let resolvePath: (cwd: string) => void = () => undefined;
    jest.mocked(window.api.getWorktreePath).mockReturnValue(
      new Promise<string>((resolve) => {
        resolvePath = resolve;
      }),
    );
    useChatStore.setState({
      selectedWorktree: { projectId: 'project-a', worktreeId: 'worktree-a' },
    });
    await renderPage({ withList: true });

    expect(listApi().projectContextPending).toBe(true);
    expect(listApi().projectContext).toBeUndefined();

    await act(async () => {
      resolvePath('/repo-a');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listApi().projectContextPending).toBe(false);
    expect(listApi().projectContext).toEqual({
      cwd: '/repo-a',
      worktree: { projectId: 'project-a', worktreeId: 'worktree-a' },
    });
    expect(listApi().projectId).toBe('project-a');
  });

  it('opens the copy, editable, in place of the original', async () => {
    const copy: PipelineInfo = { ...USER_REVIEW, id: 'review-copy' };
    mockDuplicatePipeline.mockResolvedValue(copy);
    await renderPage({ withList: true });
    const returnTo = { kind: 'automation', activityId: 'a-1' } as const;
    act(() => {
      useNavigationStore.getState().openWorkflowEdit({
        kind: 'pipeline',
        pipelineId: 'bundled-review',
        source: 'bundled',
        returnTo,
      });
    });
    const replaces = useNavigationStore.getState().workflowEditReplaceCount;

    await act(async () => {
      await listApi().openDuplicate({
        ...USER_REVIEW,
        id: 'bundled-review',
        source: 'bundled',
        readonly: true,
      });
    });

    expect(mockDuplicatePipeline).toHaveBeenCalledTimes(1);
    expect(useNavigationStore.getState().workflowEdit).toEqual({
      kind: 'pipeline',
      pipelineId: 'review-copy',
      source: 'user',
      returnTo,
    });
    expect(useNavigationStore.getState().workflowEditReplaceCount).toBe(
      replaces + 1,
    );
  });

  it('refreshes the Library when the shell closes', async () => {
    await renderPage({ withList: true });
    act(() => {
      useNavigationStore
        .getState()
        .openPipelineEdit({ pipelineId: 'bundled-review', source: 'bundled' });
    });
    mockRefresh.mockClear();

    act(() => {
      useNavigationStore.getState().closeWorkflowEdit();
    });

    expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not pull the user back when they left while the copy was made', async () => {
    let resolveCopy: (copy: PipelineInfo) => void = () => undefined;
    mockDuplicatePipeline.mockReturnValue(
      new Promise<PipelineInfo>((resolve) => {
        resolveCopy = resolve;
      }),
    );
    await renderPage({ withList: true });
    act(() => {
      useNavigationStore
        .getState()
        .openPipelineEdit({ pipelineId: 'bundled-review', source: 'bundled' });
    });

    let duplicated: Promise<void> = Promise.resolve();
    act(() => {
      duplicated = listApi().openDuplicate({
        ...USER_REVIEW,
        id: 'bundled-review',
      });
    });
    act(() => {
      useNavigationStore.getState().closeWorkflowEdit();
    });
    await act(async () => {
      resolveCopy({ ...USER_REVIEW, id: 'review-copy' });
      await duplicated;
    });

    expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
  });

  it('rejects, and keeps the original, when no copy was made', async () => {
    await renderPage({ withList: true });
    act(() => {
      useNavigationStore
        .getState()
        .openPipelineEdit({ pipelineId: 'bundled-review', source: 'bundled' });
    });

    await expect(
      listApi().openDuplicate({ ...USER_REVIEW, id: 'bundled-review' }),
    ).rejects.toThrow('The workflow could not be duplicated.');
    expect(useNavigationStore.getState().workflowEdit).toMatchObject({
      pipelineId: 'bundled-review',
    });
  });

  describe('assistant page controller', () => {
    it('opens a locator and resolves true', async () => {
      await renderPage();

      let opened: boolean | undefined;
      await act(async () => {
        opened = await pageController().openEditor({
          pipelineId: 'project-review',
          cwd: '/repo-a',
          pipelineFilePath: '/repo-a/.canopy/pipelines/review.yml',
        });
      });

      expect(opened).toBe(true);
      expect(useNavigationStore.getState().workflowEdit).toEqual({
        kind: 'pipeline',
        pipelineId: 'project-review',
        cwd: '/repo-a',
        filePath: '/repo-a/.canopy/pipelines/review.yml',
      });
    });

    it('opens a fresh draft each time, with a string draft key', async () => {
      await renderPage();

      type Opened = PipelineEditorControllerTarget | null;
      const openedTargets: Opened[] = [];
      await act(async () => {
        openedTargets.push(await pageController().openNewDraft());
      });
      const firstShown = useNavigationStore.getState().workflowEdit;
      await act(async () => {
        openedTargets.push(await pageController().openNewDraft());
      });
      const first = openedTargets[0] ?? null;
      const second = openedTargets[1] ?? null;

      expect(first?.pipelineId).toBeNull();
      expect(typeof first?.draftKey).toBe('string');
      expect(second?.pipelineId).toBeNull();
      expect(typeof second?.draftKey).toBe('string');
      expect(first?.draftKey).not.toBe(second?.draftKey);
      expect(firstShown).toMatchObject(first ?? {});
      expect(useNavigationStore.getState().workflowEdit).toMatchObject(
        second ?? {},
      );
    });

    it('opens nothing and resolves false or null when the person keeps editing', async () => {
      await renderPage();
      const shown = { kind: 'pipeline', pipelineId: 'review' } as const;
      act(() => {
        useNavigationStore.getState().openWorkflowEdit(shown);
      });
      keepEditing();

      let opened: boolean | undefined;
      let draft: PipelineEditorControllerTarget | null = null;
      let left: boolean | undefined;
      await act(async () => {
        opened = await pageController().openEditor({ pipelineId: 'other' });
        draft = await pageController().openNewDraft();
        left = await pageController().goToList();
      });

      expect(opened).toBe(false);
      expect(draft).toBeNull();
      expect(left).toBe(false);
      expect(useNavigationStore.getState().workflowEdit).toEqual(shown);
    });

    it('does not ask about the item already shown', async () => {
      await renderPage();
      act(() => {
        useNavigationStore
          .getState()
          .openWorkflowEdit({ kind: 'pipeline', pipelineId: 'review' });
      });
      keepEditing();

      let opened: boolean | undefined;
      await act(async () => {
        opened = await pageController().openEditor({ pipelineId: 'review' });
      });

      expect(opened).toBe(true);
    });

    it('goes back to the Library list', async () => {
      await renderPage();
      act(() => {
        useNavigationStore
          .getState()
          .openWorkflowEdit({ kind: 'pipeline', pipelineId: 'review' });
      });

      let left: boolean | undefined;
      await act(async () => {
        left = await pageController().goToList();
      });

      expect(left).toBe(true);
      expect(useNavigationStore.getState().activePage).toBe(
        'workflows-library',
      );
      expect(useNavigationStore.getState().workflowEdit).toBeUndefined();
    });
  });

  describe('assistant drawer', () => {
    function drawer(): Element | null {
      return container.querySelector('[data-testid="pipeline-chat-drawer"]');
    }

    it('shows beside an open pipeline even where the assistant is off', async () => {
      mockHasConversation = true;
      await renderPage({ assistantEnabled: false });
      expect(drawer()).toBeNull();

      act(() => {
        useNavigationStore
          .getState()
          .openPipelineEdit({ pipelineId: 'review' });
      });
      expect(drawer()).not.toBeNull();

      act(() => {
        useNavigationStore.setState({
          workflowEdit: { kind: 'automation', activityId: 'a-1' },
        });
      });
      expect(drawer()).toBeNull();
    });
  });
});

describe('PipelinesPage row share races', () => {
  let container: HTMLElement;
  let root: Root;

  function makeInfo(id: string): PipelineInfo {
    const info: PipelineInfo = {
      id,
      name: `Pipeline ${id}`,
      filename: `${id}.yaml`,
      description: '',
      icon: '',
      createdAt: '2026-09-17T00:00:00.000Z',
      updatedAt: '2026-09-17T00:00:00.000Z',
      source: 'user',
      readonly: false,
      triggerTypes: ['dispatch'],
    };
    return info;
  }

  function deferred(): {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  } {
    let resolve: (value: unknown) => void = () => {};
    const promise = new Promise<unknown>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        getWorktreePath: jest.fn(),
        loadPreferences: jest.fn(() => Promise.resolve({})),
        savePreferences: jest.fn(() => Promise.resolve()),
      },
    });
    useNavigationStore.setState({
      activePage: 'workflows-library',
      workflowEdit: undefined,
    });
    usePipelineEditorBridgeStore.setState({
      editorController: null,
      pageController: null,
    });
    useChatStore.setState({ selectedWorktree: null });
    capturedListProps = {};
    deferProceed = false;
    pendingProceeds = [];
    mockFetchPipelineDocument.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it.each([true, false])(
    'passes project row worktree only with enforcement (%s)',
    async (enabled) => {
      const previous = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...previous,
          values: {
            ...previous.values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: enabled,
          },
        },
      });
      try {
        useChatStore.setState({
          selectedWorktree: {
            projectId: 'project-a',
            worktreeId: 'worktree-a',
          },
        });
        jest.mocked(window.api.getWorktreePath).mockResolvedValue('/repo-a');
        const info: PipelineInfo = {
          ...makeInfo('project-review'),
          source: 'project',
          filePath: '/repo-a/.canopy/pipelines/review.yaml',
        };
        mockFetchPipelineDocument.mockResolvedValue({
          data: { info, content: 'project' },
        });
        await act(async () => {
          root.render(<PipelinesPage />);
          await Promise.resolve();
        });
        await act(async () => {
          capturedListProps.onShare?.(info);
          await Promise.resolve();
        });
        const modal = container.querySelector('[data-testid="share-modal"]');
        expect(modal?.getAttribute('data-project-id')).toBe(
          enabled ? 'project-a' : null,
        );
        expect(modal?.getAttribute('data-worktree-id')).toBe(
          enabled ? 'worktree-a' : null,
        );
      } finally {
        act(() => {
          useFeatureFlagsStore.setState({ snapshot: previous });
        });
      }
    },
  );

  it('ignores a stale row-share load so the modal keeps the last-clicked pipeline', async () => {
    const slowA = deferred();
    const fastB = deferred();
    mockFetchPipelineDocument
      .mockReturnValueOnce(slowA.promise)
      .mockReturnValueOnce(fastB.promise);

    await act(async () => {
      root.render(<PipelinesPage />);
      await Promise.resolve();
    });

    const infoA = makeInfo('row-a');
    const infoB = makeInfo('row-b');

    // Click Share on row A, then row B before A resolves.
    await act(async () => {
      capturedListProps.onShare?.(infoA);
      await Promise.resolve();
    });
    await act(async () => {
      capturedListProps.onShare?.(infoB);
      await Promise.resolve();
    });

    // B resolves first and opens the modal.
    await act(async () => {
      fastB.resolve({ data: { info: infoB, content: 'b' } });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="share-modal"]')?.textContent,
    ).toBe('row-b');

    // A resolves late. Without a request-sequence guard this overwrites the
    // modal's subject with row A — the user would be one click from publishing
    // a pipeline they never selected.
    await act(async () => {
      slowA.resolve({ data: { info: infoA, content: 'a' } });
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="share-modal"]')?.textContent,
    ).toBe('row-b');
  });

  it('does not surface a stale error over a newer successful share', async () => {
    const slowA = deferred();
    const fastB = deferred();
    mockFetchPipelineDocument
      .mockReturnValueOnce(slowA.promise)
      .mockReturnValueOnce(fastB.promise);

    await act(async () => {
      root.render(<PipelinesPage />);
      await Promise.resolve();
    });

    await act(async () => {
      capturedListProps.onShare?.(makeInfo('row-a'));
      await Promise.resolve();
    });
    await act(async () => {
      capturedListProps.onShare?.(makeInfo('row-b'));
      await Promise.resolve();
    });

    await act(async () => {
      fastB.resolve({ data: { info: makeInfo('row-b'), content: 'b' } });
      await Promise.resolve();
    });
    await act(async () => {
      slowA.resolve({ error: 'boom' });
      await Promise.resolve();
    });

    expect(capturedListProps.actionError ?? null).toBeNull();
    // The stale settle must also not clear the newer request's pending state
    // out from under it, nor leave it stuck.
    expect(capturedListProps.sharePendingId ?? null).toBeNull();
  });

  it('abandons an in-flight row share when the page leaves the list view', async () => {
    const slowA = deferred();
    mockFetchPipelineDocument.mockReturnValueOnce(slowA.promise);

    await act(async () => {
      root.render(<PipelinesPage />);
      await Promise.resolve();
    });

    await act(async () => {
      capturedListProps.onShare?.(makeInfo('row-a'));
      await Promise.resolve();
    });

    // Navigate into the editor while the share load is still in flight.
    await act(async () => {
      useNavigationStore.getState().openPipelineEdit({ pipelineId: null });
      await Promise.resolve();
    });

    await act(async () => {
      slowA.resolve({ data: { info: makeInfo('row-a'), content: 'a' } });
      await Promise.resolve();
    });

    // The page-owned share modal must not stack on top of the editor.
    expect(container.querySelector('[data-testid="share-modal"]')).toBeNull();
  });

  it('does not open the share modal when the gate resolves after navigation', async () => {
    // Production shape: `requestShare` defers `proceed` behind an async account
    // load (and, when gated, behind the user closing CloudSyncModal). A
    // `proceed` that lands AFTER the page left the list view allocates a fresh
    // sequence number, so the seq guard alone considers it current — the modal
    // would stack on top of the editor.
    deferProceed = true;
    const load = deferred();
    mockFetchPipelineDocument.mockReturnValueOnce(load.promise);

    await act(async () => {
      root.render(<PipelinesPage />);
      await Promise.resolve();
    });

    await act(async () => {
      capturedListProps.onShare?.(makeInfo('row-a'));
      await Promise.resolve();
    });
    // Nothing has been dispatched yet: the gate still holds `proceed`.
    expect(mockFetchPipelineDocument).not.toHaveBeenCalled();

    // User navigates into the editor while the gate is still open.
    await act(async () => {
      useNavigationStore.getState().openPipelineEdit({ pipelineId: null });
      await Promise.resolve();
    });

    // Only now does the gate let the request through.
    await act(async () => {
      pendingProceeds[0]?.();
      await Promise.resolve();
    });
    await act(async () => {
      load.resolve({ data: { info: makeInfo('row-a'), content: 'a' } });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="share-modal"]')).toBeNull();
  });

  it('does not resurrect a gated share after a round trip back to the list', async () => {
    // The gate modal renders outside the list-view gate, so it survives
    // navigation. Returning to the list restores `listViewActiveRef`, so the ref
    // check alone would let a stale `proceed` through. The request-time sequence
    // snapshot is what actually cancels it.
    deferProceed = true;
    const load = deferred();
    mockFetchPipelineDocument.mockReturnValueOnce(load.promise);

    await act(async () => {
      root.render(<PipelinesPage />);
      await Promise.resolve();
    });

    await act(async () => {
      capturedListProps.onShare?.(makeInfo('row-a'));
      await Promise.resolve();
    });

    // Leave the list...
    await act(async () => {
      useNavigationStore.getState().openPipelineEdit({ pipelineId: null });
      await Promise.resolve();
    });
    // ...and come back.
    await act(async () => {
      await usePipelineEditorBridgeStore.getState().pageController?.goToList();
    });

    // Only now does the user close the gate.
    await act(async () => {
      pendingProceeds[0]?.();
      await Promise.resolve();
    });
    await act(async () => {
      load.resolve({ data: { info: makeInfo('row-a'), content: 'a' } });
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="share-modal"]')).toBeNull();
  });

  it('honours the last click when two shares are gated at once', async () => {
    // `requestShare` runs an independent async chain per call with no dedupe or
    // single-flight, and no Share button is disabled while the gate is open, so
    // two rows can be clicked before either gate resolves. The LAST click must
    // win regardless of which gate resolves first — the winner must not be
    // decided by IPC resolution order.
    deferProceed = true;
    // Named by CALL order, not by row: only the surviving click fetches, so
    // `firstCallLoad` is consumed by row B's request.
    const firstCallLoad = deferred();
    const secondCallLoad = deferred();
    mockFetchPipelineDocument
      .mockReturnValueOnce(firstCallLoad.promise)
      .mockReturnValueOnce(secondCallLoad.promise);

    await act(async () => {
      root.render(<PipelinesPage />);
      await Promise.resolve();
    });

    await act(async () => {
      capturedListProps.onShare?.(makeInfo('row-a'));
      capturedListProps.onShare?.(makeInfo('row-b'));
      await Promise.resolve();
    });
    expect(pendingProceeds).toHaveLength(2);

    // Row A's gate resolves FIRST even though B was clicked last.
    await act(async () => {
      pendingProceeds[0]?.();
      await Promise.resolve();
    });
    // A is superseded, so it must not even start a fetch.
    expect(mockFetchPipelineDocument).not.toHaveBeenCalled();

    await act(async () => {
      pendingProceeds[1]?.();
      await Promise.resolve();
    });
    expect(mockFetchPipelineDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstCallLoad.resolve({
        data: { info: makeInfo('row-b'), content: 'b' },
      });
      await Promise.resolve();
    });

    // The user's last click opened the modal; B's click was not swallowed.
    expect(
      container.querySelector('[data-testid="share-modal"]')?.textContent,
    ).toBe('row-b');
  });

  it('marks the pending row with a source-qualified key', async () => {
    // Pipeline ids are only unique per source (rows are keyed `source:id`), so
    // a bare id would mark a same-id row under a different source as pending.
    const load = deferred();
    mockFetchPipelineDocument.mockReturnValueOnce(load.promise);

    await act(async () => {
      root.render(<PipelinesPage />);
      await Promise.resolve();
    });

    await act(async () => {
      capturedListProps.onShare?.(makeInfo('shared-id'));
      await Promise.resolve();
    });

    expect(capturedListProps.sharePendingId).toBe('user:shared-id');

    await act(async () => {
      load.resolve({ data: { info: makeInfo('shared-id'), content: 'a' } });
      await Promise.resolve();
    });
    expect(capturedListProps.sharePendingId ?? null).toBeNull();
  });
});

describe('PipelinesPage assistant drawer default (CAN-3980)', () => {
  let container: HTMLElement;
  let root: Root;

  function stubPreferences(preferences: Record<string, unknown>): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        getWorktreePath: jest.fn(),
        loadPreferences: jest.fn(() => Promise.resolve(preferences)),
        savePreferences: jest.fn(() => Promise.resolve()),
      },
    });
  }

  async function renderPage(): Promise<void> {
    await act(async () => {
      root.render(<PipelinesPage />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function drawer(): Element | null {
    return container.querySelector('[data-testid="pipeline-chat-drawer"]');
  }

  beforeEach(() => {
    mockHasConversation = false;
    stubPreferences({});
    useNavigationStore.setState({
      activePage: 'workflows-library',
      workflowEdit: undefined,
    });
    useChatStore.setState({ selectedWorktree: null });
    consumePipelineAssistantOpenRequest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('keeps an empty assistant closed', async () => {
    await renderPage();

    expect(drawer()).toBeNull();
  });

  it('opens when the assistant already holds a conversation', async () => {
    mockHasConversation = true;
    await renderPage();

    expect(drawer()).not.toBeNull();
  });

  it('stays closed after the user hid it, conversation or not', async () => {
    mockHasConversation = true;
    stubPreferences({ pipelineChatPanelVisible: false });
    await renderPage();

    expect(drawer()).toBeNull();
  });

  it('opens for an explicit request made before the page mounted', async () => {
    requestPipelineAssistantOpen();
    await renderPage();

    expect(drawer()).not.toBeNull();
  });
});
