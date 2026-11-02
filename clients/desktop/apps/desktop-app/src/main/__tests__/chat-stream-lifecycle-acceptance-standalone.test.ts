import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';

jest.mock('electron', () => ({ dialog: { showOpenDialog: jest.fn() } }));
jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
  sendToWindow: jest.fn(),
}));
jest.mock('../agents/utils', () => ({ generateChatSummary: jest.fn() }));
jest.mock('../plugins/workspace-template-import', () => ({
  resolveDesktopWorkspaceTemplate: jest.fn(() =>
    Promise.resolve({
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      unresolvedRefs: [],
    }),
  ),
}));

import { registerStandaloneChatHandlers } from '../ipc/standalone-chat';
import { registerIpcHandler } from '../ipc/register';
import * as workspaceCrud from '../lib/cowork-workspace-crud';
import {
  getWorkspaceDir,
  getWorkspaceChatTabsFilePath,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceChatJournalFilePath,
  getWorkspaceChatHistoryConversationFilePath,
} from '../lib/paths';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import {
  ChatStateService,
  resetChatStateServiceForTests,
} from '../services/chat-state-service';
import { StreamClosureCopyRefusalError } from '../lib/chat-delta-journal/stream-closure-copy';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import {
  lifecycleFixture,
  emptyDestination,
  assertInlineRows,
  inlineRows,
  scopeSnapshot,
  SOURCE,
  LIFECYCLE_TARGET,
} from './helpers/stream-lifecycle-fixture';
import { getStandaloneHistoryStorage } from '../lib/standalone-history';
import { snapshotFormat4Files } from './helpers/chat-format4-scope';
import { BODY_TEXT } from './helpers/stream-portable-fixture';
import { drainOpenRepositories } from './helpers/chat-delta-journal-scope';

function handler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([name]) => name === channel);
  if (!call || !(call[1] instanceof Function))
    throw new Error(`Missing IPC handler ${channel}`);
  const callback = call[1];
  return (...args) =>
    Promise.resolve(Reflect.apply(callback, undefined, [undefined, ...args]));
}
function exportedPath(value: unknown): string {
  if (
    !value ||
    typeof value !== 'object' ||
    !('exportedPath' in value) ||
    typeof value.exportedPath !== 'string'
  )
    throw new Error('Invalid export response');
  return value.exportedPath;
}
function importedId(value: unknown): string {
  if (
    !value ||
    typeof value !== 'object' ||
    !('project' in value) ||
    !value.project ||
    typeof value.project !== 'object' ||
    !('id' in value.project) ||
    typeof value.project.id !== 'string'
  )
    throw new Error('Invalid import response');
  return value.project.id;
}

