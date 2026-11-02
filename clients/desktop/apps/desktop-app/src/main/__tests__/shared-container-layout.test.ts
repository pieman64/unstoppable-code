import {
  lstat,
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import {
  readSanitizedSharedContainerPublishedLayout,
  sanitizeSharedContainerPublishedLayout,
} from '../shared-containers/publish/layout';
import {
  pinSharedContainerPreferredLayoutIfMissing,
  writeSharedContainerFileScope,
} from '../shared-containers/file-scope-store';
import { getWorktreePanelLayoutFilePath } from '../lib/paths';
import {
  assertSharedContainerViewerFileForRead,
  resolveSharedContainerViewerFileForRead,
} from '../shared-containers/read/viewer-root';
import type { SharedContainerReader } from '../shared-containers/read/reader';

describe('shared-container published layout sanitizer', () => {
  it('keeps published chat/files and web pages, and drops terminals and outside paths', () => {
    const root = '/publisher/repo';
    const tabs: PersistedChatTab[] = [
      {
        id: 'chat-1',
        title: 'Chat',
        messages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'file-1',
        title: 'Index',
        messages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        kind: 'file',
        filePath: `${root}/site/index.html`,
        fileViewMode: 'preview',
      },
      {
        id: 'outside',
        title: 'Secret',
        messages: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        kind: 'file',
        filePath: '/private/secret.txt',
      },
    ];
    // Full browser states: the exact result below proves no other browser field
    // reaches the published layout.
    const browserStates = [
      {
        id: 'local',
        projectId: 'project',
        worktreeId: 'worktree',
        createdAt: 0,
        updatedAt: 0,
        url: pathToFileURL(`${root}/site/index.html`).href,
        title: '',
        status: 'idle',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        themeMode: 'light',
        pickMode: false,
        recording: false,
      },
      {
        id: 'network',
        projectId: 'project',
        worktreeId: 'worktree',
        createdAt: 0,
        updatedAt: 0,
        url: 'https://example.com/private-history',
        title: '',
        status: 'idle',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        themeMode: 'light',
        pickMode: false,
        recording: false,
      },
      {
        id: 'localhost',
        projectId: 'project',
        worktreeId: 'worktree',
        createdAt: 0,
        updatedAt: 0,
        url: 'http://localhost:5173/dashboard',
        title: '',
        status: 'idle',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        themeMode: 'light',
        pickMode: false,
        recording: false,
      },
      {
        id: 'loopback',
        projectId: 'project',
        worktreeId: 'worktree',
        createdAt: 0,
        updatedAt: 0,
        url: 'http://127.0.0.1:8080/',
        title: '',
        status: 'idle',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        themeMode: 'light',
        pickMode: false,
        recording: false,
      },
      {
        id: 'blank',
        projectId: 'project',
        worktreeId: 'worktree',
        createdAt: 0,
        updatedAt: 0,
        url: 'about:blank',
        title: '',
        status: 'idle',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        themeMode: 'light',
        pickMode: false,
        recording: false,
      },
      {
        id: 'outside-file',
        projectId: 'project',
        worktreeId: 'worktree',
        createdAt: 0,
        updatedAt: 0,
        url: 'file:///private/secret.html',
        title: '',
        status: 'idle',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        themeMode: 'light',
        pickMode: false,
        recording: false,
      },
    ];
    const result = sanitizeSharedContainerPublishedLayout({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'leaf',
            groupId: 'group-1',
            size: 1200,
            activePanelId: 'file',
            panels: [
              {
                panelId: 'chat',
                kind: 'chat',
                instance: { chatTabId: 'chat-1' },
              },
              {
                panelId: 'file',
                kind: 'chat',
                instance: { chatTabId: 'file-1' },
              },
              {
                panelId: 'outside',
                kind: 'chat',
                instance: { chatTabId: 'outside' },
              },
              {
                panelId: 'local-browser',
                kind: 'browser',
                instance: { browserId: 'local' },
              },
              {
                panelId: 'network-browser',
                kind: 'browser',
                instance: { browserId: 'network' },
              },
              {
                panelId: 'localhost-browser',
                kind: 'browser',
                instance: { browserId: 'localhost' },
              },
              {
                panelId: 'loopback-browser',
                kind: 'browser',
                instance: { browserId: 'loopback' },
              },
              {
                panelId: 'blank-browser',
                kind: 'browser',
                instance: { browserId: 'blank' },
              },
              {
                panelId: 'outside-file-browser',
                kind: 'browser',
                instance: { browserId: 'outside-file' },
              },
              { panelId: 'terminal', kind: 'terminal' },
            ],
          },
        },
        activeGroupId: 'group-1',
        mostRecentActiveGroupIds: ['group-1'],
      },
      tabs,
      publishedChatIds: new Set(['chat-1']),
      roots: [
        {
          repoId: 'repo-1',
          absolutePath: root,
          publishedPaths: new Set(['site/index.html']),
        },
      ],
      browsers: browserStates,
    });

    expect(result).toEqual({
      orientation: 1,
      root: {
        type: 'leaf',
        size: 1200,
        activeTabIndex: 1,
        tabs: [
          { kind: 'chat', chatId: 'chat-1' },
          {
            kind: 'file',
            repoId: 'repo-1',
            relativePath: 'site/index.html',
            viewMode: 'rich',
          },
          {
            kind: 'browser',
            repoId: 'repo-1',
            relativePath: 'site/index.html',
          },
          { kind: 'browser', url: 'https://example.com/private-history' },
          { kind: 'browser', url: 'http://localhost:5173/dashboard' },
          { kind: 'browser', url: 'http://127.0.0.1:8080/' },
        ],
      },
    });
  });
});

