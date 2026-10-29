/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FileViewerProps } from '@canopy/ui-app';
import type { FileViewerSession } from '@canopy/app-state';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';
import type {
  AppAdvisorJson,
  CodeReviewFile,
  FileAnnotationDocument,
  FileAnnotationsSaveRequest,
  SidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import type { PdfPreviewProps } from '@canopy/ui-rich/pdf';
import type {
  DocxPreviewProps,
  PptxPreviewProps,
  XlsxPreviewProps,
} from '@canopy/ui-rich/office';
import type { ScriptRunState } from '@/stores/scriptsStore';
import type { OpenFileDiffTarget } from '../useOpenFileDiffTarget';
import type { useCurrentUiStateReporter as UseCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type * as ChatRenderStoresTestUtils from '@/test-utils/chatRenderStores';

let mockViewerProps: FileViewerProps | null = null;
let mockSession: FileViewerSession | undefined;
let mockSelectionHandler:
  | ((selection: {
      lineStart: number;
      lineEnd: number;
      quote: string;
      anchorRect: DOMRect;
    }) => void)
  | undefined;
const mockOpenFileTab = jest.fn();
const mockCreateEmptyFileTab = jest.fn<string | null, []>();
const mockOpenDirectoryInFileTree = jest.fn<void, [string, string]>();
const mockRequestFilePanelPlacementAsSibling = jest.fn<
  void,
  [string, string]
>();
const mockSetFileTabViewMode = jest.fn();
const mockSendMessage = jest.fn<
  Promise<void>,
  [
    string,
    unknown,
    { projectId: string; worktreeId: string; chatId: string },
    unknown,
    {
      hiddenContext: { kind: string; text: string };
      throwOnDispatchFailure: boolean;
      onDispatchAccepted: () => void;
      onDispatchRejected: () => void;
    },
  ]
>();
const mockSwitchTab = jest.fn();
const mockEnsureWorktreeHasChatTab = jest.fn<Promise<void>, []>();
const mockGetTabDraft = jest.fn();
const mockSaveTabDraft = jest.fn();
const mockLoadTabsForTarget = jest.fn<Promise<void>, [string, string]>();
const mockSaveAnnotations = jest.fn<
  Promise<FileAnnotationDocument>,
  [FileAnnotationsSaveRequest]
>();
let mockWorktreeChats: Record<string, unknown> = {};
const mockRefreshFile = jest.fn<Promise<string>, [PortalFileReadPayload]>();
const mockRegisterTab = jest.fn<string, [string, PortalFileReadPayload]>();
let mockMonacoEditorLanguage: string | null = null;
let mockDiffTarget: OpenFileDiffTarget | null = null;

/** Every value handed to the UI state reporter, by key. */
const reportedUiState = new Map<string, Array<AppAdvisorJson | null>>();
jest.mock('@/hooks/useCurrentUiStateReporter', () => {
  const actual = jest.requireActual<{
    useCurrentUiStateReporter: typeof UseCurrentUiStateReporter;
  }>('@/hooks/useCurrentUiStateReporter');
  return {
    ...actual,
    useCurrentUiStateReporter: (
      key: string | null,
      value: AppAdvisorJson | null,
    ): void => {
      if (key !== null) {
        const values = reportedUiState.get(key) ?? [];
        values.push(value);
        reportedUiState.set(key, values);
      }
      actual.useCurrentUiStateReporter(key, value);
    },
  };
});

let mockPdfProps: PdfPreviewProps | undefined;
jest.mock('@canopy/ui-rich/pdf', () => ({
  PdfPreview: (props: PdfPreviewProps): JSX.Element => {
    mockPdfProps = props;
    return <div>{props.fileName}</div>;
  },
}));

let mockDocxProps: DocxPreviewProps | undefined;
let mockXlsxProps: XlsxPreviewProps | undefined;
let mockPptxProps: PptxPreviewProps | undefined;
jest.mock('@canopy/ui-rich/office', () => ({
  DocxPreview: (props: DocxPreviewProps): JSX.Element => {
    mockDocxProps = props;
    return <div>{props.fileName}</div>;
  },
  XlsxPreview: (props: XlsxPreviewProps): JSX.Element => {
    mockXlsxProps = props;
    return <div>{props.fileName}</div>;
  },
  PptxPreview: (props: PptxPreviewProps): JSX.Element => {
    mockPptxProps = props;
    return <div>{props.fileName}</div>;
  },
}));
const mockCreateDesktopOfficeWorker = jest.fn<Worker, []>();
jest.mock('@/lib/file-viewer/desktop-office-worker', () => ({
  createDesktopOfficeWorker: (): Worker => mockCreateDesktopOfficeWorker(),
}));

jest.mock('@canopy/app-state', () => ({
  fileViewerKey: (): string => 'file-key',
  useFileViewerStore: (
    selector: (state: {
      files: Record<string, FileViewerSession>;
      openFile: typeof mockRefreshFile;
    }) => unknown,
  ): unknown =>
    selector({
      files: mockSession ? { 'file-key': mockSession } : {},
      openFile: mockRefreshFile,
    }),
  // Imperative store handle used by the selection→composer capture path
  // (CAN-1250); tests only need a stable object with getState().
  useFileViewerStoreApi: (): {
    getState: () => { files: Record<string, FileViewerSession> };
  } => ({
    getState: (): { files: Record<string, FileViewerSession> } => ({
      files: mockSession ? { 'file-key': mockSession } : {},
    }),
  }),
}));
// The single-owner controller replaces the legacy mirror: the viewer only
// registers the resolved request; no content/dirty/mtime lives outside the
// shared session.
jest.mock('@/lib/file-viewer/desktop-file-session-controller', () => ({
  desktopFileSessionController: {
    registerTab: (tabId: string, request: PortalFileReadPayload): string =>
      mockRegisterTab(tabId, request),
  },
}));
jest.mock('@canopy/ui-app', () => ({
  resolveFileRenderKind: ({
    path,
  }: {
    path: string;
  }): 'image' | 'pdf' | 'docx' | 'xlsx' | 'code' =>
    /\.pdf$/i.test(path)
      ? 'pdf'
      : /\.docx$/i.test(path)
        ? 'docx'
        : /\.xlsx$/i.test(path)
          ? 'xlsx'
          : /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(path)
            ? 'image'
            : 'code',
  isRichDocumentRenderKind: (kind: string): boolean =>
    kind === 'pdf' || kind === 'docx' || kind === 'xlsx',
  FileViewer: (props: FileViewerProps): JSX.Element => {
    mockViewerProps = props;
    return (
      <div
        ref={props.contentScrollBinding?.ref}
        onScroll={props.contentScrollBinding?.onScroll}
        data-testid="shared-file-viewer"
      >
        {props.headerActions}
        <span data-testid="mock-rich-file-content">
          {mockSession?.preview?.content}
        </span>
        {props.renderEditor?.({
          value: 'const value = 1;',
          language: 'typescript',
          filePath: '/repo/src/a.ts',
          dirty: false,
          onChange: jest.fn(),
          onSave: jest.fn(),
        })}
      </div>
    );
  },
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (
      selector: (state: {
        worktreeChats: Record<string, unknown>;
        openFileTab: typeof mockOpenFileTab;
        setFileTabViewMode: typeof mockSetFileTabViewMode;
        sendMessage: typeof mockSendMessage;
      }) => unknown,
    ): unknown =>
      selector({
        worktreeChats: mockWorktreeChats,
        openFileTab: mockOpenFileTab,
        createEmptyFileTab: mockCreateEmptyFileTab,
        setFileTabViewMode: mockSetFileTabViewMode,
        sendMessage: mockSendMessage,
      }),
    {
      getState: (): {
        worktreeChats: Record<string, unknown>;
        ensureWorktreeHasChatTab: () => Promise<void>;
        sendMessage: typeof mockSendMessage;
        switchTab: typeof mockSwitchTab;
        loadTabsForTarget: typeof mockLoadTabsForTarget;
        getTabDraft: typeof mockGetTabDraft;
        saveTabDraft: typeof mockSaveTabDraft;
      } => ({
        worktreeChats: mockWorktreeChats,
        ensureWorktreeHasChatTab: mockEnsureWorktreeHasChatTab,
        sendMessage: mockSendMessage,
        switchTab: mockSwitchTab,
        loadTabsForTarget: mockLoadTabsForTarget,
        getTabDraft: mockGetTabDraft,
        saveTabDraft: mockSaveTabDraft,
      }),
    },
  ),
  ...jest
    .requireActual<
      typeof ChatRenderStoresTestUtils
    >('@/test-utils/chatRenderStores')
    .mockChatRenderHooks(() => ({ worktreeChats: mockWorktreeChats })),
}));
jest.mock('@/stores/fileTabUiStore', () => ({
  useFileTabUiStore: {
    getState: (): {
      openDirectoryInFileTree: typeof mockOpenDirectoryInFileTree;
    } => ({ openDirectoryInFileTree: mockOpenDirectoryInFileTree }),
  },
}));
jest.mock('@/lib/panels/chat-panel-sync', () => ({
  requestFilePanelPlacementAsSibling: (
    fileTabId: string,
    originFileTabId: string,
  ): void => mockRequestFilePanelPlacementAsSibling(fileTabId, originFileTabId),
}));
jest.mock('@/stores/codeReviewStore', () => ({
  useCodeReviewStore: {
    getState: (): { openCodeReview: () => void } => ({
      openCodeReview: jest.fn(),
    }),
  },
}));
jest.mock('@/components/shared', () => ({
  LoadingPlaceholder: (): JSX.Element => <div data-testid="loading" />,
}));
jest.mock('../useOpenFileDiffTarget', () => ({
  useOpenFileDiffTarget: (): OpenFileDiffTarget | null => mockDiffTarget,
}));
const mockScheduleRestoreScrollPosition = jest.fn();
jest.mock('../useTabScrollPosition', () => ({
  useTabScrollPosition: (): {
    scrollRef: { current: null };
    handleScroll: () => void;
    scheduleRestoreScrollPosition: () => void;
  } => ({
    scrollRef: { current: null },
    handleScroll: jest.fn(),
    scheduleRestoreScrollPosition: mockScheduleRestoreScrollPosition,
  }),
}));
jest.mock('../MonacoFileEditor', () => ({
  MonacoFileEditor: (props: {
    language: string;
    onSelectionComment?: typeof mockSelectionHandler;
  }): JSX.Element => {
    mockMonacoEditorLanguage = props.language;
    mockSelectionHandler = props.onSelectionComment;
    return <div data-testid="mock-monaco-editor" />;
  },
}));

import { DesktopSharedFileViewer } from '../DesktopSharedFileViewer';
import { useSurfaceFindStore } from '@/stores/surfaceFindStore';
import { PanelHostContext } from '@/lib/panels/panel-host-context';
import { FILE_PREVIEW_SEARCH_EVENT } from '@/lib/filePreviewSearchEvents';
import { resolveRichSelectionLines } from '../resolveRichSelectionLines';
import { useAgentFilePresentationStore } from '@/stores/agentFilePresentationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useScriptsStore } from '@/stores/scriptsStore';
import {
  INSERT_CHAT_TEXT_EVENT,
  isInsertChatTextDetail,
  type InsertChatTextDetail,
} from '@/lib/editorSelectionContext';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function installApi(api: Record<string, unknown>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      codeReview: {
        onUpdated: jest.fn((): (() => void) => (): void => undefined),
        get: jest.fn().mockResolvedValue({ review: null, fingerprint: '' }),
        setModalOpen: jest.fn().mockResolvedValue(undefined),
      },
      ...api,
    },
  });
}

