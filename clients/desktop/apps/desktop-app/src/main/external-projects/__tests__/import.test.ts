import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type ExternalProjectCandidate,
  type ExternalProjectImportProgressEvent,
  type PersistedChatTab,
  type SidebarItem,
} from '@canopy/desktop-shared/types';

jest.mock('electron', () => ({}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  withBrowserTaskOwnerRemoval: (
    _projectId: string,
    _worktreeId: string,
    removeOwner: () => Promise<unknown>,
  ): Promise<unknown> => removeOwner(),
}));
jest.mock('../discovery', () => ({
  getCachedExternalProjectScan: jest.fn(),
}));
jest.mock('../ledger', () => ({
  readExternalProjectImportLedger: jest.fn(),
  recordExternalProjectChatDestination: jest.fn(),
  recordExternalProjectImport: jest.fn(),
  recordExternalProjectSessionImports: jest.fn(),
  removeExternalProjectImport: jest.fn(),
}));
jest.mock('../chat-projection', () => ({
  MAX_IMPORT_TRANSCRIPT_BYTES: 48 * 1024 * 1024,
  TranscriptTooLargeError: class TranscriptTooLargeError extends Error {},
  projectClaudeTranscriptFile: jest.fn(),
  projectCodexRolloutFile: jest.fn(),
}));
jest.mock('../../lib/workspace-service', () => ({
  assertFolderIsImportable: jest.fn(),
  registerSingleRepoWorkspaceWithoutManifest: jest.fn(),
}));
jest.mock('../../lib/cowork-workspace-crud', () => ({
  createExternalCoworkWorkspace: jest.fn(),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
  sendToWindow: jest.fn(),
}));
jest.mock('../../lib/worktree-service', () => ({
  archiveSingleRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(),
}));
jest.mock('../../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(),
}));
jest.mock('../../lib/paths', () => ({
  getWorktreeAttachmentsDir: (projectId: string, worktreeId: string): string =>
    `/attachments/${projectId}/${worktreeId}`,
}));
jest.mock('../../lib/chat-tab-dispatch-utils', () => ({
  upsertPersistedChatTabs: jest.fn(),
}));
jest.mock('../../lib/project-worktree-runtime', () => ({
  runProjectWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));
jest.mock('../../lib/cowork-work-entries', () => ({
  createWorkEntry: jest.fn(),
  listWorkEntryIds: jest.fn(),
  removeWorkEntryRow: jest.fn(),
}));
jest.mock('../../codex/reconstruction-seed-store', () => ({
  publishCodexReconstructionSeed: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/node/codex-runtime', () => ({
  ...jest.requireActual<object>('@canopy/desktop-shared/node/codex-runtime'),
  readCodexRolloutSeedItems: jest.fn(),
}));
jest.mock('../../lib/claude-project-paths', () => ({
  claudeProjectDirCandidates: jest.fn(),
  getClaudeCodeProjectsDir: jest.fn(),
}));
jest.mock('../../services/chat-state-service', () => ({
  getChatStateService: (): { flushScope: jest.Mock } => ({
    flushScope: jest.fn().mockResolvedValue(undefined),
  }),
}));

import { readCodexRolloutSeedItems } from '@canopy/desktop-shared/node/codex-runtime';
import { publishCodexReconstructionSeed } from '../../codex/reconstruction-seed-store';
import { upsertPersistedChatTabs } from '../../lib/chat-tab-dispatch-utils';
import {
  claudeProjectDirCandidates,
  getClaudeCodeProjectsDir,
} from '../../lib/claude-project-paths';
import {
  createWorkEntry,
  listWorkEntryIds,
  removeWorkEntryRow,
} from '../../lib/cowork-work-entries';
import { realpathSync } from 'node:fs';
import { createExternalCoworkWorkspace } from '../../lib/cowork-workspace-crud';
import { resolveWorktreeCwd } from '../../lib/resolve-worktree';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { sendToAllWindows, sendToWindow } from '../../lib/window-send';
import {
  assertFolderIsImportable,
  registerSingleRepoWorkspaceWithoutManifest,
} from '../../lib/workspace-service';
import {
  projectClaudeTranscriptFile,
  projectCodexRolloutFile,
  TranscriptTooLargeError,
} from '../chat-projection';
import { getCachedExternalProjectScan } from '../discovery';
import { importExternalProjects } from '../import';
import {
  readExternalProjectImportLedger,
  recordExternalProjectChatDestination,
  recordExternalProjectImport,
  recordExternalProjectSessionImports,
  removeExternalProjectImport,
} from '../ledger';
import type { DiscoveredSession } from '../types';

const mocked = {
  scan: jest.mocked(getCachedExternalProjectScan),
  ledger: jest.mocked(readExternalProjectImportLedger),
  recordProject: jest.mocked(recordExternalProjectImport),
  recordSessions: jest.mocked(recordExternalProjectSessionImports),
  recordDestination: jest.mocked(recordExternalProjectChatDestination),
  removeProject: jest.mocked(removeExternalProjectImport),
  registerRepo: jest.mocked(registerSingleRepoWorkspaceWithoutManifest),
  assertImportable: jest.mocked(assertFolderIsImportable),
  createCowork: jest.mocked(createExternalCoworkWorkspace),
  sidebar: jest.mocked(readAllSidebarItems),
  broadcast: jest.mocked(sendToAllWindows),
  send: jest.mocked(sendToWindow),
  upsertTabs: jest.mocked(upsertPersistedChatTabs),
  createWorkEntry: jest.mocked(createWorkEntry),
  removeWorkEntry: jest.mocked(removeWorkEntryRow),
  listEntryIds: jest.mocked(listWorkEntryIds),
  cwd: jest.mocked(resolveWorktreeCwd),
  projectClaude: jest.mocked(projectClaudeTranscriptFile),
  projectCodex: jest.mocked(projectCodexRolloutFile),
  seedItems: jest.mocked(readCodexRolloutSeedItems),
  publishSeed: jest.mocked(publishCodexReconstructionSeed),
  slugCandidates: jest.mocked(claudeProjectDirCandidates),
  projectsDir: jest.mocked(getClaudeCodeProjectsDir),
};

function candidate(
  overrides: Partial<ExternalProjectCandidate> = {},
): ExternalProjectCandidate {
  return {
    id: 'ext-abc',
    providers: ['claude'],
    surfaces: ['claude-code'],
    displayName: 'notes',
    rootPath: '/nonexistent/notes',
    kind: 'folder',
    status: 'available',
    linkedWorktreePaths: [],
    lastActivityAt: null,
    sessions: [],
    sessionCount: 0,
    importableSessionCount: 0,
    ...overrides,
  };
}

function session(
  id: string,
  extra: Partial<DiscoveredSession> = {},
): DiscoveredSession {
  return {
    id,
    provider: 'claude',
    surface: 'claude-code',
    kind: 'claude-jsonl',
    cwd: '/x',
    sourcePath: `/x/${id}.jsonl`,
    title: `Title ${id}`,
    startedAt: '2026-09-01T00:00:00.000Z',
    lastActivityAt: '2026-09-02T00:00:00.000Z',
    sizeBytes: 1,
    native: true,
    ...extra,
  };
}

function coworkItem(id: string, externalPath: string): SidebarItem {
  return {
    id,
    name: id,
    type: 'cowork',
    color: '#000',
    collapsed: false,
    order: 0,
    externalPath,
    cowork: { createdAt: '2026-09-01T00:00:00.000Z', archiveRetentionDays: 7 },
  };
}

function sessionImportedBroadcasts(): unknown[][] {
  return mocked.broadcast.mock.calls.filter(
    ([channel]) => channel === IPC_CHANNELS.chatSessionImported,
  );
}

describe('importExternalProjects', () => {
  let root: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'external-import-'));
    mocked.ledger.mockResolvedValue({
      imports: {},
      lastScanAt: null,
      inviteShownAt: null,
    });
    mocked.recordProject.mockResolvedValue({
      imports: {},
      lastScanAt: null,
      inviteShownAt: null,
    });
    mocked.recordSessions.mockResolvedValue({
      imports: {},
      lastScanAt: null,
      inviteShownAt: null,
    });
    mocked.recordDestination.mockResolvedValue({
      imports: {},
      lastScanAt: null,
      inviteShownAt: null,
    });
    mocked.removeProject.mockResolvedValue({
      imports: {},
      lastScanAt: null,
      inviteShownAt: null,
    });
    mocked.sidebar.mockResolvedValue({ items: [] });
    mocked.assertImportable.mockResolvedValue(undefined);
    mocked.upsertTabs.mockResolvedValue(undefined);
    mocked.projectsDir.mockReturnValue(join(root, 'claude-projects'));
    mocked.slugCandidates.mockResolvedValue(['-dest']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function cacheScan(
    candidates: ExternalProjectCandidate[],
    sessions: Record<string, DiscoveredSession[]> = {},
  ): void {
    mocked.scan.mockReturnValue({
      scanId: 'scan-1',
      scannedAt: '2026-09-10T00:00:00.000Z',
      candidates,
      sessionsByCandidate: new Map(Object.entries(sessions)),
    });
  }

  it('rejects an import whose scan is no longer cached', async () => {
    mocked.scan.mockReturnValue(null);
    await expect(
      importExternalProjects({
        scanId: 'gone',
        selections: [{ candidateId: 'x', importChats: false }],
      }),
    ).rejects.toThrow(/Scan again/);
  });

  it('skips unavailable candidates and fails missing folders without registering anything', async () => {
    cacheScan([
      candidate({
        id: 'ext-un',
        status: 'unavailable',
        statusReason: 'Contains your project "X"',
      }),
      candidate({ id: 'ext-gone', rootPath: join(root, 'missing') }),
    ]);
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [
        { candidateId: 'ext-un', importChats: true },
        { candidateId: 'ext-gone', importChats: true },
        { candidateId: 'ext-not-in-scan', importChats: false },
      ],
    });
    expect(results.map((result) => result.status)).toEqual([
      'skipped',
      'failed',
      'failed',
    ]);
    expect(results[0]?.message).toBe('Contains your project "X"');
    expect(results[1]?.retryable).toBe(true);
    expect(results[2]?.message).toMatch(/not part of the current scan/);
    expect(mocked.createCowork).not.toHaveBeenCalled();
    expect(mocked.registerRepo).not.toHaveBeenCalled();
    expect(mocked.recordProject).not.toHaveBeenCalled();
  });

  it('registers a folder as a Cowork project and ledgers it even without chats', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan([candidate({ rootPath: folder })]);
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: false }],
    });
    expect(results[0]).toMatchObject({
      status: 'imported',
      workspaceId: 'notes',
      workspaceType: 'cowork',
      chatsImported: 0,
    });
    // The root is re-resolved at import time, not trusted from the scan.
    expect(mocked.assertImportable).toHaveBeenCalledWith(
      realpathSync(folder),
      [],
    );
    expect(mocked.createCowork).toHaveBeenCalledWith(
      realpathSync(folder),
      'notes',
    );
    expect(mocked.recordProject).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: 'ext-abc', workspaceId: 'notes' }),
    );
    expect(mocked.recordSessions).not.toHaveBeenCalled();
    const phases = mocked.broadcast.mock.calls.map(
      ([, event]) => (event as ExternalProjectImportProgressEvent).phase,
    );
    expect(phases).toEqual(['project', 'done']);
  });

  it('refuses chats for an already-tracked multi-repo project without writing the ledger', async () => {
    const repo = join(root, 'multi');
    await mkdir(repo);
    cacheScan(
      [
        candidate({
          rootPath: repo,
          kind: 'git',
          status: 'already-tracked',
          trackedWorkspaceId: 'multi',
          statusReason: 'Already in your projects as "multi"',
          importableSessionCount: 1,
        }),
      ],
      { 'ext-abc': [session('s1')] },
    );
    mocked.sidebar.mockResolvedValue({
      items: [
        {
          id: 'multi',
          name: 'multi',
          type: 'multi-repo',
          color: '#000',
          collapsed: false,
          order: 0,
          repos: [],
          worktrees: [],
        },
      ],
    });
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    });
    expect(results[0]).toMatchObject({ status: 'skipped', chatsSkipped: 1 });
    expect(results[0]?.message).toContain('multi-repo');
    expect(mocked.recordProject).not.toHaveBeenCalled();
    expect(mocked.upsertTabs).not.toHaveBeenCalled();
  });

  it('imports chats with one tabs write, ledgers sessions, and reports read-only fallbacks', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    const claudeSource = join(root, 'claude.jsonl');
    await writeFile(claudeSource, '{}\n');
    const codexSource = join(root, 'rollout.jsonl');
    await writeFile(codexSource, '{}\n');
    const sessions = [
      session('claude-1', {
        sourcePath: claudeSource,
        lastActivityAt: '2026-09-03T00:00:00.000Z',
      }),
      session('codex-1', {
        provider: 'codex',
        surface: 'codex-cli',
        kind: 'codex-rollout',
        sourcePath: codexSource,
      }),
      session('sdk', { native: false }),
      session('empty', { sourcePath: join(root, 'empty.jsonl'), title: null }),
    ];
    cacheScan(
      [
        candidate({
          rootPath: folder,
          providers: ['claude', 'codex'],
          importableSessionCount: 3,
        }),
      ],
      { 'ext-abc': sessions },
    );
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-1', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    const message = {
      id: 'm1',
      role: 'user' as const,
      timestamp: 1,
      blocks: [],
    };
    mocked.projectClaude.mockImplementation((path) =>
      Promise.resolve(
        path === claudeSource
          ? {
              messages: [message],
              title: 'Projected',
              firstTimestamp: 1,
              warnings: [],
            }
          : { messages: [], title: null, firstTimestamp: null, warnings: [] },
      ),
    );
    mocked.projectCodex.mockResolvedValue({
      messages: [message],
      title: 'Codex',
      firstTimestamp: 2,
      warnings: [],
    });
    // The Codex rollout yields no seed items, so that chat becomes read-only.
    mocked.seedItems.mockResolvedValue([]);

    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    });

    expect(mocked.upsertTabs).toHaveBeenCalledTimes(1);
    const [batch] = mocked.upsertTabs.mock.calls[0] ?? [];
    const tabs: PersistedChatTab[] = batch?.tabs ?? [];
    expect(tabs.map((tab) => tab.title)).toEqual([
      'Title claude-1',
      'Title codex-1',
    ]);
    expect(tabs[0]).toMatchObject({
      sdkSessionId: 'claude-1',
      claudeForkSessionOnNextSend: true,
      providerType: 'claude',
    });
    expect(tabs[1]).toMatchObject({ readOnly: true, providerType: 'codex' });
    expect(batch?.activeTabId).toBe(tabs[0]?.id);
    // The Work Entry takes its name from the chats it holds, so the sidebar
    // never repeats a generic "Imported from …" label; the explicit id still
    // forces a fresh entry instead of adopting an empty one the user has.
    const [, entryOptions] = mocked.createWorkEntry.mock.calls[0] ?? [];
    expect(entryOptions?.id).toEqual(expect.any(String));
    expect(entryOptions?.title).toBeUndefined();
    expect(mocked.publishSeed).not.toHaveBeenCalled();
    expect(mocked.projectClaude).toHaveBeenCalledWith(claudeSource, {
      attachmentsDir: '/attachments/notes/entry-1',
    });

    expect(results[0]).toMatchObject({
      status: 'imported',
      chatsImported: 1,
      chatsReadOnly: 1,
      chatsSkipped: 1,
    });
    expect(mocked.recordProject).toHaveBeenCalledTimes(1);
    expect(mocked.recordSessions).toHaveBeenCalledWith({
      candidateId: 'ext-abc',
      sessions: [
        { sessionId: 'claude-1', chatId: tabs[0]?.id, worktreeId: 'entry-1' },
        { sessionId: 'codex-1', chatId: tabs[1]?.id, worktreeId: 'entry-1' },
      ],
    });
    // One imported-chat broadcast per persisted tab, after the write.
    // A destination this run created is not open anywhere, so no per-tab
    // transcript is broadcast; the renderer hydrates it from disk on open.
    expect(sessionImportedBroadcasts()).toHaveLength(0);
    expect(mocked.recordDestination).toHaveBeenCalledWith({
      candidateId: 'ext-abc',
      worktreeId: 'entry-1',
    });
    const chatPhases = mocked.broadcast.mock.calls
      .map(([, event]) => event as ExternalProjectImportProgressEvent)
      .filter((event) => event.phase === 'chats')
      .map((event) => `${event.chatsCompleted}/${event.chatsTotal}`);
    expect(chatPhases).toEqual(['0/3', '1/3', '2/3', '3/3']);
  });

  it('ledgers an already-tracked project only once chats land in it', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    const source = join(root, 'c.jsonl');
    await writeFile(source, '{}\n');
    cacheScan(
      [
        candidate({
          rootPath: folder,
          status: 'already-tracked',
          trackedWorkspaceId: 'notes',
          importableSessionCount: 1,
        }),
      ],
      { 'ext-abc': [session('s1', { sourcePath: source })] },
    );
    mocked.sidebar.mockResolvedValue({ items: [coworkItem('notes', folder)] });
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-2', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    mocked.projectClaude.mockResolvedValue({
      messages: [{ id: 'm', role: 'user', timestamp: 1, blocks: [] }],
      title: 't',
      firstTimestamp: 1,
      warnings: [],
    });
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    });
    expect(results[0]).toMatchObject({ status: 'imported', chatsImported: 1 });
    expect(mocked.createCowork).not.toHaveBeenCalled();
    expect(mocked.recordProject).toHaveBeenCalledTimes(1);
    // The provisional entry existed before the destination was named, so the
    // record is real for a tracked project too, and nothing dropped it.
    expect(mocked.recordProject.mock.invocationCallOrder[0]).toBeLessThan(
      mocked.recordDestination.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocked.recordDestination).toHaveBeenCalledWith({
      candidateId: 'ext-abc',
      worktreeId: 'entry-2',
    });
    expect(mocked.recordSessions).toHaveBeenCalledTimes(1);
    expect(mocked.removeProject).not.toHaveBeenCalled();
  });

  it('drops the provisional entry of a tracked project when no chat lands', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan(
      [
        candidate({
          rootPath: folder,
          status: 'already-tracked',
          trackedWorkspaceId: 'notes',
          importableSessionCount: 1,
        }),
      ],
      { 'ext-abc': [session('s1')] },
    );
    mocked.sidebar.mockResolvedValue({ items: [coworkItem('notes', folder)] });
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-2', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    mocked.projectClaude.mockRejectedValue(new Error('unreadable'));
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    });
    expect(results[0]).toMatchObject({ status: 'skipped', chatsSkipped: 1 });
    expect(mocked.recordProject).toHaveBeenCalledTimes(1);
    expect(mocked.removeProject).toHaveBeenCalledWith('ext-abc');
    expect(mocked.removeWorkEntry).toHaveBeenCalledWith('notes', 'entry-2');
  });

  it('rolls back an empty chat destination when every session fails to project', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan([candidate({ rootPath: folder, importableSessionCount: 1 })], {
      'ext-abc': [session('s1')],
    });
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-3', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    mocked.projectClaude.mockRejectedValue(new Error('unreadable'));
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    });
    expect(results[0]).toMatchObject({
      status: 'imported',
      chatsImported: 0,
      chatsSkipped: 1,
      retryable: true,
    });
    expect(mocked.upsertTabs).not.toHaveBeenCalled();
    expect(mocked.removeWorkEntry).toHaveBeenCalledWith('notes', 'entry-3');
    expect(mocked.recordSessions).not.toHaveBeenCalled();
  });

  it('reuses the project and destination a retry already registered', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan([candidate({ rootPath: folder, importableSessionCount: 2 })], {
      'ext-abc': [session('s1'), session('s2')],
    });
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-1', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    const message = { id: 'm', role: 'user', timestamp: 1, blocks: [] };
    mocked.projectClaude.mockImplementation((filePath: string) =>
      filePath.endsWith('s1.jsonl')
        ? Promise.reject(new Error('read failed'))
        : Promise.resolve({
            messages: [message],
            title: 't',
            firstTimestamp: 1,
            warnings: [],
          }),
    );
    const request = {
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    };
    const first = await importExternalProjects(request);
    expect(first.results[0]).toMatchObject({
      status: 'imported',
      chatsSkipped: 1,
      retryable: true,
    });
    expect(mocked.createCowork).toHaveBeenCalledTimes(1);

    // The retry sees the world the first run left behind: the project is in
    // the sidebar and the ledger names both it and the Work Entry.
    mocked.sidebar.mockResolvedValue({ items: [coworkItem('notes', folder)] });
    mocked.ledger.mockResolvedValue({
      imports: {
        'ext-abc': {
          workspaceId: 'notes',
          rootPath: folder,
          providers: ['claude'],
          importedAt: '2026-09-10T00:00:00.000Z',
          sessions: {
            s2: {
              chatId: 'chat-s2',
              worktreeId: 'entry-1',
              importedAt: '2026-09-10T00:00:01.000Z',
            },
          },
        },
      },
      lastScanAt: null,
      inviteShownAt: null,
    });
    mocked.listEntryIds.mockResolvedValue(['entry-1']);
    mocked.projectClaude.mockResolvedValue({
      messages: [message],
      title: 't',
      firstTimestamp: 1,
      warnings: [],
    });
    const second = await importExternalProjects(request);
    // The fixture has no source transcript to copy, so the chat lands as
    // read-only history; what matters here is that it landed at all.
    expect(second.results[0]).toMatchObject({
      status: 'imported',
      chatsReadOnly: 1,
      chatsSkipped: 0,
      retryable: false,
    });
    // Nothing was registered or created twice, and the retried chat joined
    // the existing Work Entry, which is announced live because it may be open.
    expect(mocked.createCowork).toHaveBeenCalledTimes(1);
    expect(mocked.assertImportable).toHaveBeenCalledTimes(1);
    expect(mocked.createWorkEntry).toHaveBeenCalledTimes(1);
    expect(mocked.upsertTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ projectId: 'notes', worktreeId: 'entry-1' }),
    );
    expect(sessionImportedBroadcasts()).toHaveLength(1);
    expect(mocked.removeWorkEntry).not.toHaveBeenCalled();
  });

  it('names an untitled chat after its source and start time', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan([candidate({ rootPath: folder, importableSessionCount: 2 })], {
      'ext-abc': [
        session('s1', { title: null, startedAt: '2026-09-01T12:00:00.000Z' }),
        session('s2', {
          provider: 'codex',
          surface: 'codex-cli',
          kind: 'codex-rollout',
          title: null,
          startedAt: null,
        }),
      ],
    });
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-1', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    const message = {
      id: 'm',
      role: 'user' as const,
      timestamp: 1,
      blocks: [],
    };
    mocked.projectClaude.mockResolvedValue({
      messages: [message],
      title: null,
      firstTimestamp: null,
      warnings: [],
    });
    mocked.projectCodex.mockResolvedValue({
      messages: [message],
      title: null,
      firstTimestamp: null,
      warnings: [],
    });
    mocked.seedItems.mockResolvedValue([]);
    await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    });
    const [batch] = mocked.upsertTabs.mock.calls[0] ?? [];
    const titles = (batch?.tabs ?? []).map((tab) => tab.title);
    // Source plus start time, never a bare "Imported chat" that would
    // repeat across every untitled import. Rendered with the same system
    // locale and timezone the import uses, so the assertion states the rule
    // rather than one machine's rendering.
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(Date.parse('2026-09-01T12:00:00.000Z'));
    expect(titles[0]).toBe(`Claude chat from ${expected}`);
    // Without a start time the session id is the only distinct handle.
    expect(titles[1]).toBe('Codex chat s2');
  });

  it('falls back to the session id when the source timestamp is out of range', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan([candidate({ rootPath: folder, importableSessionCount: 1 })], {
      'ext-abc': [session('s1', { title: null, startedAt: null })],
    });
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-1', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    mocked.projectClaude.mockResolvedValue({
      messages: [{ id: 'm', role: 'user', timestamp: 1, blocks: [] }],
      title: null,
      // Finite, but past what `Date` can render.
      firstTimestamp: 1e16,
      warnings: [],
    });
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    });
    expect(results[0]).toMatchObject({ status: 'imported', chatsSkipped: 0 });
    const [batch] = mocked.upsertTabs.mock.calls[0] ?? [];
    expect(batch?.tabs[0]?.title).toBe('Claude chat s1');
    expect(Number.isFinite(Date.parse(batch?.tabs[0]?.createdAt ?? ''))).toBe(
      true,
    );
  });

  it('does not offer a retry for skips a second attempt cannot change', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan([candidate({ rootPath: folder, importableSessionCount: 2 })], {
      'ext-abc': [
        session('big'),
        session('empty'),
        session('giant', { sizeBytes: 60 * 1024 * 1024 }),
      ],
    });
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-2', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    mocked.projectClaude.mockImplementation((filePath: string) =>
      filePath.endsWith('big.jsonl')
        ? Promise.reject(new TranscriptTooLargeError(1, 1))
        : Promise.resolve({
            messages: [],
            title: null,
            firstTimestamp: null,
            warnings: [],
          }),
    );
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    });
    expect(results[0]).toMatchObject({
      status: 'imported',
      chatsSkipped: 3,
      retryable: false,
    });
    expect(results[0]?.message).toMatch(/no messages to import/);
    // The oversized session was decided from its size, never read.
    expect(mocked.projectClaude).toHaveBeenCalledTimes(2);
  });

  it('reports a ledger write failure on the item instead of failing the batch', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan([candidate({ rootPath: folder })]);
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.recordProject.mockRejectedValue(new Error('disk full'));
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: false }],
    });
    expect(results[0]).toMatchObject({
      status: 'imported',
      workspaceId: 'notes',
    });
    expect(results[0]?.message).toMatch(/import record could not be saved/);
  });

  it('reuses the destination named on the ledger entry when the session write failed', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan([candidate({ rootPath: folder, importableSessionCount: 2 })], {
      'ext-abc': [session('s1'), session('s2')],
    });
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-9', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    const message = { id: 'm', role: 'user', timestamp: 1, blocks: [] };
    mocked.projectClaude.mockImplementation((filePath: string) =>
      filePath.endsWith('s1.jsonl')
        ? Promise.reject(new Error('read failed'))
        : Promise.resolve({
            messages: [message],
            title: 't',
            firstTimestamp: 1,
            warnings: [],
          }),
    );
    mocked.recordSessions.mockRejectedValueOnce(new Error('disk full'));
    const request = {
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    };
    const first = await importExternalProjects(request);
    expect(first.results[0]).toMatchObject({
      status: 'imported',
      retryable: true,
    });
    expect(first.results[0]?.message).toMatch(
      /chat import record could not be saved/,
    );

    // No session record survived, but the entry-level destination did.
    mocked.sidebar.mockResolvedValue({ items: [coworkItem('notes', folder)] });
    mocked.ledger.mockResolvedValue({
      imports: {
        'ext-abc': {
          workspaceId: 'notes',
          rootPath: folder,
          providers: ['claude'],
          importedAt: '2026-09-10T00:00:00.000Z',
          chatWorktreeId: 'entry-9',
          sessions: {},
        },
      },
      lastScanAt: null,
      inviteShownAt: null,
    });
    mocked.listEntryIds.mockResolvedValue(['entry-9']);
    mocked.projectClaude.mockResolvedValue({
      messages: [message],
      title: 't',
      firstTimestamp: 1,
      warnings: [],
    });
    const second = await importExternalProjects(request);
    expect(second.results[0]?.status).toBe('imported');
    expect(mocked.createWorkEntry).toHaveBeenCalledTimes(1);
    expect(mocked.upsertTabs).toHaveBeenLastCalledWith(
      expect.objectContaining({ worktreeId: 'entry-9' }),
    );
    // The reused scope keeps its own active tab.
    expect(mocked.upsertTabs.mock.calls[1]?.[0]).not.toHaveProperty(
      'activeTabId',
    );
  });

  it('stops admitting chats past the per-scope byte budget and offers a retry', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    const huge = 40 * 1024 * 1024;
    cacheScan([candidate({ rootPath: folder, importableSessionCount: 4 })], {
      'ext-abc': [
        session('a', {
          sizeBytes: huge,
          lastActivityAt: '2026-09-04T00:00:00.000Z',
        }),
        session('b', {
          sizeBytes: huge,
          lastActivityAt: '2026-09-03T00:00:00.000Z',
        }),
        session('c', {
          sizeBytes: huge,
          lastActivityAt: '2026-09-02T00:00:00.000Z',
        }),
        session('d', {
          sizeBytes: huge,
          lastActivityAt: '2026-09-01T00:00:00.000Z',
        }),
      ],
    });
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-1', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    mocked.projectClaude.mockResolvedValue({
      messages: [{ id: 'm', role: 'user', timestamp: 1, blocks: [] }],
      title: 't',
      firstTimestamp: 1,
      warnings: [],
    });
    const { results } = await importExternalProjects({
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    });
    expect(results[0]).toMatchObject({
      status: 'imported',
      chatsSkipped: 1,
      retryable: true,
    });
    expect(results[0]?.message).toMatch(
      /left out to keep this import under 128 MB/,
    );
    expect(mocked.projectClaude).toHaveBeenCalledTimes(3);
  });

  it('queues an overlapping run for the same candidate behind the first', async () => {
    const folder = join(root, 'notes');
    await mkdir(folder);
    cacheScan([candidate({ rootPath: folder, importableSessionCount: 1 })], {
      'ext-abc': [session('s1')],
    });
    mocked.createCowork.mockResolvedValue(coworkItem('notes', folder));
    mocked.createWorkEntry.mockResolvedValue({
      entry: { id: 'entry-1', title: 'Imported', createdAt: 'x', chatCount: 0 },
      reusedExistingEmpty: false,
    });
    mocked.cwd.mockReturnValue(folder);
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const message = { id: 'm', role: 'user', timestamp: 1, blocks: [] };
    // The first run parks inside projection; the second must not start.
    mocked.projectClaude.mockImplementationOnce(() =>
      gate.then(() => ({
        messages: [message],
        title: 't',
        firstTimestamp: 1,
        warnings: [],
      })),
    );
    mocked.projectClaude.mockResolvedValue({
      messages: [message],
      title: 't',
      firstTimestamp: 1,
      warnings: [],
    });
    const request = {
      scanId: 'scan-1',
      selections: [{ candidateId: 'ext-abc', importChats: true }],
    };
    const first = importExternalProjects(request);
    const second = importExternalProjects(request);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Only the first run has registered anything so far.
    expect(mocked.createCowork).toHaveBeenCalledTimes(1);
    expect(mocked.createWorkEntry).toHaveBeenCalledTimes(1);
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a.results[0]?.status).toBe('imported');
    expect(b.results[0]?.status).toBe('imported');
    // The second run only ran after the first completed.
    expect(
      mocked.createCowork.mock.invocationCallOrder[1] ?? 0,
    ).toBeGreaterThan(mocked.recordSessions.mock.invocationCallOrder[0] ?? 0);
  });
});