describe('shared-container published plan panels', () => {
  // Q1: plan kinds are not part of the published layout in this change. A
  // recipient opens plans from the Plans section instead.
  it('omits plan and plan-diagram panels and plan-only groups', () => {
    const result = sanitizeSharedContainerPublishedLayout({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'branch',
            size: 800,
            children: [
              {
                type: 'leaf',
                groupId: 'group-chat',
                size: 700,
                activePanelId: 'plan',
                panels: [
                  {
                    panelId: 'plan',
                    kind: 'plan',
                    title: 'Plan one',
                    instance: { planId: 'plan-1' },
                  },
                  {
                    panelId: 'chat',
                    kind: 'chat',
                    instance: { chatTabId: 'chat-1' },
                  },
                ],
              },
              {
                type: 'leaf',
                groupId: 'group-plan-diagram',
                size: 500,
                activePanelId: 'plan-diagram',
                panels: [
                  {
                    panelId: 'plan-diagram',
                    kind: 'plan-diagram',
                    instance: { planId: 'plan-1' },
                  },
                ],
              },
            ],
          },
        },
        activeGroupId: 'group-chat',
        mostRecentActiveGroupIds: ['group-chat', 'group-plan-diagram'],
      },
      tabs: [
        {
          id: 'chat-1',
          title: 'Chat',
          messages: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      publishedChatIds: new Set(['chat-1']),
      roots: [],
    });

    expect(result).toEqual({
      orientation: 1,
      root: {
        type: 'branch',
        size: 800,
        children: [
          {
            type: 'leaf',
            size: 700,
            activeTabIndex: 0,
            tabs: [{ kind: 'chat', chatId: 'chat-1' }],
          },
        ],
      },
    });
  });
});

describe('shared-container published file panels', () => {
  const root = '/publisher/repo';
  const fileTab = (
    id: string,
    extra: Partial<PersistedChatTab>,
  ): PersistedChatTab => ({
    id,
    title: id,
    messages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    kind: 'file',
    filePath: `${root}/README.md`,
    ...extra,
  });

  it('publishes a file panel with its bound tab view, not always as a diff', () => {
    const result = sanitizeSharedContainerPublishedLayout({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'leaf',
            groupId: 'group-1',
            size: 1200,
            activePanelId: 'raw',
            panels: ['raw', 'diff'].map((id) => ({
              panelId: id,
              kind: 'file-diff' as const,
              instance: { fileTabId: id, filePath: `${root}/README.md` },
            })),
          },
        },
        activeGroupId: 'group-1',
        mostRecentActiveGroupIds: ['group-1'],
      },
      tabs: [
        fileTab('raw', { fileViewMode: 'raw' }),
        fileTab('diff', {
          fileViewMode: 'diff',
          fileDiffContext: { path: 'README.md', source: 'combined' },
        }),
      ],
      publishedChatIds: new Set(),
      roots: [
        {
          repoId: 'repo-1',
          absolutePath: root,
          publishedPaths: new Set(['README.md']),
        },
      ],
    });

    expect(result?.root).toEqual({
      type: 'leaf',
      size: 1200,
      activeTabIndex: 0,
      tabs: [
        {
          kind: 'file',
          repoId: 'repo-1',
          relativePath: 'README.md',
          viewMode: 'raw',
        },
        {
          kind: 'file-diff',
          repoId: 'repo-1',
          relativePath: 'README.md',
          viewMode: 'diff',
        },
      ],
    });
  });
});

