/** @jest-environment jsdom */

import type { FileContentResponse } from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';

const mockOpenFileTab = jest.fn();
const mockSetFileTabViewMode = jest.fn();
const mockSwitchTab = jest.fn();
const mockSelectWorktree = jest.fn();
const mockLoadTabsForTarget = jest.fn();
const mockPresent = jest.fn();
const mockRequestPlacement = jest.fn();
const mockPlaceBesideChat = jest.fn();
const mockAppendAnnotations = jest.fn();
const mockReadFileContent = jest.fn();
const mockGetFileTreeRoots = jest.fn();
const mockSelectWorkEntry = jest.fn();
const mockOpenFileInBrowserPanel = jest.fn();
const mockRequestBrowserPanel = jest.fn();

jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): {
      worktreeChats: Record<string, { tabs: unknown[] }>;
      openFileTab: typeof mockOpenFileTab;
      setFileTabViewMode: typeof mockSetFileTabViewMode;
      switchTab: typeof mockSwitchTab;
      selectWorktree: typeof mockSelectWorktree;
      loadTabsForTarget: typeof mockLoadTabsForTarget;
    } => ({
      worktreeChats: { 'project-1/worktree-1': { tabs: [] } },
      openFileTab: mockOpenFileTab,
      setFileTabViewMode: mockSetFileTabViewMode,
      switchTab: mockSwitchTab,
      selectWorktree: mockSelectWorktree,
      loadTabsForTarget: mockLoadTabsForTarget,
    }),
  },
}));

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): { selectWorkEntry: jest.Mock } => ({
      selectWorkEntry: mockSelectWorkEntry,
    }),
  },
}));

jest.mock('@/stores/agentFilePresentationStore', () => ({
  useAgentFilePresentationStore: {
    getState: (): { present: typeof mockPresent } => ({
      present: mockPresent,
    }),
  },
}));

jest.mock('@/lib/panels/chat-panel-sync', () => ({
  requestFilePanelPlacementBesideChat: mockRequestPlacement,
  placeFilePanelsBesideChat: mockPlaceBesideChat,
}));

jest.mock('@/lib/openFileInBrowserPanel', () => ({
  openFileInBrowserPanel: mockOpenFileInBrowserPanel,
}));

jest.mock('@/lib/browserPanelActivation', () => ({
  requestBrowserPanel: mockRequestBrowserPanel,
}));

import { showFilesInRenderer } from '../show-files';
import { useBrowserStore } from '@/stores/browserStore';

function file(
  kind: 'markdown' | 'text' | 'unsupported' | 'html',
  filename: string,
  content: string,
): FileContentResponse {
  return {
    kind,
    filename,
    content,
    sizeBytes: content.length,
    truncated: false,
    modifiedAtMs: 1,
  };
}

