import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchivedContainerManifest } from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';

jest.mock('../lib/window-send', () => ({
  sendToAllWindows: jest.fn(),
  sendToWindow: jest.fn(),
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../ledger/lifecycle', () => ({
  notifyLedgerContainerRestored: jest.fn(),
  recordLedgerRestoreIntent: jest.fn(() => Promise.resolve('recorded')),
}));
jest.mock('../cost-index/lifecycle', () => ({
  restoreEntryCostArchive: jest.fn(() => Promise.resolve()),
}));
jest.mock('../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    worktreeContainerRestored: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../browser/browser-profile-lifecycle', () => ({
  withBrowserTaskOwnerRemoval: (
    _project: string,
    _scope: string,
    callback: () => Promise<unknown>,
  ): Promise<unknown> => callback(),
}));

import * as archives from '../lib/archived-containers';
import { restoreArchivedContainer } from '../lib/archived-container-restore';
import * as workEntries from '../lib/cowork-work-entries';
import * as resolveWorktree from '../lib/resolve-worktree';
import * as stateService from '../services/chat-state-service';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import {
  getArchivedContainerDir,
  getArchivedContainerChatsPath,
  getArchivedContainerChatArchivesPath,
} from '../lib/paths';
import { snapshotFormat4Files } from './helpers/chat-format4-scope';
import {
  lifecycleFixture,
  SOURCE,
  DESTINATION,
  assertInlineRows,
  inlineRows,
  maintain,
  scopeSnapshot,
} from './helpers/stream-lifecycle-fixture';
import { drainOpenRepositories } from './helpers/chat-delta-journal-scope';
import { StreamClosureCopyRefusalError } from '../lib/chat-delta-journal/stream-closure-copy';

jest.setTimeout(180_000);
describe('container capture and work-entry restore through real routes', () => {
  let root: string;
  let oldDataDir: string | undefined;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-lifecycle-container-'));
    oldDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(root, 'data');
    resetResolvedCanopyDataDirForTests();
  });
  afterEach(async () => {
    await drainOpenRepositories();
    jest.restoreAllMocks();
    if (oldDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = oldDataDir;
    resetResolvedCanopyDataDirForTests();
    await rm(root, { recursive: true, force: true });
  });
  it.each([
    [false, true],
    [true, true],
    [false, false],
    [true, false],
  ])(
    'restores closure or refuses without staging (settled=%s, destination4=%s)',
    async (settled, destination4) => {
      const f = await lifecycleFixture(root, settled, destination4);
      jest
        .spyOn(stateService, 'getChatStateService')
        .mockReturnValue(f.service);
      jest
        .spyOn(resolveWorktree, 'resolveWorktreeCwd')
        .mockImplementation((_projectId, scopeId) => join(root, scopeId));
      jest.spyOn(workEntries, 'createWorkEntry').mockResolvedValue({
        entry: {
          id: 'destination',
          title: 'Restored entry',
          createdAt: '2026-10-20T00:00:00.000Z',
          chatCount: 0,
        },
        reusedExistingEmpty: false,
      });
      jest
        .spyOn(workEntries, 'removeWorkEntryRow')
        .mockResolvedValue(undefined);
      jest
        .spyOn(archives, 'purgeArchivedContainerAfterRestore')
        .mockResolvedValue(true);
      const manifest: ArchivedContainerManifest = {
        version: 1,
        id: 'source',
        kind: 'work-entry',
        projectId: 'p',
        name: 'Captured entry',
        createdAt: '2026-10-20T00:00:00.000Z',
        archivedAt: '2026-10-20T00:00:00.000Z',
        retentionDays: 365,
        expiresAt: '2099-10-20T00:00:00.000Z',
        chatCount: 1,
        archivedChatCount: 0,
        executionCount: 0,
      };
      await archives.commitArchivedContainer(manifest);
      const directory = getArchivedContainerDir('p', 'source');
      const captured = new ChatStorageV2(directory, 'source', [
        getArchivedContainerChatsPath('p', 'source'),
        getArchivedContainerChatArchivesPath('p', 'source'),
        join(directory, 'chat-journal.jsonl'),
      ]);
      // Same real repository capture used by the archive I/O adapter, without spawning its process.
      await f.service.captureStorageScope(SOURCE, captured);
      expect(
        (await archives.getArchivedContainerChatStorage('p', 'source'))
          .directory,
      ).toBe(captured.directory);
      await f.repository.getState(DESTINATION);
      const before = await scopeSnapshot(root, 'destination');
      const sourceBefore = await snapshotFormat4Files(directory);
      const restoring = restoreArchivedContainer('p', 'source');
      if (!destination4) {
        await expect(restoring).rejects.toBeInstanceOf(
          StreamClosureCopyRefusalError,
        );
        expect(await scopeSnapshot(root, 'destination')).toEqual(before);
        expect(await snapshotFormat4Files(directory)).toEqual(sourceBefore);
        assertInlineRows(await inlineRows(f.repository, SOURCE, 'chat'));
        return;
      }
      expect(await restoring).toMatchObject({
        kind: 'work-entry',
        restoredEntryId: 'destination',
      });
      const copied = await inlineRows(f.repository, DESTINATION, 'chat');
      assertInlineRows(copied);
      await maintain(f, root, DESTINATION, 'chat');
      await f.repository.transact(
        SOURCE,
        [{ type: 'tab.removed', tabId: 'chat' }],
        { source: 'migration' },
      );
      await f.repository.flushScope(SOURCE);
      expect(await inlineRows(f.repository, DESTINATION, 'chat')).toEqual(
        copied,
      );
    },
  );
});
