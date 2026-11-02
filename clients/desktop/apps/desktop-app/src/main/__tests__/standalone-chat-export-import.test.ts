import type * as ChatStateServiceModule from '../services/chat-state-service';
// Real-fs round-trip coverage for the cowork-workspace export/import-project
// bundle reshape: `exportProject`/`importProject` in `../ipc/standalone-chat`
// used to bundle/restore the legacy `standalone-chat/{project}` on-disk shape
// directly. That tree is deleted by the cowork migration, so this suite
// exercises the new bundle format (`cowork-workspace.json` manifest +
// `home/` + `chats/home.json` + `chat-history/`) against a real filesystem
// rather than mocking `node:fs/promises`, since the whole point is verifying
// real directory trees get produced and restored correctly.

jest.mock('../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
  sendToWindow: jest.fn(),
}));
jest.mock('electron', () => ({
  dialog: {
    showOpenDialog: jest.fn(),
  },
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../agents/utils', () => ({
  generateChatSummary: jest.fn(),
}));
jest.mock('../plugins/workspace-template-import', () => ({
  resolveDesktopWorkspaceTemplate: jest.fn().mockResolvedValue({
    selections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    },
    unresolvedRefs: [],
  }),
}));
const flushScopeMock = jest.fn<Promise<void>, [string, string]>(() =>
  Promise.resolve(),
);
jest.mock('../services/chat-state-service', () => {
  const actual = jest.requireActual<typeof ChatStateServiceModule>(
    '../services/chat-state-service',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      getChatStateService: {
        value: (): ChatStateServiceModule.ChatStateService => {
          const service = actual.getChatStateService();
          return new Proxy(service, {
            get(target, key): unknown {
              if (key === 'flushScope')
                return async (
                  projectId: string,
                  worktreeId: string,
                ): Promise<void> => {
                  await flushScopeMock(projectId, worktreeId);
                  await target.flushScope(projectId, worktreeId);
                };
              const value: unknown = Reflect.get(target, key);
              return typeof value === 'function'
                ? (...args: unknown[]): unknown =>
                    Reflect.apply(value, target, args)
                : value;
            },
          });
        },
        enumerable: true,
      },
    },
  );
});

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COWORK_HOME_WORKTREE_ID,
  IPC_CHANNELS,
  type ChatProjectData,
  type ChatTabsFile,
} from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { registerIpcHandler } from '../ipc/register';
import type { SessionDiagnosticRecord } from '../observability/service';
import {
  ChatStateService,
  getChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { registerChatProjectHandlers } from '../ipc/chat-projects';
import { registerStandaloneChatHandlers } from '../ipc/standalone-chat';
import * as chatProjectUtils from '../lib/chat-project-utils';
import {
  createCoworkWorkspace,
  listCoworkWorkspacesAsChatProjects,
  updateCoworkWorkspace,
} from '../lib/cowork-workspace-crud';
import {
  getWorkspaceChatHistoryDir,
  getWorkspaceChatTabsFilePath,
  getWorkspaceDir,
  getWorkspaceHomeDir,
  getWorkspaceWorkEntriesFilePath,
} from '../lib/paths';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { VisualStagingStoreImpl } from '../lib/visual-staging';
import type { StageVisualDocument } from '../lib/chat-visual-contracts';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);

type HandlerFn = (event: undefined, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }
  const handler = call[1];
  if (!(handler instanceof Function)) {
    throw new Error(`Invalid handler for ${channel}`);
  }
  return async (_event: undefined, ...args: unknown[]): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, [undefined, ...args]));
}

async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function hasChatProjectDataShape(value: unknown): value is ChatProjectData {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string'
  ) {
    return false;
  }
  return true;
}

function asChatProjectData(value: unknown): ChatProjectData {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('project' in value) ||
    !hasChatProjectDataShape(value.project)
  ) {
    throw new Error('Expected a StandaloneProjectImportResponse');
  }
  return value.project;
}

function asExportedPath(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('exportedPath' in value) ||
    typeof value.exportedPath !== 'string'
  ) {
    throw new Error('Expected a StandaloneProjectExportResponse');
  }
  return value.exportedPath;
}

// These tests do real filesystem and git work. Under a loaded multi-worker
// Jest run they have exceeded Jest's default 5 s, so leave headroom here.
jest.setTimeout(60_000);