describe('showFilesInRenderer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOpenFileTab
      .mockReset()
      .mockReturnValueOnce('tab-readme')
      .mockReturnValueOnce('tab-source');
    mockReadFileContent
      .mockReset()
      .mockResolvedValueOnce(
        file('markdown', 'README.md', '# Title\nBody\nEnd'),
      )
      .mockResolvedValueOnce(file('unsupported', 'archive.zip', ''))
      .mockResolvedValueOnce(file('text', 'source.ts', 'one\ntwo\nthree'));
    mockGetFileTreeRoots.mockReset().mockResolvedValue({
      roots: [
        {
          repoId: 'repo-1',
          absolutePath: '/workspace',
          name: 'workspace',
        },
      ],
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getFileTreeRoots: mockGetFileTreeRoots,
        readFileContent: mockReadFileContent,
        fileAnnotations: {
          append: mockAppendAnnotations.mockResolvedValue(undefined),
        },
      },
    });
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens supported files as one ordered batch and reports unsupported files as partial failures', async () => {
    const result = await showFilesInRenderer(
      {
        target: { projectId: 'project-1', worktreeId: 'worktree-1' },
        origin: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatTabId: 'chat-1',
        },
        files: [
          {
            path: 'README.md',
            view: 'rich',
            line: 2,
            annotations: [
              {
                startLine: 2,
                title: 'Read this',
                comment: 'Please review this line.',
              },
            ],
          },
          { path: 'archive.zip' },
          { path: 'source.ts', view: 'raw', line: 99 },
        ],
      },
      'main',
    );

    expect(result).toMatchObject({
      opened: 2,
      failed: 1,
      files: [
        { path: 'README.md', ok: true, tabId: 'tab-readme' },
        {
          path: 'archive.zip',
          ok: false,
          error: 'This file type is not supported by the app for opening.',
        },
        { path: 'source.ts', ok: true, tabId: 'tab-source' },
      ],
    });
    expect(mockSetFileTabViewMode).toHaveBeenCalledWith(
      'tab-readme',
      'preview',
      { projectId: 'project-1', worktreeId: 'worktree-1' },
    );
    expect(mockSetFileTabViewMode).toHaveBeenCalledWith('tab-source', 'raw', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(mockPresent).toHaveBeenNthCalledWith(1, 'tab-readme', {
      line: 2,
      origin: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatTabId: 'chat-1',
      },
    });
    expect(mockPresent).toHaveBeenNthCalledWith(2, 'tab-source', {
      origin: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        chatTabId: 'chat-1',
      },
    });
    expect(mockReadFileContent).toHaveBeenNthCalledWith(1, {
      absolutePath: '/workspace/README.md',
      workspaceTarget: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });
    expect(mockPlaceBesideChat).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
      ['tab-readme', 'tab-source'],
      'chat-1',
      { activate: true },
    );
    expect(mockSwitchTab).toHaveBeenCalledWith('tab-readme', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
    expect(mockAppendAnnotations).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        filePath: '/workspace/README.md',
        annotations: [
          expect.objectContaining({
            title: 'Read this',
            lineStart: 2,
            lineEnd: 2,
          }),
        ],
        commentThreads: [
          expect.objectContaining({
            status: 'open',
            comments: [
              expect.objectContaining({
                author: 'agent',
                body: 'Please review this line.',
              }),
            ],
          }),
        ],
      }),
    );
  });

  it('opens a file in a background cowork work entry without changing the visible selection', async () => {
    mockReadFileContent
      .mockReset()
      .mockResolvedValueOnce(file('text', 'background.ts', 'export {};'));
    mockOpenFileTab.mockReset().mockReturnValueOnce('tab-background');

    const result = await showFilesInRenderer(
      {
        target: { projectId: 'cowork-2', worktreeId: 'entry-2' },
        origin: {
          projectId: 'cowork-2',
          worktreeId: 'entry-2',
          chatTabId: 'chat-background',
        },
        files: [{ path: 'background.ts' }],
      },
      'main',
    );

    expect(result.files[0]).toMatchObject({
      ok: true,
      tabId: 'tab-background',
    });
    expect(mockSelectWorktree).not.toHaveBeenCalled();
    expect(mockLoadTabsForTarget).toHaveBeenCalledWith('cowork-2', 'entry-2');
    expect(mockOpenFileTab).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'background.ts' }),
      { projectId: 'cowork-2', worktreeId: 'entry-2' },
      { activate: false },
    );
    expect(mockSwitchTab).toHaveBeenCalledWith('tab-background', {
      projectId: 'cowork-2',
      worktreeId: 'entry-2',
    });
  });

  it('opens a file in a background App Advisor work entry without selecting it', async () => {
    mockReadFileContent
      .mockReset()
      .mockResolvedValueOnce(file('text', 'background.ts', 'export {};'));
    mockOpenFileTab.mockReset().mockReturnValueOnce('tab-advisor-background');

    const result = await showFilesInRenderer(
      {
        target: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-background',
        },
        origin: {
          projectId: APP_ADVISOR_PROJECT_ID,
          worktreeId: 'entry-background',
          chatTabId: 'chat-advisor-background',
        },
        files: [{ path: 'background.ts' }],
      },
      'app-advisor',
    );

    expect(result.files[0]).toMatchObject({
      ok: true,
      tabId: 'tab-advisor-background',
    });
    expect(mockSelectWorkEntry).not.toHaveBeenCalled();
    expect(mockSelectWorktree).not.toHaveBeenCalled();
    expect(mockLoadTabsForTarget).toHaveBeenCalledWith(
      APP_ADVISOR_PROJECT_ID,
      'entry-background',
    );
  });

  it('reactivates an already-open file without waiting for an animation frame', async () => {
    mockReadFileContent
      .mockReset()
      .mockResolvedValueOnce(file('markdown', 'README.md', '# Title'));
    mockOpenFileTab.mockReset().mockReturnValue('tab-readme');
    jest.mocked(window.requestAnimationFrame).mockImplementation(() => 1);

    const resultPromise = showFilesInRenderer(
      {
        target: { projectId: 'project-1', worktreeId: 'worktree-1' },
        origin: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatTabId: 'chat-1',
        },
        files: [{ path: 'README.md', view: 'rich' }],
      },
      'main',
    );

    const settled = await Promise.race([
      resultPromise,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 0)),
    ]);

    expect(settled).toMatchObject({
      opened: 1,
      failed: 0,
      files: [{ path: 'README.md', ok: true, tabId: 'tab-readme' }],
    });
    expect(mockOpenFileTab).toHaveBeenCalledTimes(1);
    expect(mockSwitchTab).toHaveBeenCalledWith('tab-readme', {
      projectId: 'project-1',
      worktreeId: 'worktree-1',
    });
  });

  it('caps aggregate persisted annotation quotes while still opening the file', async () => {
    const longLine = 'x'.repeat(200 * 1024);
    mockReadFileContent
      .mockReset()
      .mockResolvedValueOnce(
        file('text', 'large.ts', `${longLine}\n${longLine}`),
      );

    const result = await showFilesInRenderer(
      {
        target: { projectId: 'project-1', worktreeId: 'worktree-1' },
        origin: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatTabId: 'chat-1',
        },
        files: [
          {
            path: 'large.ts',
            annotations: [
              { startLine: 1, comment: 'Keep the first quote.' },
              { startLine: 2, comment: 'Skip the second quote.' },
            ],
          },
        ],
      },
      'main',
    );

    expect(result.files[0]).toMatchObject({
      ok: true,
      warning:
        '1 annotation skipped because annotation quotes exceed the 256 KiB request limit.',
    });
    expect(mockAppendAnnotations).toHaveBeenCalledWith(
      expect.objectContaining({
        annotations: [expect.objectContaining({ lineStart: 1 })],
        commentThreads: [expect.objectContaining({ status: 'open' })],
      }),
    );
  });

  it('uses native separators for relative paths under Windows roots', async () => {
    mockGetFileTreeRoots.mockResolvedValueOnce({
      roots: [
        {
          repoId: 'repo-1',
          absolutePath: String.raw`C:\workspace`,
          name: 'workspace',
        },
      ],
    });
    mockReadFileContent
      .mockReset()
      .mockResolvedValueOnce(file('text', 'source.ts', 'export {};'));
    mockOpenFileTab.mockReset().mockReturnValueOnce('tab-windows-source');

    const result = await showFilesInRenderer(
      {
        target: { projectId: 'project-1', worktreeId: 'worktree-1' },
        origin: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatTabId: 'chat-1',
        },
        files: [{ path: 'src/components/source.ts' }],
      },
      'main',
    );

    const expectedPath = String.raw`C:\workspace\src\components\source.ts`;
    expect(mockReadFileContent).toHaveBeenCalledWith({
      absolutePath: expectedPath,
      workspaceTarget: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });
    expect(mockOpenFileTab).toHaveBeenCalledWith(
      {
        absolutePath: expectedPath,
        filename: 'source.ts',
      },
      { projectId: 'project-1', worktreeId: 'worktree-1' },
      { activate: false },
    );
    expect(result.files[0]).toMatchObject({
      ok: true,
      absolutePath: expectedPath,
    });
  });

  it('preserves UNC prefixes and compares network-share roots case-insensitively', async () => {
    const workspaceRoot = String.raw`\\SERVER\Share`;
    const requestedPath = String.raw`\\server\share\src\source.ts`;
    mockGetFileTreeRoots.mockResolvedValueOnce({
      roots: [
        {
          repoId: 'repo-1',
          absolutePath: workspaceRoot,
          name: 'Share',
        },
      ],
    });
    mockReadFileContent
      .mockReset()
      .mockResolvedValueOnce(file('text', 'source.ts', 'export {};'));
    mockOpenFileTab.mockReset().mockReturnValueOnce('tab-unc-source');

    const result = await showFilesInRenderer(
      {
        target: { projectId: 'project-1', worktreeId: 'worktree-1' },
        origin: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          chatTabId: 'chat-1',
        },
        files: [{ path: requestedPath }],
      },
      'main',
    );

    expect(mockReadFileContent).toHaveBeenCalledWith({
      absolutePath: requestedPath,
      workspaceTarget: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });
    expect(result.files[0]).toMatchObject({
      ok: true,
      absolutePath: requestedPath,
    });
  });

  describe('HTML files', () => {
    const target = { projectId: 'project-1', worktreeId: 'worktree-1' };
    const origin = { ...target, chatTabId: 'chat-1' };
    const page = file(
      'html',
      'index.html',
      '<link rel="stylesheet" href="styles.css">\n<h1>Hi</h1>',
    );

    beforeEach(() => {
      mockOpenFileTab.mockReset();
      mockReadFileContent.mockReset();
      mockOpenFileInBrowserPanel.mockReset().mockResolvedValue('browser-1');
      mockRequestBrowserPanel.mockReset().mockResolvedValue(true);
    });

    it('opens an HTML page rendered in the browser beside the chat', async () => {
      mockReadFileContent.mockResolvedValueOnce(page);

      const result = await showFilesInRenderer(
        { target, origin, files: [{ path: 'site/index.html' }] },
        'main',
      );

      expect(mockOpenFileInBrowserPanel).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        '/workspace/site/index.html',
        // The tool reports the outcome, so it waits for the live session.
        { originChatTabId: 'chat-1', focus: false, awaitReady: true },
      );
      expect(mockOpenFileTab).not.toHaveBeenCalled();
      expect(mockRequestBrowserPanel).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'browser-1',
        'chat-1',
        { focus: true, queue: false },
      );
      expect(result).toEqual({
        presentation: 'foreground',
        activated: true,
        opened: 1,
        failed: 0,
        files: [
          {
            path: 'site/index.html',
            ok: true,
            opened: true,
            activated: true,
            absolutePath: '/workspace/site/index.html',
            openedIn: 'browser',
            browserId: 'browser-1',
          },
        ],
      });
    });

    it.each([
      ['view: raw', { view: 'raw' as const }],
      ['a line', { line: 2 }],
      ['annotations', { annotations: [{ startLine: 1, title: 'Styles' }] }],
    ])(
      'keeps HTML in the source viewer when %s is requested',
      async (_label, options) => {
        mockReadFileContent.mockResolvedValueOnce(page);
        mockOpenFileTab.mockReturnValueOnce('tab-page');

        const result = await showFilesInRenderer(
          { target, origin, files: [{ path: 'site/index.html', ...options }] },
          'main',
        );

        expect(mockOpenFileInBrowserPanel).not.toHaveBeenCalled();
        expect(mockOpenFileTab).toHaveBeenCalledTimes(1);
        expect(result.files[0]).toMatchObject({ ok: true, tabId: 'tab-page' });
        expect(result.files[0]).not.toHaveProperty('openedIn');
      },
    );

    it('splits a multi-file page and keeps the first-requested page active', async () => {
      mockReadFileContent
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce(file('text', 'app.js', 'run();'));
      mockOpenFileTab.mockReturnValueOnce('tab-app');

      const result = await showFilesInRenderer(
        {
          target,
          origin,
          files: [{ path: 'site/index.html' }, { path: 'site/app.js' }],
        },
        'main',
      );

      expect(mockPlaceBesideChat).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        ['tab-app'],
        'chat-1',
        { activate: true },
      );
      expect(mockOpenFileInBrowserPanel).toHaveBeenCalledTimes(1);
      expect(mockSwitchTab).not.toHaveBeenCalled();
      expect(mockRequestBrowserPanel).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        'browser-1',
        'chat-1',
        { focus: true, queue: false },
      );
      expect(result.files.map((entry) => entry.ok)).toEqual([true, true]);
      expect(result.opened).toBe(2);
    });

    it('keeps a first-requested source file active over a later page', async () => {
      mockReadFileContent
        .mockResolvedValueOnce(file('text', 'app.js', 'run();'))
        .mockResolvedValueOnce(page);
      mockOpenFileTab.mockReturnValueOnce('tab-app');

      await showFilesInRenderer(
        {
          target,
          origin,
          files: [{ path: 'site/app.js' }, { path: 'site/index.html' }],
        },
        'main',
      );

      expect(mockOpenFileInBrowserPanel).toHaveBeenCalledTimes(1);
      expect(mockSwitchTab).toHaveBeenCalledWith('tab-app', target);
      expect(mockRequestBrowserPanel).not.toHaveBeenCalled();
    });

    it('reports a browser that could not open as a failure', async () => {
      mockReadFileContent
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce(file('text', 'app.js', 'run();'));
      mockOpenFileTab.mockReturnValueOnce('tab-app');
      mockOpenFileInBrowserPanel.mockResolvedValueOnce(null);

      const result = await showFilesInRenderer(
        {
          target,
          origin,
          files: [{ path: 'site/index.html' }, { path: 'site/app.js' }],
        },
        'main',
      );

      expect(result.opened).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.files[0]).toMatchObject({
        path: 'site/index.html',
        ok: false,
        absolutePath: '/workspace/site/index.html',
        error: 'The page could not be opened in the browser.',
      });
      expect(mockRequestBrowserPanel).not.toHaveBeenCalled();
      expect(mockSwitchTab).toHaveBeenCalledWith('tab-app', target);
    });
  });

  describe('presentation policy (CAN-4663)', () => {
    const target = { projectId: 'project-1', worktreeId: 'worktree-1' };
    const origin = { ...target, chatTabId: 'chat-1' };
    const handoff = {
      handoffId: 'handoff-1',
      ...target,
      browserId: 'browser-1',
      origin,
      requestedAt: 1,
    };

    afterEach(() => {
      useBrowserStore.setState({ browserHandoffs: {} });
    });

    it('opens agent files in the background without selecting or focusing them', async () => {
      const result = await showFilesInRenderer(
        {
          intent: 'agent',
          presentation: 'background',
          reason: 'browser_handoff',
          handoffId: 'handoff-1',
          target,
          origin,
          files: [{ path: 'README.md' }],
        },
        'main',
      );

      expect(mockOpenFileTab).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'README.md' }),
        target,
        { activate: false },
      );
      expect(mockPlaceBesideChat).toHaveBeenCalledWith(
        'project-1',
        'worktree-1',
        ['tab-readme'],
        'chat-1',
        { activate: false },
      );
      expect(mockSwitchTab).not.toHaveBeenCalled();
      expect(mockRequestBrowserPanel).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        presentation: 'background',
        reason: 'browser_handoff',
        activated: false,
        opened: 1,
        files: [
          { path: 'README.md', ok: true, opened: true, activated: false },
        ],
      });
    });

    it('keeps a handoff that started mid-flight by rechecking the renderer mirror', async () => {
      useBrowserStore.setState({
        browserHandoffs: {
          'project-1/worktree-1': { handoff, revision: 1 },
        },
      });

      const result = await showFilesInRenderer(
        { intent: 'agent', target, origin, files: [{ path: 'README.md' }] },
        'main',
      );

      expect(mockOpenFileTab).toHaveBeenCalledWith(expect.anything(), target, {
        activate: false,
      });
      expect(mockSwitchTab).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        presentation: 'background',
        reason: 'browser_handoff',
        activated: false,
      });
    });

    it('rechecks background policy after an awaited file read', async () => {
      mockReadFileContent.mockReset().mockImplementationOnce(async () => {
        await Promise.resolve();
        useBrowserStore.setState({
          browserHandoffs: { 'project-1/worktree-1': { handoff, revision: 1 } },
        });
        return file('markdown', 'README.md', '# Report');
      });
      await showFilesInRenderer(
        {
          intent: 'agent',
          presentation: 'foreground',
          target,
          origin,
          files: [{ path: 'README.md' }],
        },
        'main',
      );
      expect(mockOpenFileTab).toHaveBeenCalledWith(expect.anything(), target, {
        activate: false,
      });
      expect(mockSwitchTab).not.toHaveBeenCalled();
    });

    it('still opens and activates an explicit user request during a handoff', async () => {
      useBrowserStore.setState({
        browserHandoffs: {
          'project-1/worktree-1': { handoff, revision: 1 },
        },
      });

      const result = await showFilesInRenderer(
        {
          intent: 'user',
          focusReturnId: 'focus-1',
          target,
          origin,
          files: [{ path: 'README.md' }],
        },
        'main',
      );

      expect(mockOpenFileTab).toHaveBeenCalledWith(expect.anything(), target, {
        activate: true,
      });
      expect(mockSwitchTab).toHaveBeenCalledWith('tab-readme', target);
      expect(result).toMatchObject({
        presentation: 'foreground',
        activated: true,
        files: [{ path: 'README.md', opened: true, activated: true }],
      });
    });

    it('never opens a deferred agent request', async () => {
      const result = await showFilesInRenderer(
        {
          intent: 'agent',
          presentation: 'deferred',
          reason: 'automation_turn',
          target,
          origin,
          files: [{ path: '.canopy/schedule-state.json' }],
        },
        'main',
      );

      expect(mockGetFileTreeRoots).not.toHaveBeenCalled();
      expect(mockOpenFileTab).not.toHaveBeenCalled();
      expect(mockOpenFileInBrowserPanel).not.toHaveBeenCalled();
      expect(mockSwitchTab).not.toHaveBeenCalled();
      expect(result).toEqual({
        presentation: 'deferred',
        reason: 'automation_turn',
        opened: 0,
        failed: 0,
        activated: false,
        deferred: 1,
        files: [
          {
            path: '.canopy/schedule-state.json',
            ok: true,
            opened: false,
            activated: false,
            deferred: true,
          },
        ],
      });
    });
  });
});