function makeProject(
  setupPhase: 'git-pending' | 'git-ready',
  gitFailed = false,
): SingleRepoSidebarItem {
  return {
    id: 'project-1',
    name: 'Project',
    type: 'single-repo',
    repoPath: '/repo',
    color: 'blue',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: 'worktree-1',
        branchName: 'feature',
        createdAt: '2026-08-05T00:00:00.000Z',
        setupPhase,
        ...(gitFailed
          ? {
              healthIssue: {
                status: 'broken' as const,
                code: 'git-error' as const,
                message: 'Worktree setup failed.',
                checkedAt: '2026-08-05T00:00:01.000Z',
                worktreePath: '/repo',
                gitError: 'checkout failed',
              },
            }
          : {}),
      },
    ],
    worktreeEffective: {
      'worktree-1': { effectiveScripts: { setup: 'npm install' } },
    },
  };
}

function makeWorkspaceProject(): SidebarItem {
  return {
    id: 'project-1',
    name: 'Workspace',
    type: 'multi-repo',
    color: 'blue',
    collapsed: false,
    order: 0,
    repos: [
      {
        id: 'repo-1',
        name: 'Repo',
        repoPath: '/repo',
        effectiveScripts: { setup: 'npm install' },
      },
    ],
    worktrees: [
      {
        id: 'worktree-1',
        branchName: 'feature',
        createdAt: '2026-08-05T00:00:00.000Z',
        setupPhase: 'git-ready',
      },
    ],
    effectiveScripts: { 'after-setup': 'npm run generate' },
  };
}

function completedSetupRun(): ScriptRunState {
  return {
    label: 'Setup',
    scriptName: 'setup',
    lifecycle: 'setup',
    command: 'npm install',
    target: 'project',
    status: 'success',
    outputLines: [],
    exitCode: 0,
    timedOut: false,
    durationMs: 1,
    startedAt: 1,
    devServerHits: [],
  };
}

function runningRepositorySetupRun(): ScriptRunState {
  return {
    ...completedSetupRun(),
    target: 'workspace-repo',
    repoId: 'repo-1',
    status: 'running',
    exitCode: null,
  };
}