describe('shared-container published pipeline run panels', () => {
  it('never publishes a pipeline run panel, and drops a group holding only runs', () => {
    const result = sanitizeSharedContainerPublishedLayout({
      layout: {
        version: 1,
        grid: {
          orientation: 1,
          width: 1200,
          height: 800,
          root: {
            type: 'branch',
            size: 800,
            children: [
              {
                type: 'leaf',
                groupId: 'group-mixed',
                size: 600,
                activePanelId: 'panel-pipeline-run-1',
                panels: [
                  {
                    panelId: 'panel-pipeline-run-1',
                    kind: 'pipeline-execution',
                    instance: { executionId: 'run-1' },
                  },
                  { panelId: 'panel-activity', kind: 'activity-section' },
                ],
              },
              {
                type: 'leaf',
                groupId: 'group-runs',
                size: 600,
                activePanelId: 'panel-pipeline-run-2',
                panels: [
                  {
                    panelId: 'panel-pipeline-run-2',
                    kind: 'pipeline-execution',
                    instance: { executionId: 'run-2' },
                  },
                ],
              },
            ],
          },
        },
        activeGroupId: 'group-mixed',
        mostRecentActiveGroupIds: ['group-mixed', 'group-runs'],
      },
      tabs: [],
      publishedChatIds: new Set(),
      roots: [],
    });

    expect(result).toEqual({
      orientation: 1,
      root: {
        type: 'branch',
        size: 800,
        children: [
          {
            type: 'leaf',
            size: 600,
            activeTabIndex: 0,
            tabs: [{ kind: 'activity-section' }],
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('run-');
  });
});

describe('shared-container viewer read boundary', () => {
  let directory: string;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('rejects containment escapes and symlink files', async () => {
    directory = await mkdtemp(join(tmpdir(), 'canopy-viewer-root-'));
    const revisionRoot = join(directory, 'revision');
    const repoRoot = join(revisionRoot, 'repos', 'repo-1');
    await mkdir(repoRoot, { recursive: true });
    await writeFile(join(repoRoot, 'safe.txt'), 'safe');
    await writeFile(join(directory, 'outside.txt'), 'outside');
    await symlink(join(directory, 'outside.txt'), join(repoRoot, 'link.txt'));

    const store = {
      get: (): Promise<{ status: 'available'; revisionId: string }> =>
        Promise.resolve({
          status: 'available',
          revisionId: 'revision-1',
        }),
      resolvePathBelowForRead: (_root: string, ...parts: string[]): string =>
        resolve(_root, ...parts),
      assertRealDirectoryForRead: (): Promise<void> => Promise.resolve(),
      lstatEntryForRead: (_root: string, target: string): Promise<Stats> =>
        lstat(target),
    };
    const reader = {
      store,
      readForkLayout: (): Promise<
        Awaited<ReturnType<SharedContainerReader['readForkLayout']>>
      > =>
        Promise.resolve({
          root: revisionRoot,
          layout: {
            schemaVersion: 1,
            containerType: 'CODE_WORKTREE',
            title: 'Share',
            repositories: [
              {
                repoId: 'repo-1',
                repoName: 'Repo',
                remoteUrl: 'https://github.com/acme/repo.git',
                owner: 'acme',
                repository: 'repo',
                baseCommitSha: 'a'.repeat(40),
                files: [],
              },
            ],
            files: [],
            notes: [],
            prompts: [],
            attachmentPaths: {},
          },
        }),
    } as unknown as SharedContainerReader;

    await expect(
      resolveSharedContainerViewerFileForRead(
        'container-1',
        join(directory, 'outside.txt'),
        reader,
      ),
    ).rejects.toThrow('outside');
    await expect(
      assertSharedContainerViewerFileForRead(
        'container-1',
        join(repoRoot, 'link.txt'),
        reader,
      ),
    ).rejects.toThrow('regular file');
    await expect(
      assertSharedContainerViewerFileForRead(
        'container-1',
        join(repoRoot, 'safe.txt'),
        reader,
      ),
    ).resolves.toMatchObject({ relativePath: 'safe.txt' });
  });
});

describe('shared-container published preferred layout', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let dataDir = '';

  const chatTab = (id: string): PersistedChatTab => ({
    id,
    title: id,
    messages: [],
    createdAt: new Date(0).toISOString(),
  });

  async function writeLiveLayout(chatIds: readonly string[]): Promise<void> {
    const filePath = getWorktreePanelLayoutFilePath('project-1', 'worktree-1');
    await mkdir(resolve(filePath, '..'), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        grid: {
          orientation: 0,
          root: {
            type: 'leaf',
            groupId: 'group-1',
            panels: chatIds.map((chatId) => ({
              panelId: `panel-${chatId}`,
              kind: 'chat',
              instance: { chatTabId: chatId },
            })),
            activePanelId: `panel-${chatIds[0]}`,
            size: 1,
          },
          width: 1200,
          height: 800,
        },
        activeGroupId: 'group-1',
        mostRecentActiveGroupIds: ['group-1'],
      }),
      'utf8',
    );
  }

  const capture = (
    publishedChatIds: readonly string[],
  ): ReturnType<typeof readSanitizedSharedContainerPublishedLayout> =>
    readSanitizedSharedContainerPublishedLayout({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      tabs: ['chat-1', 'chat-2', 'chat-3'].map(chatTab),
      publishedChatIds: new Set(publishedChatIds),
      roots: [],
    });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'shared-container-pin-'));
    process.env.CANOPY_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('pins a scope with no stored choice at the first publish', async () => {
    await writeLiveLayout(['chat-1', 'chat-2']);

    await expect(capture(['chat-1', 'chat-2'])).resolves.toEqual({
      orientation: 0,
      root: {
        type: 'leaf',
        size: 1,
        tabs: [
          { kind: 'chat', chatId: 'chat-1' },
          { kind: 'chat', chatId: 'chat-2' },
        ],
        activeTabIndex: 0,
      },
    });
  });

  it('publishes the pinned layout after the live layout changes', async () => {
    await writeLiveLayout(['chat-1', 'chat-2']);
    await capture(['chat-1', 'chat-2', 'chat-3']);
    await writeLiveLayout(['chat-3']);

    const layout = await capture(['chat-1', 'chat-2', 'chat-3']);

    expect(layout?.root).toMatchObject({
      tabs: [
        { kind: 'chat', chatId: 'chat-1' },
        { kind: 'chat', chatId: 'chat-2' },
      ],
    });
  });

  it('drops pinned panels whose chat left the published set', async () => {
    await writeLiveLayout(['chat-1', 'chat-2']);
    await capture(['chat-1', 'chat-2']);

    const layout = await capture(['chat-2']);

    expect(layout?.root).toMatchObject({
      tabs: [{ kind: 'chat', chatId: 'chat-2' }],
    });
  });

  it('ships no layout when every pinned panel was dropped, and keeps the pin', async () => {
    await writeLiveLayout(['chat-1']);
    await capture(['chat-1']);
    await writeLiveLayout(['chat-3']);

    await expect(capture(['chat-3'])).resolves.toBeUndefined();
    await expect(capture(['chat-1'])).resolves.toBeDefined();
  });

  it('ships no layout when the preferred layout is off', async () => {
    await writeLiveLayout(['chat-1']);
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      preferredLayout: { enabled: false },
    });

    await expect(capture(['chat-1'])).resolves.toBeUndefined();
  });

  it('ships no layout when the scope turns off after the pin', async () => {
    await writeLiveLayout(['chat-1']);
    await pinSharedContainerPreferredLayoutIfMissing('project-1', 'worktree-1');
    await writeSharedContainerFileScope('project-1', 'worktree-1', {
      includedPaths: [],
      preferredLayout: { enabled: false },
    });

    await expect(capture(['chat-1'])).resolves.toBeUndefined();
  });

  it('ships no layout when there is no local layout to pin', async () => {
    await expect(capture(['chat-1'])).resolves.toBeUndefined();
  });
});