jest.setTimeout(180_000);
describe('standalone export/import through registered IPC handlers', () => {
  let root: string;
  let oldDataDir: string | undefined;
  let repository: ChatStateV2Repository | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-lifecycle-standalone-'));
    oldDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(root, 'data');
    resetResolvedCanopyDataDirForTests();
    jest.mocked(registerIpcHandler).mockClear();
    registerStandaloneChatHandlers();
  });
  afterEach(async () => {
    await repository?.drainAll();
    await drainOpenRepositories();
    resetChatStateServiceForTests();
    jest.restoreAllMocks();
    if (oldDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = oldDataDir;
    resetResolvedCanopyDataDirForTests();
    await rm(root, { recursive: true, force: true });
  });
  it.each([false, true])(
    'reads checkpointed format4 standalone history without canonical writes (settled=%s)',
    async (settled) => {
      const fixtureRoot = join(root, 'history-fixture');
      await mkdir(fixtureRoot);
      const f = await lifecycleFixture(fixtureRoot, settled);
      repository = f.repository;
      const conversation = getWorkspaceChatHistoryConversationFilePath(
        'p',
        'chat',
      );
      const store = new ChatStorageV2(dirname(conversation), 'chat', [
        conversation,
      ]);
      await f.service.captureStorageScope(SOURCE, store);
      const before = await snapshotFormat4Files(dirname(conversation));
      expect(
        await (await getStandaloneHistoryStorage('p', 'chat'))?.format(),
      ).toBe('v4');
      const request = { ...SOURCE, chatId: 'chat', standaloneHistory: true };
      const page = await f.service.getTranscriptPage(request);
      expect(
        page.messages[0]?.blocks.some(
          (block) =>
            block.type === 'delegated_agent_call' &&
            block.finalText === 'answer preview',
        ),
      ).toBe(true);
      const childRequest = { ...request, target: LIFECYCLE_TARGET };
      expect(
        (
          await f.service.getTranscriptBlocks({
            ...childRequest,
            messageId: 'row-1',
            firstBlockOrdinal: 0,
            limit: 22,
          })
        ).blockCount,
      ).toBe(22);
      await expect(
        f.service.readTranscriptContent({
          ...childRequest,
          messageId: 'row-1',
          blockOrdinal: 21,
          field: 'output',
          requestId: 'history-content',
          offset: 0,
          limit: 48,
        }),
      ).resolves.toMatchObject({ text: BODY_TEXT.slice(0, 48) });
      expect(await snapshotFormat4Files(dirname(conversation))).toEqual(before);
    },
  );
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'exports closure and imports/refuses safely (settled=%s, destination4=%s)',
    async (settled, destination4) => {
      const fixtureRoot = join(root, 'fixture');
      await mkdir(fixtureRoot);
      await lifecycleFixture(fixtureRoot, settled);
      const sourceWorkspace =
        await workspaceCrud.createCoworkWorkspace('Lifecycle source');
      const sourceRoot = getWorkspaceDir(sourceWorkspace.id);
      for (const family of ['chat-storage-v2', 'chat-storage-manifests'])
        await cp(join(fixtureRoot, family), join(sourceRoot, family), {
          recursive: true,
        });
      repository = new ChatStateV2Repository({
        enableFormat4: false,
        deltaJournalIdleCheckpointMs: 3600_000,
        resolvePaths: ({
          projectId,
          worktreeId,
        }): { tabs: string; archives: string; journal: string } => ({
          tabs: getWorkspaceChatTabsFilePath(projectId, worktreeId),
          archives: getWorkspaceChatArchivesFilePath(projectId, worktreeId),
          journal: getWorkspaceChatJournalFilePath(projectId, worktreeId),
        }),
      });
      const service = new ChatStateService({ repository });
      resetChatStateServiceForTests(service);
      const exportDirectory = join(root, 'exports');
      await mkdir(exportDirectory);
      const exported = exportedPath(
        await handler(IPC_CHANNELS.standaloneChatExportProject)({
          projectId: sourceWorkspace.id,
          destinationPath: exportDirectory,
        }),
      );
      const capturedStore = new ChatStorageV2(exported, 'source', undefined, {
        maxManifestVersion: 4,
      });
      const capturedBackend = new ChatStateV2Backend(capturedStore);
      const exportedRows = await capturedBackend.consumeTranscript(
        'chat',
        true,
        async (rows) => {
          const messages = [];
          for await (const row of rows) messages.push(row);
          return messages;
        },
        { inlineDelegationChildren: true },
      );
      assertInlineRows(exportedRows);
      const sourceBefore = await scopeSnapshot(sourceRoot, 'source');
      const create = workspaceCrud.createCoworkWorkspace;
      let destinationRoot: string | undefined;
      let before: Awaited<ReturnType<typeof scopeSnapshot>> | undefined;
      jest
        .spyOn(workspaceCrud, 'createCoworkWorkspace')
        .mockImplementation(async (...args) => {
          const created = await create(...args);
          destinationRoot = getWorkspaceDir(created.id);
          for (const scopeId of ['source', 'destination', 'portable-source'])
            await emptyDestination(destinationRoot, scopeId, destination4);
          before = await scopeSnapshot(destinationRoot, 'source');
          return created;
        });
      const importing = handler(IPC_CHANNELS.standaloneChatImportProject)({
        sourcePath: exported,
      });
      if (!destination4) {
        await expect(importing).rejects.toBeInstanceOf(
          StreamClosureCopyRefusalError,
        );
        if (!destinationRoot || !before)
          throw new Error('Missing import destination');
        expect(await scopeSnapshot(destinationRoot, 'source')).toEqual(before);
        expect(await scopeSnapshot(sourceRoot, 'source')).toEqual(sourceBefore);
        assertInlineRows(
          await inlineRows(
            repository,
            { projectId: sourceWorkspace.id, worktreeId: 'source' },
            'chat',
          ),
        );
        return;
      }
      const projectId = importedId(await importing);
      assertInlineRows(
        await inlineRows(
          repository,
          { projectId, worktreeId: 'source' },
          'chat',
        ),
      );
      await repository.transact(
        { projectId: sourceWorkspace.id, worktreeId: 'source' },
        [{ type: 'tab.removed', tabId: 'chat' }],
        { source: 'migration' },
      );
      assertInlineRows(
        await inlineRows(
          repository,
          { projectId, worktreeId: 'source' },
          'chat',
        ),
      );
      expect(
        await readFile(join(exported, 'cowork-workspace.json'), 'utf8'),
      ).toContain('"version": 2');
    },
  );
});