describe('DesktopSharedFileViewer', () => {
  let host: HTMLDivElement;
  let root: Root;
  // Set to wrap renders in a panel host (`visible: false` while MainPage is
  // hidden); null renders the viewer bare, as most tests do.
  let hostVisible: boolean | null = null;
  // Set to pass `searchShortcutActive` explicitly (it defaults to `active`).
  let searchShortcutActiveOverride: boolean | null = null;

  beforeAll(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    hostVisible = null;
    searchShortcutActiveOverride = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mockViewerProps = null;
    mockPdfProps = undefined;
    mockDocxProps = undefined;
    mockXlsxProps = undefined;
    mockCreateDesktopOfficeWorker.mockReset();
    Object.defineProperty(window, 'platform', {
      configurable: true,
      value: 'darwin',
    });
    mockSession = undefined;
    mockSelectionHandler = undefined;
    mockOpenFileTab.mockReset();
    mockSendMessage
      .mockReset()
      .mockImplementation(
        (_text, _files, _target, _inputMode, options): Promise<void> => {
          options.onDispatchAccepted();
          return Promise.resolve();
        },
      );
    mockSwitchTab.mockReset();
    mockEnsureWorktreeHasChatTab.mockReset().mockResolvedValue(undefined);
    mockGetTabDraft.mockReset();
    mockSaveTabDraft.mockReset();
    mockLoadTabsForTarget.mockReset();
    mockSaveAnnotations
      .mockReset()
      .mockImplementation((request) => Promise.resolve(request.document));
    mockWorktreeChats = {};
    useAgentFilePresentationStore.setState({ byTabId: {} });
    mockRegisterTab.mockReset().mockReturnValue('file-key');
    mockRefreshFile.mockReset().mockResolvedValue('file-key');
    mockMonacoEditorLanguage = null;
    mockDiffTarget = null;
    useProjectsStore.setState({ projects: [] });
    useScriptsStore.setState({ runs: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useSurfaceFindStore.getState().close();
  });

  async function renderViewer(
    filePath: string,
    roots: Array<{ repoId: string; absolutePath: string }>,
    active = true,
    annotationDocument = {
      filePath,
      annotations: [],
      commentThreads: [],
    },
    viewMode: 'raw' | 'preview' = 'raw',
    target: { projectId: string; worktreeId: string } = {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    },
    recheckAfterWorktreeSetup = false,
    codeReview?: CodeReviewFile,
  ): Promise<void> {
    installApi({
      ...(codeReview
        ? {
            codeReview: {
              onUpdated: jest.fn((): (() => void) => (): void => undefined),
              get: jest.fn().mockResolvedValue({
                review: codeReview,
                fingerprint: 'current-fingerprint',
              }),
              setModalOpen: jest.fn().mockResolvedValue(undefined),
            },
          }
        : {}),
      getFileTreeRoots: jest.fn().mockResolvedValue({ roots }),
      showInFinder: jest.fn().mockResolvedValue(undefined),
      fileAnnotations: {
        get: jest.fn().mockResolvedValue(annotationDocument),
        save: mockSaveAnnotations,
        onUpdated: jest.fn().mockReturnValue(() => undefined),
      },
    });
    await act(async () => {
      const viewer = (
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId={target.projectId}
          worktreeId={target.worktreeId}
          filePath={filePath}
          viewMode={viewMode}
          active={active}
          {...(searchShortcutActiveOverride === null
            ? {}
            : { searchShortcutActive: searchShortcutActiveOverride })}
          {...(recheckAfterWorktreeSetup
            ? { recheckAfterWorktreeSetup: true }
            : {})}
        />
      );
      root.render(
        hostVisible === null ? (
          viewer
        ) : (
          <PanelHostContext.Provider
            value={{
              viewMode: 'list',
              viewModeReady: true,
              visible: hostVisible,
            }}
          >
            {viewer}
          </PanelHostContext.Provider>
        ),
      );
      await Promise.resolve();
    });
  }

  it('passes range/revision to the shared viewer and removes it on a plain presentation', async () => {
    useAgentFilePresentationStore
      .getState()
      .present('tab-1', { line: 150, lineEnd: 160 });
    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    expect(mockViewerProps?.revealLine).toEqual({
      line: 150,
      lineEnd: 160,
      revision: 1,
    });
    act(() =>
      useAgentFilePresentationStore.getState().present('tab-1', { line: 155 }),
    );
    expect(mockViewerProps?.revealLine).toEqual({ line: 155, revision: 2 });
    act(() => useAgentFilePresentationStore.getState().present('tab-1', {}));
    expect(mockViewerProps?.revealLine).toBeUndefined();
  });

  it.each([
    ['C:\\repo\\src\\a.ts', 'C:\\repo', 'src/a.ts'],
    ['c:\\REPO\\src\\a.ts', 'C:\\repo\\', 'src/a.ts'],
    [
      '\\\\server\\share\\repo\\src\\a.ts',
      '\\\\Server\\Share\\Repo',
      'src/a.ts',
    ],
  ])(
    'resolves Windows and UNC paths to forward-slash relative paths',
    async (filePath, rootPath, relativePath) => {
      await renderViewer(filePath, [
        { repoId: 'repo-1', absolutePath: rootPath },
      ]);
      expect(mockViewerProps?.request.relativePath).toBe(relativePath);
    },
  );

  it('opens a directory link in an empty tab with that directory revealed', async () => {
    const resolveFileReference = jest.fn().mockResolvedValue({
      absolutePath: '/repo/evaluations',
      filename: 'evaluations',
      kind: 'directory',
    });
    mockCreateEmptyFileTab.mockReturnValue('directory-tab');
    await renderViewer('/repo/README.md', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    installApi({ resolveFileReference });

    mockViewerProps?.onOpenRelativePath?.('evaluations');
    await act(async () => Promise.resolve());

    expect(mockOpenFileTab).not.toHaveBeenCalled();
    expect(mockCreateEmptyFileTab).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(mockOpenDirectoryInFileTree).toHaveBeenCalledWith(
      'directory-tab',
      '/repo/evaluations',
    );
    expect(mockRequestFilePanelPlacementAsSibling).toHaveBeenCalledWith(
      'directory-tab',
      'tab-1',
    );
  });

  describe('find bar file mode (CAN-3048)', () => {
    function reportPreviewSearch(enabled: boolean, totalCount = 0): void {
      act(() => {
        mockViewerProps?.onPreviewSearchStateChange?.({
          enabled,
          open: false,
          queryPresent: false,
          currentIndex: 0,
          totalCount,
        });
      });
    }

    it('hands the preview search to the find bar for searchable previews only', async () => {
      await renderViewer('/repo/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      expect(mockViewerProps?.previewSearchPresentation).toBe('headless');
      expect(
        host
          .querySelector('[data-find-surface="file"]')
          ?.getAttribute('data-find-scope'),
      ).toBe('tab-1');
      expect(
        useSurfaceFindStore.getState().hasController('file', 'tab-1'),
      ).toBe(false);

      reportPreviewSearch(true);
      expect(
        useSurfaceFindStore.getState().hasController('file', 'tab-1'),
      ).toBe(true);

      reportPreviewSearch(false);
      expect(
        useSurfaceFindStore.getState().hasController('file', 'tab-1'),
      ).toBe(false);
    });

    it('registers while shown beside the active panel group', async () => {
      // The file panel is on screen but another group is active: the bar
      // can still offer the file toggle.
      searchShortcutActiveOverride = false;
      await renderViewer('/repo/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      reportPreviewSearch(true);
      expect(
        useSurfaceFindStore.getState().hasController('file', 'tab-1'),
      ).toBe(true);
    });

    it('titles the file scope with the file name', async () => {
      await renderViewer('/repo/docs/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      reportPreviewSearch(true);
      expect(
        useSurfaceFindStore.getState().controllers['file:tab-1']?.title,
      ).toBe('README.md');
    });

    it('opens and closes the bar from the file preview search event', async () => {
      await renderViewer('/repo/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      reportPreviewSearch(true);
      const acknowledge = jest.fn();

      act(() => {
        window.dispatchEvent(
          new CustomEvent(FILE_PREVIEW_SEARCH_EVENT, {
            detail: { operation: 'open', acknowledge },
          }),
        );
      });
      expect(acknowledge).toHaveBeenCalled();
      expect(useSurfaceFindStore.getState().mode).toBe('file');
      expect(mockViewerProps?.previewSearchControlled?.open).toBe(true);

      act(() => {
        window.dispatchEvent(
          new CustomEvent(FILE_PREVIEW_SEARCH_EVENT, {
            detail: { operation: 'close', acknowledge },
          }),
        );
      });
      expect(useSurfaceFindStore.getState().open).toBe(false);
    });

    it('drives the controlled query and wraps the index by the match count', async () => {
      await renderViewer('/repo/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      reportPreviewSearch(true, 2);
      act(() => {
        useSurfaceFindStore.getState().openFor('file', 'tab-1');
        useSurfaceFindStore.getState().setQuery('needle');
      });
      expect(mockViewerProps?.previewSearchControlled).toEqual({
        open: true,
        query: 'needle',
        index: 0,
      });

      act(() => useSurfaceFindStore.getState().previous());
      expect(mockViewerProps?.previewSearchControlled?.index).toBe(1);
      act(() => useSurfaceFindStore.getState().next());
      expect(mockViewerProps?.previewSearchControlled?.index).toBe(0);
    });

    it('closes the bar when the main page hosting the file is hidden', async () => {
      hostVisible = true;
      await renderViewer('/repo/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      reportPreviewSearch(true, 2);
      act(() => {
        useSurfaceFindStore.getState().openFor('file', 'tab-1');
      });
      expect(useSurfaceFindStore.getState().open).toBe(true);

      hostVisible = false;
      await renderViewer('/repo/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      expect(useSurfaceFindStore.getState().open).toBe(false);
      expect(
        useSurfaceFindStore.getState().hasController('file', 'tab-1'),
      ).toBe(false);
    });

    it('reports one stable preview search value across re-renders', async () => {
      reportedUiState.clear();
      // Rendering inside a host context gives each render a fresh context
      // value, which re-renders the memoized viewer without a search change.
      hostVisible = true;
      await renderViewer('/repo/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      reportPreviewSearch(true, 2);
      const before = reportedUiState.get('files.previewSearch.tab-1')?.at(-1);
      expect(before).toMatchObject({ enabled: true, totalCount: 2 });

      // A re-render with no search change must hand the reporter the same
      // object, so its serialize-and-compare effect does not run again.
      await renderViewer('/repo/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      expect(reportedUiState.get('files.previewSearch.tab-1')?.at(-1)).toBe(
        before,
      );
    });

    it('steps from the shown match after the match count shrinks', async () => {
      await renderViewer('/repo/README.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      reportPreviewSearch(true, 10);
      act(() => {
        useSurfaceFindStore.getState().openFor('file', 'tab-1');
        useSurfaceFindStore.getState().setQuery('needle');
      });
      for (let step = 0; step < 7; step += 1) {
        act(() => useSurfaceFindStore.getState().next());
      }
      expect(mockViewerProps?.previewSearchControlled?.index).toBe(7);

      // The preview now has 3 matches and shows the first one.
      reportPreviewSearch(true, 3);
      act(() => useSurfaceFindStore.getState().next());
      expect(mockViewerProps?.previewSearchControlled?.index).toBe(1);
    });
  });

  it('registers the canonical request against the shared controller', async () => {
    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);

    expect(mockRegisterTab).toHaveBeenCalledWith('tab-1', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      fileRootLocalId: 'repo-1',
      relativePath: 'src/a.ts',
    });
    // The resolved request is also published to the viewer.
    expect(mockViewerProps?.request).toMatchObject({
      fileRootLocalId: 'repo-1',
      relativePath: 'src/a.ts',
    });
  });

  it('shows only diff statistics in the changed-file header action', async () => {
    mockDiffTarget = {
      file: {
        path: 'src/a.ts',
        status: 'modified',
        insertions: 3,
        deletions: 2,
      },
      source: 'uncommitted',
    };

    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);

    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="file-viewer-view-diff"]',
    );
    expect(button).not.toBeNull();
    expect(button?.textContent).toBe('+3-2');
    expect(button?.getAttribute('aria-label')).toBe('View diff');
    expect(button?.classList.contains('h-7')).toBe(true);
  });

  it('does not classify an unverified persisted diff thread as current on a fresh raw mount', async () => {
    mockDiffTarget = {
      file: {
        path: 'src/a.ts',
        status: 'modified',
        insertions: 3,
        deletions: 2,
      },
      source: 'uncommitted',
    };
    const filePath = '/repo/src/a.ts';
    await renderViewer(
      filePath,
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      {
        filePath,
        annotations: [],
        commentThreads: [
          {
            id: 'diff-thread',
            status: 'open',
            createdAt: '2026-09-18T00:00:00.000Z',
            anchorState: 'matched',
            anchor: {
              source: 'code',
              view: 'diff',
              filePath,
              side: 'new',
              lineStart: 1,
              lineEnd: 1,
              quote: 'const value = 1;',
              diff: {
                source: 'uncommitted',
                snapshotId: 'persisted-snapshot',
              },
            },
            comments: [
              {
                id: 'diff-comment',
                author: 'user',
                body: 'Review this diff.',
                createdAt: '2026-09-18T00:00:00.000Z',
              },
            ],
          },
        ],
      },
      'raw',
    );
    await act(async () => Promise.resolve());

    expect(
      host.querySelector('[aria-label="1 open comments in diff view"]'),
    ).toBeNull();
  });

  it('keeps a restored file loading until the destination becomes git-ready', async () => {
    const getFileTreeRoots = jest.fn().mockResolvedValue({
      roots: [{ repoId: 'repo-1', absolutePath: '/repo' }],
    });
    useProjectsStore.setState({ projects: [makeProject('git-pending')] });
    installApi({
      getFileTreeRoots,
      fileAnnotations: {
        get: jest.fn().mockResolvedValue({
          filePath: '/repo/src/a.ts',
          annotations: [],
          commentThreads: [],
        }),
        save: mockSaveAnnotations,
        onUpdated: jest.fn().mockReturnValue(() => undefined),
      },
    });

    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="raw"
          active
        />,
      );
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="loading"]')).not.toBeNull();
    expect(getFileTreeRoots).not.toHaveBeenCalled();

    await act(async () => {
      useProjectsStore.setState({ projects: [makeProject('git-ready')] });
      await Promise.resolve();
    });
    expect(getFileTreeRoots).toHaveBeenCalledTimes(1);
    expect(mockViewerProps?.request.relativePath).toBe('src/a.ts');
  });

  it('defers a missing state and rechecks once after setup completes', async () => {
    useProjectsStore.setState({ projects: [makeProject('git-ready')] });
    await renderViewer(
      '/repo/src/a.ts',
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      undefined,
      undefined,
      undefined,
      true,
    );
    mockSession = {
      key: 'file-key',
      request: mockViewerProps?.request ?? {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        fileRootLocalId: 'repo-1',
        relativePath: 'src/a.ts',
      },
      preview: null,
      content: '',
      dirty: false,
      viewMode: 'raw',
      status: 'error',
      error: 'File not found: src/a.ts',
    };
    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="raw"
          active={false}
          recheckAfterWorktreeSetup
        />,
      );
      await Promise.resolve();
    });
    expect(mockViewerProps?.deferMissing).toBe(true);

    mockRefreshFile.mockClear();
    let settleRefresh: (() => void) | undefined;
    mockRefreshFile.mockImplementation((refreshRequest) => {
      if (!mockSession) throw new Error('Expected an existing file session.');
      mockSession = {
        ...mockSession,
        request: refreshRequest,
        status: 'loading',
        error: null,
      };
      return new Promise((resolve) => {
        settleRefresh = (): void => resolve('file-key');
      });
    });
    await act(async () => {
      useScriptsStore.setState({
        runs: {
          'project-1/worktree-1': {
            'project:setup': completedSetupRun(),
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockRefreshFile).toHaveBeenCalledTimes(1);
    expect(mockRefreshFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'src/a.ts' }),
    );

    // openFile synchronously replaces the session with a loading object. The
    // component must consume the one-shot latch before this identity change.
    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="raw"
          active={false}
          recheckAfterWorktreeSetup
        />,
      );
      await Promise.resolve();
    });

    mockSession = {
      ...mockSession,
      status: 'error',
      error: 'File not found: src/a.ts',
    };
    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="raw"
          active={false}
          recheckAfterWorktreeSetup
        />,
      );
      await Promise.resolve();
    });
    expect(mockRefreshFile).toHaveBeenCalledTimes(1);
    expect(mockViewerProps?.deferMissing).toBe(false);

    await act(async () => {
      settleRefresh?.();
      await Promise.resolve();
    });
  });

  it('reconstructs setup retry eligibility after a renderer reload', async () => {
    useProjectsStore.setState({ projects: [makeProject('git-ready')] });
    useScriptsStore.setState({
      runs: {
        'project-1/worktree-1': {
          'project:setup': {
            ...completedSetupRun(),
            status: 'running',
            exitCode: null,
          },
        },
      },
    });
    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    mockSession = {
      key: 'file-key',
      request: mockViewerProps?.request ?? {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        fileRootLocalId: 'repo-1',
        relativePath: 'src/a.ts',
      },
      preview: null,
      content: '',
      dirty: false,
      viewMode: 'raw',
      status: 'error',
      error: 'File not found: src/a.ts',
    };
    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="raw"
          active={false}
        />,
      );
      await Promise.resolve();
    });
    expect(mockViewerProps?.deferMissing).toBe(true);

    mockRefreshFile.mockClear();
    await act(async () => {
      useScriptsStore.setState({
        runs: {
          'project-1/worktree-1': {
            'project:setup': completedSetupRun(),
          },
        },
      });
      await Promise.resolve();
    });

    expect(mockRefreshFile).toHaveBeenCalledTimes(1);
  });

  it('stops deferring when a predicted setup run never starts', async () => {
    jest.useFakeTimers();
    try {
      useProjectsStore.setState({ projects: [makeProject('git-ready')] });
      await renderViewer(
        '/repo/src/a.ts',
        [{ repoId: 'repo-1', absolutePath: '/repo' }],
        true,
        undefined,
        undefined,
        undefined,
        true,
      );
      mockSession = {
        key: 'file-key',
        request: mockViewerProps?.request ?? {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          fileRootLocalId: 'repo-1',
          relativePath: 'src/a.ts',
        },
        preview: null,
        content: '',
        dirty: false,
        viewMode: 'raw',
        status: 'error',
        error: 'File not found: src/a.ts',
      };
      await act(async () => {
        root.render(
          <DesktopSharedFileViewer
            tabId="tab-1"
            projectId="project-1"
            worktreeId="worktree-1"
            filePath="/repo/src/a.ts"
            viewMode="raw"
            active={false}
            recheckAfterWorktreeSetup
          />,
        );
        await Promise.resolve();
      });
      expect(mockViewerProps?.deferMissing).toBe(true);

      mockRefreshFile.mockImplementation((refreshRequest) => {
        if (!mockSession) throw new Error('Expected an existing file session.');
        mockSession = {
          ...mockSession,
          request: refreshRequest,
          status: 'loading',
          error: null,
        };
        return Promise.resolve('file-key');
      });

      await act(async () => {
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(mockRefreshFile).toHaveBeenCalledTimes(1);
      expect(mockViewerProps?.deferMissing).toBe(false);

      await act(async () => {
        root.render(
          <DesktopSharedFileViewer
            tabId="tab-1"
            projectId="project-1"
            worktreeId="worktree-1"
            filePath="/repo/src/a.ts"
            viewMode="raw"
            active={false}
            recheckAfterWorktreeSetup
          />,
        );
        await Promise.resolve();
      });
      mockSession = {
        ...mockSession,
        status: 'error',
        error: 'File not found: src/a.ts',
      };
      await act(async () => {
        root.render(
          <DesktopSharedFileViewer
            tabId="tab-1"
            projectId="project-1"
            worktreeId="worktree-1"
            filePath="/repo/src/a.ts"
            viewMode="raw"
            active={false}
            recheckAfterWorktreeSetup
          />,
        );
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(mockRefreshFile).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not expire the grace period while repository setup is active', async () => {
    jest.useFakeTimers();
    try {
      useProjectsStore.setState({ projects: [makeWorkspaceProject()] });
      useScriptsStore.setState({
        runs: {
          'project-1/worktree-1': {
            'workspace-repo:repo-1:setup': runningRepositorySetupRun(),
          },
        },
      });
      await renderViewer(
        '/repo/src/a.ts',
        [{ repoId: 'repo-1', absolutePath: '/repo' }],
        true,
        undefined,
        undefined,
        undefined,
        true,
      );
      mockSession = {
        key: 'file-key',
        request: mockViewerProps?.request ?? {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          fileRootLocalId: 'repo-1',
          relativePath: 'src/a.ts',
        },
        preview: null,
        content: '',
        dirty: false,
        viewMode: 'raw',
        status: 'error',
        error: 'File not found: src/a.ts',
      };
      await act(async () => {
        root.render(
          <DesktopSharedFileViewer
            tabId="tab-1"
            projectId="project-1"
            worktreeId="worktree-1"
            filePath="/repo/src/a.ts"
            viewMode="raw"
            active={false}
            recheckAfterWorktreeSetup
          />,
        );
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(mockRefreshFile).not.toHaveBeenCalled();
      expect(mockViewerProps?.deferMissing).toBe(true);

      await act(async () => {
        useScriptsStore.setState({
          runs: {
            'project-1/worktree-1': {
              'workspace-repo:repo-1:setup': completedSetupRun(),
            },
          },
        });
        await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(10_000);
        await Promise.resolve();
      });
      expect(mockRefreshFile).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    ['/repo/docs/brief.pdf', '/repo'],
    ['C:\\repo\\docs\\brief.pdf', 'C:\\repo'],
  ])(
    'injects stable document seams and a basename for %s',
    async (filePath, rootPath) => {
      await renderViewer(filePath, [
        { repoId: 'repo-1', absolutePath: rootPath },
      ]);
      const resolver = mockViewerProps?.resolveDocumentBytes;
      expect(resolver).toBeDefined();
      expect(mockViewerProps?.renderRichDocument).toBeDefined();
      expect(mockViewerProps?.documentDisplayName).toBe('brief.pdf');
      act(() => {
        root.render(
          <DesktopSharedFileViewer
            tabId="tab-1"
            projectId="project-1"
            worktreeId="worktree-1"
            filePath={filePath}
            viewMode="raw"
            active={false}
          />,
        );
      });
      expect(mockViewerProps?.resolveDocumentBytes).toBe(resolver);
      act(() => {
        root.render(
          <DesktopSharedFileViewer
            tabId="tab-1"
            projectId="project-1"
            worktreeId="worktree-1"
            filePath={filePath}
            viewMode="raw"
            active
          />,
        );
      });
      expect(mockViewerProps?.resolveDocumentBytes).toBe(resolver);
      expect(mockViewerProps).toMatchObject({ documentRetryGeneration: 1 });
      expect(mockRefreshFile).not.toHaveBeenCalled();
    },
  );

  it('renders the lazy shared PDF slot with the bytes, failure callback, and desktop assets', async () => {
    await renderViewer('/repo/brief.pdf', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    const renderDocument = mockViewerProps?.renderRichDocument;
    const request = mockViewerProps?.request;
    if (!renderDocument || !request)
      throw new Error('Document seams were not provided');
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const onRenderFailure = jest.fn();
    await act(async () => {
      root.render(
        <>
          {renderDocument({
            bytes,
            request,
            displayName: 'brief.pdf',
            renderKind: 'pdf',
            onRenderFailure,
          })}
        </>,
      );
      await Promise.resolve();
    });
    expect(mockPdfProps?.bytes).toBe(bytes);
    expect(mockPdfProps?.onRenderFailure).toBe(onRenderFailure);
    expect(mockPdfProps?.resolveAssets('5.7.284').workerSrc).toBe(
      new URL('pdf-worker/pdf.worker.min.mjs', document.baseURI).href,
    );
    expect(host.textContent).toBe('brief.pdf');
  });

  it.each([
    ['/repo/docs/brief.docx', 'docx', 'brief.docx'],
    ['/repo/data/q3.xlsx', 'xlsx', 'q3.xlsx'],
    ['/repo/slides/deck.pptx', 'pptx', 'deck.pptx'],
  ] as const)(
    'renders %s through the lazy shared Office slot with the desktop worker factory and copy',
    async (filePath, renderKind, displayName) => {
      await renderViewer(filePath, [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      expect(mockViewerProps?.supportedDocumentKinds).toEqual([
        'pdf',
        'docx',
        'xlsx',
        'pptx',
      ]);
      expect(mockViewerProps?.documentRecoveryHint).toBe(
        'Open it in its native app to view the full document.',
      );
      expect(mockViewerProps?.documentDisplayName).toBe(displayName);
      const renderDocument = mockViewerProps?.renderRichDocument;
      const request = mockViewerProps?.request;
      if (!renderDocument || !request)
        throw new Error('Document seams were not provided');
      const bytes = new Uint8Array([1, 2, 3]).buffer;
      const onRenderFailure = jest.fn();
      await act(async () => {
        root.render(
          <>
            {renderDocument({
              bytes,
              request,
              displayName,
              renderKind,
              onRenderFailure,
            })}
          </>,
        );
        await Promise.resolve();
      });
      const props =
        renderKind === 'docx'
          ? mockDocxProps
          : renderKind === 'pptx'
            ? mockPptxProps
            : mockXlsxProps;
      expect(props?.bytes).toBe(bytes);
      expect(props?.onRenderFailure).toBe(onRenderFailure);
      expect(props?.copy?.truncationRecovery).toBe(
        'Open the workbook in its native app to see everything.',
      );
      expect(props?.copy?.banner).toBe(
        'Semantic preview: formatting may differ; open in Finder for the exact document.',
      );
      props?.createWorker();
      expect(mockCreateDesktopOfficeWorker).toHaveBeenCalledTimes(1);
      expect(host.textContent).toBe(displayName);
    },
  );

  it('offers the platform open action in the header for Office previews only', async () => {
    await renderViewer('/repo/docs/brief.docx', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    const button = host.querySelector(
      '[data-testid="file-viewer-open-original"]',
    );
    expect(button?.textContent).toBe('Open in Finder');
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(window.api.showInFinder).toHaveBeenCalledWith({
      absolutePath: '/repo/docs/brief.docx',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    await renderViewer('/repo/brief.pdf', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    expect(
      host.querySelector('[data-testid="file-viewer-open-original"]'),
    ).toBeNull();
  });

  it('signals a document retry when an XLSX tab is reactivated instead of refreshing a text session', async () => {
    await renderViewer(
      '/repo/data/q3.xlsx',
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      false,
    );
    const before = mockViewerProps?.documentRetryGeneration ?? 0;
    await renderViewer(
      '/repo/data/q3.xlsx',
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
    );
    expect(mockViewerProps?.documentRetryGeneration).toBe(before + 1);
    expect(mockRefreshFile).not.toHaveBeenCalled();
  });

  it('keeps code-line comments out of PDF previews even if annotations were persisted for the path', async () => {
    const filePath = '/repo/brief.pdf';
    const annotationDocument: FileAnnotationDocument = {
      filePath,
      annotations: [],
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-07-27T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath,
            side: 'new',
            lineStart: 1,
            lineEnd: 1,
            quote: 'PDF text',
          },
          comments: [
            {
              id: 'comment-1',
              author: 'user',
              body: 'Code comment',
              createdAt: '2026-07-27T00:00:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };
    await renderViewer(
      filePath,
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      annotationDocument,
      'preview',
    );
    expect(
      host.querySelector('[data-testid="file-comments-drawer"]'),
    ).toBeNull();
  });

  it.each(['/repo/brief.pdf', '/repo/brief.docx', '/repo/q3.xlsx'])(
    'signals a document retry for %s after setup completes without a text session',
    async (filePath) => {
      useProjectsStore.setState({ projects: [makeProject('git-ready')] });
      await renderViewer(
        filePath,
        [{ repoId: 'repo-1', absolutePath: '/repo' }],
        true,
        undefined,
        undefined,
        undefined,
        true,
      );
      expect(mockViewerProps?.deferMissing).toBe(true);
      expect(mockViewerProps).toMatchObject({ documentRetryGeneration: 0 });
      await act(async () => {
        useScriptsStore.setState({
          runs: {
            'project-1/worktree-1': { 'project:setup': completedSetupRun() },
          },
        });
        await Promise.resolve();
      });
      expect(mockViewerProps).toMatchObject({
        documentRetryGeneration: 1,
        deferMissing: false,
      });
      expect(mockRefreshFile).not.toHaveBeenCalled();
    },
  );

  it('ends PDF setup deferral if the predicted run never starts', async () => {
    jest.useFakeTimers();
    try {
      useProjectsStore.setState({ projects: [makeProject('git-ready')] });
      await renderViewer(
        '/repo/brief.pdf',
        [{ repoId: 'repo-1', absolutePath: '/repo' }],
        true,
        undefined,
        undefined,
        undefined,
        true,
      );
      expect(mockViewerProps?.deferMissing).toBe(true);
      await act(async () => {
        jest.advanceTimersByTime(10000);
        await Promise.resolve();
      });
      expect(mockViewerProps).toMatchObject({
        documentRetryGeneration: 1,
        deferMissing: false,
      });
      expect(mockRefreshFile).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('signals an image retry after setup completes without a file session', async () => {
    useProjectsStore.setState({ projects: [makeProject('git-ready')] });
    await renderViewer(
      '/repo/assets/logo.png',
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(mockViewerProps?.imageRetryGeneration).toBe(0);

    await act(async () => {
      useScriptsStore.setState({
        runs: {
          'project-1/worktree-1': {
            'project:setup': completedSetupRun(),
          },
        },
      });
      await Promise.resolve();
    });

    expect(mockViewerProps?.imageRetryGeneration).toBe(1);
    expect(mockRefreshFile).not.toHaveBeenCalled();
    expect(mockViewerProps?.deferMissing).toBe(false);
  });

  it('does not defer a missing file after Git setup fails', async () => {
    useProjectsStore.setState({
      projects: [makeProject('git-ready', true)],
    });
    await renderViewer(
      '/repo/src/a.ts',
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      undefined,
      undefined,
      undefined,
      true,
    );
    mockSession = {
      key: 'file-key',
      request: mockViewerProps?.request ?? {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        fileRootLocalId: 'repo-1',
        relativePath: 'src/a.ts',
      },
      preview: null,
      content: '',
      dirty: false,
      viewMode: 'raw',
      status: 'error',
      error: 'File not found: src/a.ts',
    };
    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="raw"
          active={false}
          recheckAfterWorktreeSetup
        />,
      );
      await Promise.resolve();
    });

    expect(mockViewerProps?.deferMissing).toBe(false);
    expect(mockRefreshFile).not.toHaveBeenCalled();
  });

  it('keeps the annotation surface within the panel bounds', async () => {
    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);

    const surface = host.querySelector(
      '[data-testid="file-viewer-annotation-surface"]',
    );
    expect(surface).not.toBeNull();
    expect(surface?.classList.contains('w-full')).toBe(true);
    expect(surface?.classList.contains('min-w-0')).toBe(true);
    expect(surface?.classList.contains('flex')).toBe(false);
    // Monaco owns several absolutely-positioned layers. Clip them to the
    // editor flex region so they cannot cover the comments drawer controls or
    // its resize border.
    expect(surface?.classList.contains('overflow-hidden')).toBe(true);
  });

  it('records the file viewer root; content blocks live in the viewers', async () => {
    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);

    const panelRoot = host.querySelector(
      '[data-testid="file-viewer-annotation-surface"]',
    )?.parentElement;
    expect(panelRoot).toBe(host.firstElementChild);
    expect(panelRoot?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      false,
    );
  });

  // React reuses the root div when the loading state turns into the viewer;
  // neither carries a block, since the content blocks mount with the content.
  it('records the loading root, which the viewer root reuses', async () => {
    let resolveRoots: (value: {
      roots: Array<{ repoId: string; absolutePath: string }>;
    }) => void = () => undefined;
    installApi({
      getFileTreeRoots: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveRoots = resolve;
          }),
      ),
      showInFinder: jest.fn().mockResolvedValue(undefined),
      fileAnnotations: {
        get: jest.fn().mockResolvedValue({
          filePath: '/repo/src/a.ts',
          annotations: [],
          commentThreads: [],
        }),
        save: mockSaveAnnotations,
        onUpdated: jest.fn().mockReturnValue(() => undefined),
      },
    });
    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="raw"
          active
        />,
      );
      await Promise.resolve();
    });

    const loadingRoot = host.firstElementChild;
    expect(
      loadingRoot?.querySelector('[data-testid="loading"]'),
    ).not.toBeNull();
    expect(loadingRoot?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      false,
    );

    await act(async () => {
      resolveRoots({ roots: [{ repoId: 'repo-1', absolutePath: '/repo' }] });
      await Promise.resolve();
    });
    expect(
      host.querySelector('[data-testid="file-viewer-annotation-surface"]')
        ?.parentElement,
    ).toBe(loadingRoot);
  });

  it('records the error root', async () => {
    await renderViewer('/elsewhere/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    await act(async () => {
      await Promise.resolve();
    });

    const errorRoot = host.firstElementChild;
    expect(errorRoot?.textContent).toBe(
      'File is outside the available project roots.',
    );
    expect(errorRoot?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      false,
    );
  });

  it('keeps rendered-view annotation markers off the scrollbar rail', async () => {
    const filePath = '/repo/README.md';
    const content = 'first\nmarked\nlast';
    mockSession = {
      key: 'file-key',
      request: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        fileRootLocalId: 'repo-1',
        relativePath: 'README.md',
      },
      preview: {
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        fileRootLocalId: 'repo-1',
        path: 'README.md',
        content,
        language: 'markdown',
        size: content.length,
        version: 'v1',
        truncated: false,
      },
      content,
      dirty: false,
      viewMode: 'preview',
      status: 'idle',
      error: null,
    };
    const annotationDocument: FileAnnotationDocument = {
      filePath,
      annotations: [],
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-07-27T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath,
            side: 'new',
            lineStart: 2,
            lineEnd: 2,
            quote: 'marked',
          },
          comments: [
            {
              id: 'comment-1',
              author: 'user',
              body: 'Please update this.',
              createdAt: '2026-07-27T00:00:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };
    await renderViewer(
      filePath,
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      annotationDocument,
      'preview',
    );
    await act(async () => Promise.resolve());

    const strip = host.querySelector('[aria-label="File annotations"]');
    expect(strip).not.toBeNull();
    // CAN-3518: a strip that covers the scroll container's scrollbar rail, or
    // takes pointer input along its whole height, stops the thumb from being
    // dragged and swallows wheel input. It sits beside the rail and lets
    // everything but its marker buttons through.
    expect(
      strip?.classList.contains('right-[var(--canopy-scrollbar-rail-size)]'),
    ).toBe(true);
    expect(strip?.classList.contains('pointer-events-none')).toBe(true);

    const marker = strip?.querySelector(
      'button[aria-label="File comment thread"]',
    );
    expect(marker).not.toBeNull();
    expect(marker?.closest('.pointer-events-auto')).not.toBeNull();
    expect(
      strip?.contains(marker?.closest('.pointer-events-auto') ?? null),
    ).toBe(true);
    expect(strip?.getAttribute('data-testid')).toBe('file-annotation-markers');
  });

  it('shows selection actions before opening the Monaco comment composer', async () => {
    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    await act(async () => Promise.resolve());

    act(() => {
      mockSelectionHandler?.({
        lineStart: 1,
        lineEnd: 1,
        quote: 'const value = 1;',
        anchorRect: new DOMRect(20, 40, 12, 16),
      });
    });

    expect(
      document.querySelector('[data-testid="file-selection-menu"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="review-comment-composer"]'),
    ).toBeNull();

    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-selection-comment"]',
        )
        ?.click();
    });
    expect(
      document.querySelector('[data-testid="review-comment-composer"]'),
    ).not.toBeNull();
  });

  it('shows selection actions after a Markdown preview selection without stealing focus', async () => {
    const content = 'first\nselected\nlast';
    mockSession = {
      key: 'file-key',
      request: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        fileRootLocalId: 'repo-1',
        relativePath: 'README.md',
      },
      preview: {
        workspaceLocalId: 'project-1',
        worktreeLocalId: 'worktree-1',
        fileRootLocalId: 'repo-1',
        path: 'README.md',
        content,
        language: 'markdown',
        size: content.length,
        version: 'v1',
        truncated: false,
      },
      content,
      dirty: false,
      viewMode: 'preview',
      status: 'idle',
      error: null,
    };
    await renderViewer(
      '/repo/README.md',
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      undefined,
      'preview',
    );
    await act(async () => Promise.resolve());

    const focusTarget = document.createElement('input');
    host.appendChild(focusTarget);
    focusTarget.focus();
    const richContent = host.querySelector<HTMLElement>(
      '[data-testid="mock-rich-file-content"]',
    );
    const textNode = richContent?.firstChild;
    if (!(textNode instanceof Text)) {
      throw new Error('Expected Markdown preview text content');
    }
    const range = document.createRange();
    range.setStart(textNode, content.indexOf('selected'));
    range.setEnd(textNode, content.indexOf('selected') + 'selected'.length);
    Object.defineProperty(range, 'getBoundingClientRect', {
      value: (): DOMRect => new DOMRect(20, 40, 80, 16),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    act(() => {
      richContent?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    expect(document.activeElement).toBe(focusTarget);
    expect(
      document.querySelector('[data-testid="file-selection-menu"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="review-comment-composer"]'),
    ).toBeNull();

    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-selection-comment"]',
        )
        ?.click();
    });
    expect(
      document.querySelector('[data-testid="review-comment-composer"]'),
    ).not.toBeNull();
  });

  it('sends selected text only to the deterministically resolved chat draft', async () => {
    mockWorktreeChats = {
      'project-1/worktree-1': {
        activeTabId: 'tab-1',
        lastActiveEditableChatId: 'chat-current',
        tabs: [
          { id: 'tab-1', kind: 'file' },
          { id: 'chat-current', kind: 'chat' },
          { id: 'chat-other', kind: 'chat' },
        ],
      },
    };
    mockGetTabDraft.mockReturnValue([
      { type: 'paragraph', children: [{ text: 'Existing draft' }] },
    ]);
    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    await act(async () => Promise.resolve());

    act(() => {
      mockSelectionHandler?.({
        lineStart: 1,
        lineEnd: 1,
        quote: 'const value = 1;',
        anchorRect: new DOMRect(20, 40, 12, 16),
      });
    });
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-selection-send-to-chat"]',
        )
        ?.click();
    });

    expect(mockGetTabDraft).toHaveBeenCalledWith('chat-current');
    expect(mockSaveTabDraft).toHaveBeenCalledWith('chat-current', [
      { type: 'paragraph', children: [{ text: 'Existing draft' }] },
      { type: 'paragraph', children: [{ text: 'const value = 1;' }] },
    ]);
    expect(mockSaveTabDraft).toHaveBeenCalledTimes(1);
    expect(mockSwitchTab).toHaveBeenCalledWith('chat-current', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
  });

  it.each([
    ['raw', 'worktree', 'project-1', 'worktree-1'],
    ['preview', 'worktree', 'project-1', 'worktree-1'],
    ['raw', 'Cowork', 'cowork-workspace', 'entry-1'],
    ['preview', 'Cowork', 'cowork-workspace', 'entry-1'],
    ['raw', 'App Advisor', 'app-advisor', 'entry-1'],
    ['preview', 'App Advisor', 'app-advisor', 'entry-1'],
  ] as const)(
    'delivers Markdown %s selection text to the mounted %s composer',
    async (viewMode, _surface, projectId, worktreeId) => {
      const content = 'first\nselected\nlast';
      const targetKey = `${projectId}/${worktreeId}`;
      mockWorktreeChats = {
        [targetKey]: {
          activeTabId: 'file-tab',
          lastActiveEditableChatId: 'chat-current',
          tabs: [
            { id: 'file-tab', kind: 'file' },
            { id: 'chat-current', kind: 'chat' },
          ],
        },
      };
      mockSession = {
        key: 'file-key',
        request: {
          projectId,
          worktreeId,
          fileRootLocalId: 'repo-1',
          relativePath: 'README.md',
        },
        preview: {
          workspaceLocalId: projectId,
          worktreeLocalId: worktreeId,
          fileRootLocalId: 'repo-1',
          path: 'README.md',
          content,
          language: 'markdown',
          size: content.length,
          version: 'v1',
          truncated: false,
        },
        content,
        dirty: false,
        viewMode,
        status: 'idle',
        error: null,
      };
      const received: InsertChatTextDetail[] = [];
      const handleInsert = (event: Event): void => {
        if (!(event instanceof CustomEvent)) return;
        const detail: unknown = event.detail;
        if (!isInsertChatTextDetail(detail)) return;
        received.push(detail);
        detail.markHandled?.();
      };
      document.addEventListener(INSERT_CHAT_TEXT_EVENT, handleInsert);
      try {
        await renderViewer(
          '/repo/README.md',
          [{ repoId: 'repo-1', absolutePath: '/repo' }],
          true,
          undefined,
          viewMode,
          { projectId, worktreeId },
        );
        await act(async () => Promise.resolve());

        if (viewMode === 'raw') {
          act(() => {
            mockSelectionHandler?.({
              lineStart: 2,
              lineEnd: 2,
              quote: 'selected',
              anchorRect: new DOMRect(20, 40, 80, 16),
            });
          });
        } else {
          const richContent = host.querySelector<HTMLElement>(
            '[data-testid="mock-rich-file-content"]',
          );
          const textNode = richContent?.firstChild;
          if (!(textNode instanceof Text)) {
            throw new Error('Expected Markdown preview text content');
          }
          const range = document.createRange();
          range.setStart(textNode, content.indexOf('selected'));
          range.setEnd(
            textNode,
            content.indexOf('selected') + 'selected'.length,
          );
          Object.defineProperty(range, 'getBoundingClientRect', {
            value: (): DOMRect => new DOMRect(20, 40, 80, 16),
          });
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
          act(() => {
            richContent.dispatchEvent(
              new MouseEvent('mouseup', { bubbles: true }),
            );
          });
        }

        act(() => {
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="file-selection-send-to-chat"]',
            )
            ?.click();
        });

        expect(received).toEqual([
          expect.objectContaining({
            text: 'selected',
            targetTabId: 'chat-current',
          }),
        ]);
        expect(mockSaveTabDraft).not.toHaveBeenCalled();
        expect(mockSwitchTab).toHaveBeenCalledWith('chat-current', {
          projectId,
          worktreeId,
        });
      } finally {
        document.removeEventListener(INSERT_CHAT_TEXT_EVENT, handleInsert);
      }
    },
  );

  it('anchors unique rich-view selections and leaves duplicate text unanchored', () => {
    expect(
      resolveRichSelectionLines('first\nselected\nlast', 'selected'),
    ).toEqual({
      lineStart: 2,
      lineEnd: 2,
    });
    expect(
      resolveRichSelectionLines('repeated\nmiddle\nrepeated', 'repeated'),
    ).toBeNull();
  });

  it('submits to the currently open chat instead of the presentation origin', async () => {
    const filePath = '/repo/src/a.ts';
    const annotationDocument: FileAnnotationDocument = {
      filePath,
      annotations: [],
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-07-27T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath,
            side: 'new',
            lineStart: 1,
            lineEnd: 1,
            quote: 'const value = 1;',
          },
          comments: [
            {
              id: 'comment-1',
              author: 'user',
              body: 'Please update this.',
              createdAt: '2026-07-27T00:00:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };
    mockWorktreeChats = {
      'project-1/worktree-1': {
        activeTabId: 'tab-1',
        lastActiveEditableChatId: 'chat-current',
        tabs: [
          { id: 'tab-1', kind: 'file' },
          { id: 'chat-current', kind: 'chat' },
        ],
      },
    };
    useAgentFilePresentationStore.setState({
      byTabId: {
        'tab-1': {
          revision: 1,
          origin: {
            projectId: 'app-advisor',
            worktreeId: 'entry-origin',
            chatTabId: 'chat-origin',
          },
        },
      },
    });
    let acceptDispatch: (() => void) | undefined;
    mockSendMessage.mockImplementationOnce(
      (_text, _files, _target, _inputMode, options): Promise<void> => {
        acceptDispatch = options.onDispatchAccepted;
        return Promise.resolve();
      },
    );

    await renderViewer(
      filePath,
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      annotationDocument,
    );
    await act(async () => Promise.resolve());
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-comments-submit"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockSaveAnnotations).not.toHaveBeenCalled();
    await act(async () => {
      acceptDispatch?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockSaveAnnotations).toHaveBeenCalledTimes(1);

    expect(mockLoadTabsForTarget).not.toHaveBeenCalled();
    expect(mockSwitchTab).toHaveBeenCalledWith('chat-current', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringContaining('File comment thread `thread-1`'),
      undefined,
      {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatId: 'chat-current',
      },
      undefined,
      expect.any(Object),
    );
    expect(mockSendMessage.mock.calls[0]?.[4].hiddenContext.kind).toBe(
      'file-comment-instructions',
    );
    expect(mockSendMessage.mock.calls[0]?.[4]).toMatchObject({
      throwOnDispatchFailure: true,
    });
  });

  it('keeps staged comments unchanged when chat dispatch is not accepted', async () => {
    const filePath = '/repo/src/a.ts';
    const annotationDocument: FileAnnotationDocument = {
      filePath,
      annotations: [],
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-07-27T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath,
            side: 'new',
            lineStart: 1,
            lineEnd: 1,
            quote: 'const value = 1;',
          },
          comments: [
            {
              id: 'comment-1',
              author: 'user',
              body: 'Please update this.',
              createdAt: '2026-07-27T00:00:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };
    mockWorktreeChats = {
      'project-1/worktree-1': {
        activeTabId: 'tab-1',
        tabs: [
          { id: 'tab-1', kind: 'file' },
          { id: 'chat-origin', kind: 'chat', attentionDismissedAt: 1 },
        ],
      },
    };
    useAgentFilePresentationStore.setState({
      byTabId: {
        'tab-1': {
          revision: 1,
          origin: {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatTabId: 'chat-origin',
          },
        },
      },
    });
    let rejectDispatch: (() => void) | undefined;
    mockSendMessage.mockImplementationOnce(
      (_text, _files, _target, _inputMode, options): Promise<void> => {
        rejectDispatch = options.onDispatchRejected;
        return Promise.resolve();
      },
    );

    await renderViewer(
      filePath,
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      annotationDocument,
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-comments-submit"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockSaveAnnotations).not.toHaveBeenCalled();
    await act(async () => {
      rejectDispatch?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockSaveAnnotations).not.toHaveBeenCalled();
  });

  it('attempts to create a chat when none exists, but leaves comments staged if creation does not produce one', async () => {
    const filePath = '/repo/src/a.ts';
    const annotationDocument: FileAnnotationDocument = {
      filePath,
      annotations: [],
      commentThreads: [
        {
          id: 'thread-1',
          status: 'open',
          createdAt: '2026-07-27T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            filePath,
            side: 'new',
            lineStart: 1,
            lineEnd: 1,
            quote: 'const value = 1;',
          },
          comments: [
            {
              id: 'comment-1',
              author: 'user',
              body: 'Keep this staged.',
              createdAt: '2026-07-27T00:00:00.000Z',
              staged: true,
            },
          ],
        },
      ],
    };
    mockWorktreeChats = {
      'project-1/worktree-1': {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', kind: 'file' }],
      },
    };

    await renderViewer(
      filePath,
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      annotationDocument,
    );
    await act(async () => Promise.resolve());
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-comments-submit"]',
        )
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // No existing editable chat: dispatch now falls back to the normal chat
    // creation path (CAN-4198 phase 04 S3) instead of silently doing nothing.
    // The mock does not materialize a new tab, so no chat ends up editable
    // and the message is never sent — comments stay staged.
    expect(mockEnsureWorktreeHasChatTab).toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSaveAnnotations).not.toHaveBeenCalled();
  });

  it('hides an unusable diff reveal when no comparison context exists', async () => {
    const filePath = '/repo/src/a.ts';
    const annotationDocument: FileAnnotationDocument = {
      filePath,
      annotations: [],
      commentThreads: [],
    };
    const codeReview: CodeReviewFile = {
      version: 1,
      armed: true,
      commentThreads: [
        {
          id: 'retained-diff-thread',
          status: 'open',
          createdAt: '2026-07-27T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'code',
            view: 'diff',
            filePath,
            side: 'new',
            lineStart: 1,
            lineEnd: 1,
            quote: 'const value = 1;',
            diff: {
              source: 'uncommitted',
              snapshotId: 'retained-snapshot',
            },
          },
          comments: [
            {
              id: 'comment-1',
              author: 'user',
              body: 'Retained diff comment.',
              createdAt: '2026-07-27T00:00:00.000Z',
              staged: false,
            },
          ],
        },
      ],
      diagrams: {},
    };
    mockWorktreeChats = {
      'project-1/worktree-1': {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', kind: 'file' }],
      },
    };

    await renderViewer(
      filePath,
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      annotationDocument,
      'raw',
      { projectId: 'project-1', worktreeId: 'worktree-1' },
      false,
      codeReview,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="file-comments-archived-toggle"]',
        )
        ?.click();
    });
    expect(host.textContent).toContain('Retained diff comment.');
    expect(
      host.querySelector('button[aria-label="Reveal Line 1 in diff"]'),
    ).toBeNull();
  });

  it('labels diagram comment reveal controls with their actual origin', async () => {
    const filePath = '/repo/src/a.ts';
    const annotationDocument: FileAnnotationDocument = {
      filePath,
      annotations: [],
      commentThreads: [
        {
          id: 'diagram-thread',
          status: 'open',
          createdAt: '2026-07-27T00:00:00.000Z',
          anchorState: 'matched',
          anchor: {
            source: 'diagram',
            diagramKind: 'logicDiff',
            nodeId: 'compare',
            quote: 'Compare changes',
            unanchored: false,
          },
          comments: [
            {
              id: 'comment-1',
              author: 'user',
              body: 'Explain this diagram change.',
              createdAt: '2026-07-27T00:00:00.000Z',
              staged: false,
            },
          ],
        },
      ],
    };

    await renderViewer(
      filePath,
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
      annotationDocument,
    );
    await act(async () => Promise.resolve());

    expect(
      host.querySelector(
        'button[aria-label="Reveal Diagram · Compare changes in diagram"]',
      ),
    ).not.toBeNull();
  });

  it.each(['archive.zip', 'report.docm', 'numbers.xls', 'deck.pptm'])(
    'reveals unsupported %s through the native file manager action',
    async (filename) => {
      Object.defineProperty(window, 'platform', {
        configurable: true,
        value: 'darwin',
      });
      const showInFinder = jest.fn().mockResolvedValue(undefined);
      installApi({
        getFileTreeRoots: jest.fn().mockResolvedValue({
          roots: [{ repoId: 'repo-1', absolutePath: '/repo' }],
        }),
        showInFinder,
        fileAnnotations: {
          get: jest.fn().mockResolvedValue({
            filePath: `/repo/${filename}`,
            annotations: [],
            commentThreads: [],
          }),
          save: mockSaveAnnotations,
          onUpdated: jest.fn().mockReturnValue(() => undefined),
        },
      });
      await act(async () => {
        root.render(
          <DesktopSharedFileViewer
            tabId="tab-1"
            projectId="project-1"
            worktreeId="worktree-1"
            filePath={`/repo/${filename}`}
            viewMode="raw"
            active
          />,
        );
        await Promise.resolve();
      });

      const action = mockViewerProps?.unsupportedFileAction;
      expect(action).toBeDefined();
      await act(async () => {
        root.render(<>{action}</>);
        await Promise.resolve();
      });
      const button = host.querySelector<HTMLButtonElement>(
        '[data-testid="file-viewer-open-unsupported"]',
      );
      expect(button?.textContent).toBe('Open in Finder');
      button?.click();
      expect(showInFinder).toHaveBeenCalledWith({
        absolutePath: `/repo/${filename}`,
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      });
    },
  );

  it('normalizes aliases and preserves Monaco language ids', async () => {
    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    const renderEditor = mockViewerProps?.renderEditor;
    expect(renderEditor).toBeDefined();

    await act(async () => {
      root.render(
        <>
          {renderEditor?.({
            value: 'const value: number = 1;',
            // Shared previews carry extension hints, which are not necessarily
            // Monaco ids (`ts` versus `typescript`).
            language: 'ts',
            filePath: 'src/a.ts',
            dirty: false,
            onChange: jest.fn(),
            onSave: jest.fn(),
          })}
        </>,
      );
      await Promise.resolve();
    });

    expect(mockMonacoEditorLanguage).toBe('typescript');

    await act(async () => {
      root.render(
        <>
          {renderEditor?.({
            value: 'print("hello")',
            language: 'lua',
            filePath: 'src/script.lua',
            dirty: false,
            onChange: jest.fn(),
            onSave: jest.fn(),
          })}
        </>,
      );
      await Promise.resolve();
    });

    expect(mockMonacoEditorLanguage).toBe('lua');
  });

  it('selects the longest matching root for nested project repos', async () => {
    await renderViewer('/repo/packages/inner/src/a.ts', [
      { repoId: 'repo-outer', absolutePath: '/repo' },
      { repoId: 'repo-inner', absolutePath: '/repo/packages/inner' },
    ]);

    expect(mockRegisterTab).toHaveBeenCalledWith('tab-1', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      fileRootLocalId: 'repo-inner',
      relativePath: 'src/a.ts',
    });
  });

  it('re-registers idempotently on rerender without unregistering', async () => {
    await renderViewer('/repo/src/a.ts', [
      { repoId: 'repo-1', absolutePath: '/repo' },
    ]);
    mockRegisterTab.mockClear();

    // Rerender inactive with the same routing: the resolve effect keys on
    // (filePath, projectId, worktreeId) only, so it does not re-run, and the
    // viewer never unregisters on unmount — the tab/session stays open.
    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="raw"
          active={false}
        />,
      );
      await Promise.resolve();
    });
    expect(mockRegisterTab).not.toHaveBeenCalled();
  });

  it('re-reads a preserved file exactly once when it becomes active again', async () => {
    await renderViewer(
      '/repo/src/a.ts',
      [{ repoId: 'repo-1', absolutePath: '/repo' }],
      true,
    );
    mockRefreshFile.mockClear();

    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="preview"
          active={false}
        />,
      );
      await Promise.resolve();
    });
    expect(mockRefreshFile).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/src/a.ts"
          viewMode="preview"
          active
        />,
      );
      await Promise.resolve();
    });
    expect(mockRefreshFile).toHaveBeenCalledTimes(1);
    expect(mockRefreshFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'src/a.ts' }),
    );
  });

  it.each([
    ['report.md', 'preview'],
    ['report.MARKDOWN', 'preview'],
    ['report.mdx', 'preview'],
    ['page.html', 'preview'],
    ['page.htm', 'preview'],
    ['rows.csv', 'table'],
    ['module.ts', undefined],
  ])(
    'opens a relative link to %s in its supported rendered mode',
    async (filename, initialViewMode) => {
      const resolveFileReference = jest.fn().mockResolvedValue({
        absolutePath: `/repo/docs/${filename}`,
        filename,
      });
      await renderViewer('/repo/readme.md', [
        { repoId: 'repo-1', absolutePath: '/repo' },
      ]);
      installApi({ resolveFileReference });
      mockViewerProps?.onOpenRelativePath?.(`docs/${filename}`);
      await act(async () => Promise.resolve());
      expect(resolveFileReference).toHaveBeenCalledWith({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        baseFilePath: '/repo/readme.md',
        href: `docs/${filename}`,
      });
      expect(mockOpenFileTab).toHaveBeenCalledWith(
        { absolutePath: `/repo/docs/${filename}`, filename, initialViewMode },
        { projectId: 'project-1', worktreeId: 'worktree-1' },
      );
    },
  );

  it('opens relative links and resolves local image content through desktop IPC', async () => {
    const resolveFileReference = jest.fn().mockResolvedValue({
      absolutePath: '/repo/assets/logo.png',
      filename: 'logo.png',
    });
    const readFileContent = jest.fn().mockResolvedValue({
      kind: 'image',
      content: 'data:image/png;base64,abc',
    });
    installApi({
      getFileTreeRoots: jest.fn().mockResolvedValue({
        roots: [{ repoId: 'repo-1', absolutePath: '/repo' }],
      }),
      resolveFileReference,
      readFileContent,
      fileAnnotations: {
        get: jest.fn().mockResolvedValue({
          filePath: '/repo/readme.md',
          annotations: [],
          commentThreads: [],
        }),
        save: jest.fn().mockResolvedValue(undefined),
        onUpdated: jest.fn().mockReturnValue(() => undefined),
      },
    });
    await act(async () => {
      root.render(
        <DesktopSharedFileViewer
          tabId="tab-1"
          projectId="project-1"
          worktreeId="worktree-1"
          filePath="/repo/readme.md"
          viewMode="preview"
          active
        />,
      );
      await Promise.resolve();
    });

    mockViewerProps?.onOpenRelativePath?.('assets/logo.png');
    await act(async () => Promise.resolve());
    expect(mockOpenFileTab).toHaveBeenCalledWith(
      {
        absolutePath: '/repo/assets/logo.png',
        filename: 'logo.png',
      },
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );
    await expect(
      mockViewerProps?.resolveAssetSrc?.('assets/logo.png'),
    ).resolves.toBe('data:image/png;base64,abc');
    expect(readFileContent).toHaveBeenCalledWith({
      absolutePath: '/repo/assets/logo.png',
      workspaceTarget: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });
    await expect(
      mockViewerProps?.resolveImageSrc?.(mockViewerProps.request),
    ).resolves.toBe('data:image/png;base64,abc');
    expect(readFileContent).toHaveBeenLastCalledWith({
      absolutePath: '/repo/readme.md',
      workspaceTarget: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });
    expect(mockViewerProps?.contentScrollBinding).toBeDefined();

    // Late-loading content re-applies the persisted scroll position through
    // the bridge's onContentLoaded → scheduleRestoreScrollPosition wiring.
    mockViewerProps?.contentScrollBinding?.onContentLoaded?.();
    expect(mockScheduleRestoreScrollPosition).toHaveBeenCalledTimes(1);
  });
});