describe('standalone chat export/import project (real fs)', () => {
  let dataDir: string;
  let exportsDir: string;
  let originalDataDir: string | undefined;
  // The default service records storage diagnostics through the process
  // observability service, which writes under CANOPY_DATA_DIR asynchronously,
  // racing the temp data dir's removal and the env var's restoration.
  const recordDiagnostic = jest.fn<void, [SessionDiagnosticRecord]>();

  beforeEach(async () => {
    jest.clearAllMocks();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-cowork-export-import-'),
    );
    exportsDir = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-cowork-export-import-dest-'),
    );
    process.env.CANOPY_DATA_DIR = dataDir;
    flushScopeMock.mockClear();
    resetChatStateServiceForTests(new ChatStateService({ recordDiagnostic }));
    registerChatProjectHandlers();
    registerStandaloneChatHandlers();
  });

  afterEach(async () => {
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    try {
      await getChatStateService().drain();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
    await rm(exportsDir, { recursive: true, force: true });
  });

  it('exports a cowork project into a portable bundle and imports it back as a new project', async () => {
    const created = await createCoworkWorkspace(
      'Alpha Project',
      '2026-01-01T00:00:00.000Z',
    );
    const sourceWorkspaceId = created.id;

    await updateCoworkWorkspace({
      projectId: sourceWorkspaceId,
      color: '#123456',
      description: 'Test description',
      defaultModel: 'claude-opus-4',
      archiveRetentionDays: 30,
    });

    // Seed home/ content: overwrite the scaffolded CLAUDE.md, add a plain
    // top-level file, and add a file inside a managed subfolder.
    const sourceHome = getWorkspaceHomeDir(sourceWorkspaceId);
    await writeTextFile(
      path.join(sourceHome, 'CLAUDE.md'),
      '# Alpha project instructions',
    );
    await writeTextFile(
      path.join(sourceHome, 'top-level-file.txt'),
      'a plain project file',
    );
    await writeTextFile(
      path.join(getCoworkManagedSubdir(sourceHome, 'notes'), 'note1.md'),
      '# Note one',
    );

    // Seed chats/home.json.
    const chatTabsFile: ChatTabsFile = {
      version: 1,
      activeTabId: 'tab-1',
      tabs: [
        {
          id: 'tab-1',
          title: 'My chat',
          createdAt: '2026-01-02T00:00:00.000Z',
          providerType: 'claude',
          approvalMode: 'full-access',
          sessionApprovalRules: [
            {
              id: 'imported-allow',
              behavior: 'allow',
              target: { kind: 'command', pattern: '*' },
              createdAt: '2026-01-02T00:00:00.000Z',
              origin: 'prompt',
            },
          ],
          messages: [],
        },
      ],
    };
    await writeTextFile(
      getWorkspaceChatTabsFilePath(sourceWorkspaceId, COWORK_HOME_WORKTREE_ID),
      JSON.stringify(chatTabsFile, null, 2),
    );
    await writeTextFile(
      `${getWorkspaceChatTabsFilePath(sourceWorkspaceId, COWORK_HOME_WORKTREE_ID)}.bak`,
      'private rollback transcript',
    );
    const orphanedCheckpoint = path.join(
      path.dirname(
        getWorkspaceChatTabsFilePath(
          sourceWorkspaceId,
          COWORK_HOME_WORKTREE_ID,
        ),
      ),
      '.home.json.123.456-orphan.tmp',
    );
    await writeTextFile(orphanedCheckpoint, 'stale private transcript');
    await writeTextFile(
      path.join(
        getWorkspaceDir(sourceWorkspaceId),
        'chat-archives',
        'entry-1.json',
      ),
      JSON.stringify({
        version: 1,
        archived: [
          {
            tab: {
              ...chatTabsFile.tabs[0],
              id: 'archived-tab-1',
              approvalMode: 'full-access',
              sessionApprovalRules: [
                {
                  id: 'archived-imported-allow',
                  behavior: 'allow',
                  target: { kind: 'command', pattern: '*' },
                  createdAt: '2026-01-02T00:00:00.000Z',
                  origin: 'prompt',
                },
              ],
            },
            archivedAt: '2026-01-04T00:00:00.000Z',
            turnCount: 1,
          },
        ],
      }),
    );

    // Seed chat-history/chat-1/.
    const sourceHistoryChatDir = getWorkspaceChatHistoryDir(
      sourceWorkspaceId,
      'chat-1',
    );
    await writeTextFile(
      path.join(sourceHistoryChatDir, 'meta.json'),
      JSON.stringify({
        version: 1,
        id: 'chat-1',
        title: 'Archived chat',
        description: 'An archived chat',
        createdAt: '2026-01-03T00:00:00.000Z',
      }),
    );
    await writeTextFile(
      path.join(sourceHistoryChatDir, 'summary.md'),
      'Archived chat summary',
    );
    await writeTextFile(
      path.join(sourceHistoryChatDir, 'conversation.json'),
      JSON.stringify({
        version: 1,
        projectId: sourceWorkspaceId,
        chatId: 'chat-1',
        archivedAt: '2026-01-03T00:00:00.000Z',
        tab: {
          id: 'chat-1',
          title: 'Archived chat',
          createdAt: '2026-01-03T00:00:00.000Z',
          messages: [],
          approvalMode: 'full-access',
          sessionApprovalRules: [
            {
              id: 'history-imported-allow',
              behavior: 'allow',
              target: { kind: 'command', pattern: '*' },
              createdAt: '2026-01-03T00:00:00.000Z',
              origin: 'prompt',
            },
          ],
        },
      }),
    );

    await getChatStateService().getState({
      projectId: sourceWorkspaceId,
      worktreeId: COWORK_HOME_WORKTREE_ID,
    });
    const staging = new VisualStagingStoreImpl(
      path.join(
        getWorkspaceDir(sourceWorkspaceId),
        'chat-storage-v2',
        COWORK_HOME_WORKTREE_ID,
        'visual-staging',
      ),
    );
    const stagedVisual: StageVisualDocument = {
      visualId: 'vis_123e4567-e89b-12d3-a456-426614174000',
      html: '<!doctype html><html><body>portable staging</body></html>',
      title: 'Portable staging visual',
      maxHeight: 400,
    };
    await staging.initialize(Date.now());
    await staging.stage({ chatId: 'tab-1' }, stagedVisual, Date.now());

    // --- Export ---
    const exportResponse = await getHandler(
      IPC_CHANNELS.standaloneChatExportProject,
    )(undefined, { projectId: sourceWorkspaceId, destinationPath: exportsDir });
    const exportedPath = asExportedPath(exportResponse);

    const manifestRaw = await readFile(
      path.join(exportedPath, 'cowork-workspace.json'),
      'utf8',
    );
    const manifest: unknown = JSON.parse(manifestRaw);
    expect(manifest).toMatchObject({
      version: 2,
      name: 'Alpha Project',
      color: '#123456',
      cowork: {
        description: 'Test description',
        defaultModel: 'claude-opus-4',
        archiveRetentionDays: 30,
      },
    });

    await expect(
      readFile(path.join(exportedPath, 'home', 'CLAUDE.md'), 'utf8'),
    ).resolves.toBe('# Alpha project instructions');
    await expect(
      readFile(path.join(exportedPath, 'home', 'top-level-file.txt'), 'utf8'),
    ).resolves.toBe('a plain project file');
    await expect(
      readFile(
        path.join(
          getCoworkManagedSubdir(path.join(exportedPath, 'home'), 'notes'),
          'note1.md',
        ),
        'utf8',
      ),
    ).resolves.toBe('# Note one');
    await expect(
      readFile(
        path.join(exportedPath, 'chat-storage-v2', 'home', 'live-index.json'),
        'utf8',
      ),
    ).resolves.toContain('My chat');
    await expect(
      readFile(path.join(exportedPath, 'chats', 'home.json.bak'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        path.join(exportedPath, 'chats', path.basename(orphanedCheckpoint)),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(
        path.join(exportedPath, 'chat-history', 'chat-1', 'meta.json'),
        'utf8',
      ),
    ).resolves.toContain('Archived chat');
    await expect(
      readdir(
        path.join(
          exportedPath,
          'chat-storage-v2',
          COWORK_HOME_WORKTREE_ID,
          'visual-staging',
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    // --- Import ---
    const importResponse = await getHandler(
      IPC_CHANNELS.standaloneChatImportProject,
    )(undefined, { sourcePath: exportedPath });
    const importedProject = asChatProjectData(importResponse);

    expect(importedProject.name).toBe('Alpha Project');
    expect(importedProject.id).not.toBe(sourceWorkspaceId);
    expect(importedProject).toMatchObject({
      color: '#123456',
      description: 'Test description',
      defaultModel: 'claude-opus-4',
      archiveRetentionDays: 30,
    });

    const importedWorkspaceId = importedProject.id;
    const importedHome = getWorkspaceHomeDir(importedWorkspaceId);
    await expect(
      readFile(path.join(importedHome, 'CLAUDE.md'), 'utf8'),
    ).resolves.toBe('# Alpha project instructions');
    await expect(
      readFile(path.join(importedHome, 'top-level-file.txt'), 'utf8'),
    ).resolves.toBe('a plain project file');
    await expect(
      readFile(
        path.join(getCoworkManagedSubdir(importedHome, 'notes'), 'note1.md'),
        'utf8',
      ),
    ).resolves.toBe('# Note one');

    // The restored flat home.json splits into work entries on import: the
    // chat lands in its own per-entry tab file (entry id = chat id), the
    // registry lists it, and the legacy home.json is gone.
    const importedTabsRaw = await readFile(
      path.join(
        getWorkspaceDir(importedWorkspaceId),
        'chat-storage-v2',
        'tab-1',
        'live-index.json',
      ),
      'utf8',
    );
    expect(importedTabsRaw).toContain('My chat');
    expect(importedTabsRaw).not.toContain('approvalMode');
    expect(importedTabsRaw).not.toContain('sessionApprovalRules');
    const importedArchivesRaw = await readFile(
      path.join(
        getWorkspaceDir(importedWorkspaceId),
        'chat-storage-v2',
        'entry-1',
        'archive-index.json',
      ),
      'utf8',
    );
    expect(importedArchivesRaw).toContain('archived-tab-1');
    expect(importedArchivesRaw).not.toContain('approvalMode');
    expect(importedArchivesRaw).not.toContain('sessionApprovalRules');
    const importedWorkEntriesRaw = await readFile(
      getWorkspaceWorkEntriesFilePath(importedWorkspaceId),
      'utf8',
    );
    expect(JSON.parse(importedWorkEntriesRaw)).toMatchObject({
      version: 1,
      entries: [expect.objectContaining({ id: 'tab-1' })],
    });
    await expect(
      readFile(
        getWorkspaceChatTabsFilePath(
          importedWorkspaceId,
          COWORK_HOME_WORKTREE_ID,
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const importedHistoryChatDir = getWorkspaceChatHistoryDir(
      importedWorkspaceId,
      'chat-1',
    );
    await expect(
      readFile(path.join(importedHistoryChatDir, 'meta.json'), 'utf8'),
    ).resolves.toContain('Archived chat');
    await expect(
      readFile(path.join(importedHistoryChatDir, 'summary.md'), 'utf8'),
    ).resolves.toBe('Archived chat summary');
    const importedHistoryConversationRaw = await readFile(
      path.join(
        importedHistoryChatDir,
        'chat-storage-v2',
        'chat-1',
        'archive-index.json',
      ),
      'utf8',
    );
    expect(importedHistoryConversationRaw).not.toContain('approvalMode');
    expect(importedHistoryConversationRaw).not.toContain(
      'sessionApprovalRules',
    );
  });

  it('flushes every canonical chat scope before copying an export', async () => {
    const created = await createCoworkWorkspace(
      'Checkpoint Project',
      '2026-01-01T00:00:00.000Z',
    );
    await writeTextFile(
      getWorkspaceWorkEntriesFilePath(created.id),
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'entry-a', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'entry-b', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    );

    await getHandler(IPC_CHANNELS.standaloneChatExportProject)(undefined, {
      projectId: created.id,
      destinationPath: exportsDir,
    });

    expect(flushScopeMock.mock.calls).toEqual(
      expect.arrayContaining([
        [created.id, COWORK_HOME_WORKTREE_ID],
        [created.id, 'entry-a'],
        [created.id, 'entry-b'],
      ]),
    );
  });

  it('keeps copied history out of the live archive when sanitization fails', async () => {
    const bundleDir = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-cowork-import-sanitize-failure-'),
    );
    try {
      await writeTextFile(
        path.join(bundleDir, 'cowork-workspace.json'),
        JSON.stringify({ version: 1, name: 'Rejected history import' }),
      );
      await writeTextFile(
        path.join(bundleDir, 'chat-history', 'a-corrupt', 'conversation.json'),
        '{not valid json',
      );
      await writeTextFile(
        path.join(bundleDir, 'chat-history', 'z-unsafe', 'conversation.json'),
        JSON.stringify({
          version: 1,
          projectId: 'source-project',
          chatId: 'z-unsafe',
          archivedAt: '2026-01-03T00:00:00.000Z',
          tab: {
            id: 'z-unsafe',
            title: 'Unsafe archive',
            createdAt: '2026-01-03T00:00:00.000Z',
            messages: [],
            approvalMode: 'full-access',
          },
        }),
      );

      await expect(
        getHandler(IPC_CHANNELS.standaloneChatImportProject)(undefined, {
          sourcePath: bundleDir,
        }),
      ).rejects.toThrow();

      const rejected = (await listCoworkWorkspacesAsChatProjects()).find(
        (project) => project.name === 'Rejected history import',
      );
      expect(rejected).toBeDefined();
      if (!rejected) throw new Error('Rejected workspace was not registered');
      await expect(
        readFile(
          path.join(
            getWorkspaceDir(rejected.id),
            'chat-history',
            'z-unsafe',
            'conversation.json',
          ),
          'utf8',
        ),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
    }
  });

  it('imports a legacy pre-cowork bundle (project.json + workspace/*) as a new cowork workspace', async () => {
    const legacyBundleDir = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-legacy-bundle-'),
    );
    try {
      await writeTextFile(
        path.join(legacyBundleDir, 'project.json'),
        JSON.stringify({
          version: 1,
          id: 'legacy-project',
          name: 'Legacy Project',
          createdAt: '2025-06-01T00:00:00.000Z',
          color: '#abcdef',
          description: 'A legacy project',
          settings: { searchIndexingEnabled: false, archiveRetentionDays: 14 },
        }),
      );
      await writeTextFile(
        path.join(legacyBundleDir, 'chat-tabs.json'),
        JSON.stringify({ version: 1, tabs: [], activeTabId: '' }),
      );
      await writeTextFile(
        path.join(legacyBundleDir, 'workspace', 'notes', 'legacy-note.md'),
        '# Legacy note',
      );
      await writeTextFile(
        path.join(legacyBundleDir, 'history', 'chat-9', 'meta.json'),
        JSON.stringify({
          version: 1,
          id: 'chat-9',
          title: 'Legacy archived chat',
          description: 'legacy',
          createdAt: '2025-06-02T00:00:00.000Z',
        }),
      );

      const importResponse = await getHandler(
        IPC_CHANNELS.standaloneChatImportProject,
      )(undefined, { sourcePath: legacyBundleDir });
      const importedProject = asChatProjectData(importResponse);

      expect(importedProject.name).toBe('Legacy Project');
      // The legacy bundle's `settings.searchIndexingEnabled` key is ignored
      // (search was removed); `archiveRetentionDays` still round-trips.
      expect(importedProject).toMatchObject({
        color: '#abcdef',
        description: 'A legacy project',
        archiveRetentionDays: 14,
      });

      const importedHome = getWorkspaceHomeDir(importedProject.id);
      await expect(
        readFile(
          path.join(
            getCoworkManagedSubdir(importedHome, 'notes'),
            'legacy-note.md',
          ),
          'utf8',
        ),
      ).resolves.toBe('# Legacy note');
      await expect(
        readFile(
          path.join(
            getWorkspaceChatHistoryDir(importedProject.id, 'chat-9'),
            'meta.json',
          ),
          'utf8',
        ),
      ).resolves.toContain('Legacy archived chat');
    } finally {
      await rm(legacyBundleDir, { recursive: true, force: true });
    }
  });

  it('rejects malformed chat imports and preserves their original input', async () => {
    const created = await createCoworkWorkspace(
      'Malformed Chat Bundle',
      '2026-01-01T00:00:00.000Z',
    );
    const exportResponse = await getHandler(
      IPC_CHANNELS.standaloneChatExportProject,
    )(undefined, { projectId: created.id, destinationPath: exportsDir });
    const exportedPath = asExportedPath(exportResponse);
    const malformed = '{not-json';

    await writeTextFile(
      path.join(exportedPath, 'chats', 'malformed.json'),
      malformed,
    );
    await writeTextFile(
      path.join(exportedPath, 'chat-archives', 'malformed.json'),
      malformed,
    );
    await writeTextFile(
      path.join(exportedPath, 'chat-history', 'malformed', 'conversation.json'),
      malformed,
    );

    await expect(
      getHandler(IPC_CHANNELS.standaloneChatImportProject)(undefined, {
        sourcePath: exportedPath,
      }),
    ).rejects.toThrow();
    for (const relative of [
      'chats/malformed.json',
      'chat-archives/malformed.json',
      'chat-history/malformed/conversation.json',
    ]) {
      expect(await readFile(path.join(exportedPath, relative), 'utf8')).toBe(
        malformed,
      );
    }
    // Guards the isolation in beforeEach: this rejection records a storage
    // diagnostic, which must reach the injected sink, not the process
    // observability service writing under the temp data dir.
    expect(recordDiagnostic).toHaveBeenCalled();
  });

  it('rejects symlinks in imported per-entry chat trees', async () => {
    const bundleDir = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-symlink-bundle-'),
    );
    const outsideFile = path.join(bundleDir, '..', 'outside-chat.json');
    try {
      await writeTextFile(
        path.join(bundleDir, 'cowork-workspace.json'),
        JSON.stringify({ version: 1, name: 'Unsafe bundle' }),
      );
      await writeTextFile(outsideFile, '{}');
      await mkdir(path.join(bundleDir, 'chats'), { recursive: true });
      await symlink(outsideFile, path.join(bundleDir, 'chats', 'entry-1.json'));
      await writeTextFile(
        path.join(bundleDir, 'work-entries.json'),
        JSON.stringify({ version: 1, entries: [] }),
      );

      await expect(
        getHandler(IPC_CHANNELS.standaloneChatImportProject)(undefined, {
          sourcePath: bundleDir,
        }),
      ).rejects.toThrow('cannot contain symlinks');
    } finally {
      await rm(bundleDir, { recursive: true, force: true });
      await rm(outsideFile, { force: true });
    }
  });

  it('serializes project import behind an in-flight template install', async () => {
    const bundleDir = path.join(exportsDir, 'imported-project-bundle');
    await writeTextFile(
      path.join(bundleDir, 'cowork-workspace.json'),
      JSON.stringify({ version: 1, name: 'Imported project' }),
    );

    let releaseTemplateScaffold!: () => void;
    let markTemplateScaffoldStarted!: () => void;
    let markImportScaffoldStarted!: () => void;
    const templateScaffoldGate = new Promise<void>((resolve) => {
      releaseTemplateScaffold = resolve;
    });
    const templateScaffoldStarted = new Promise<void>((resolve) => {
      markTemplateScaffoldStarted = resolve;
    });
    const importScaffoldStarted = new Promise<void>((resolve) => {
      markImportScaffoldStarted = resolve;
    });
    const ensureCoworkHomeScaffold = chatProjectUtils.ensureCoworkHomeScaffold;
    const scaffoldSpy = jest
      .spyOn(chatProjectUtils, 'ensureCoworkHomeScaffold')
      .mockImplementation(async (workspaceId) => {
        if (workspaceId === 'template-project') {
          markTemplateScaffoldStarted();
          await templateScaffoldGate;
        }
        if (workspaceId === 'imported-project') {
          markImportScaffoldStarted();
        }
        await ensureCoworkHomeScaffold(workspaceId);
      });

    try {
      const install = getHandler(IPC_CHANNELS.chatProjectCreateFromTemplate)(
        undefined,
        {
          template: {
            version: 1,
            name: 'Template project',
            description: '',
            instructions: '',
            plugins: [],
            customSkills: [],
          },
          sourceTemplate: {
            externalId: '4f4f51c1-a72b-4e12-9320-a038b90189f0',
            contentHash: 'c'.repeat(64),
          },
        },
      );
      await templateScaffoldStarted;

      const imported = getHandler(IPC_CHANNELS.standaloneChatImportProject)(
        undefined,
        { sourcePath: bundleDir },
      );
      const importStartedBeforeInstallCompleted = await Promise.race([
        importScaffoldStarted.then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), 100);
        }),
      ]);
      releaseTemplateScaffold();
      await Promise.all([install, imported]);

      expect(importStartedBeforeInstallCompleted).toBe(false);
      expect(
        (await readAllSidebarItems()).items
          .filter((item) => item.type === 'cowork')
          .map((item) => item.id),
      ).toEqual(
        expect.arrayContaining(['template-project', 'imported-project']),
      );
    } finally {
      releaseTemplateScaffold();
      scaffoldSpy.mockRestore();
    }
  });
});
