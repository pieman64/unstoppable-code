import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as stateService from '../services/chat-state-service';
import * as paths from '../lib/paths';
import * as workEntries from '../lib/cowork-work-entries';
import * as plans from '../lib/plan-persistence';
import { splitFlatChatTabsIntoEntries } from '../lib/cowork-work-entry-migration';
import {
  migrateSplitChatsAndPlans,
  undoSplitChatsAndPlansMigration,
  type SplitWorktreeRepoItems,
} from '../lib/split-temporary-workspace-items';
import { readChatTabs } from '../shared-containers/publish/inventory';
import { StreamClosureCopyRefusalError } from '../lib/chat-delta-journal/stream-closure-copy';
import { drainOpenRepositories } from './helpers/chat-delta-journal-scope';
import {
  lifecycleFixture,
  SOURCE,
  DESTINATION,
  inlineRows,
  assertInlineRows,
  maintain,
  emptyDestination,
  scopeSnapshot,
} from './helpers/stream-lifecycle-fixture';

jest.setTimeout(180_000);

describe('real migration and publication entry points, creation option off', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-lifecycle-migrations-'));
  });
  afterEach(async () => {
    await drainOpenRepositories();
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    'shared-container publication captures inline rows (settled=%s)',
    async (settled) => {
      const f = await lifecycleFixture(root, settled);
      jest
        .spyOn(stateService, 'getChatStateService')
        .mockReturnValue(f.service);
      const published = await readChatTabs('p', 'source');
      expect(published.tabs).toHaveLength(1);
      assertInlineRows(published.tabs[0].messages);
      const captured = JSON.stringify(published);
      await f.repository.transact(
        SOURCE,
        [{ type: 'tab.removed', tabId: 'chat' }],
        { source: 'migration' },
      );
      await f.repository.flushScope(SOURCE);
      expect(JSON.stringify(published)).toBe(captured);
      assertInlineRows(published.tabs[0].messages);
    },
  );

  it.each([
    [false, true],
    [true, true],
    [false, false],
    [true, false],
  ])(
    'Cowork flat-home service migration carries closure or refuses (settled=%s, destination4=%s)',
    async (settled, destination4) => {
      const f = await lifecycleFixture(root, settled);
      jest
        .spyOn(stateService, 'getChatStateService')
        .mockReturnValue(f.service);
      jest
        .spyOn(paths, 'getWorkspaceChatTabsFilePath')
        .mockImplementation((_workspaceId, scopeId) =>
          join(root, 'chats', `${scopeId}.json`),
        );
      jest
        .spyOn(paths, 'getChatPluginsRootDir')
        .mockReturnValue(join(root, 'plugins'));
      jest
        .spyOn(workEntries, 'appendWorkEntryRows')
        .mockResolvedValue(undefined);
      // This caller chooses the founding chat id as the destination scope id.
      await emptyDestination(root, 'chat', destination4);
      await f.repository.getState(SOURCE);
      await f.repository.getState({ projectId: 'p', worktreeId: 'chat' });
      const sourceBefore = await scopeSnapshot(root, 'source');
      const destinationBefore = await scopeSnapshot(root, 'chat');
      const copying = splitFlatChatTabsIntoEntries('p', 'source');
      if (!destination4) {
        await expect(copying).rejects.toBeInstanceOf(
          StreamClosureCopyRefusalError,
        );
        expect(await scopeSnapshot(root, 'chat')).toEqual(destinationBefore);
        expect(await scopeSnapshot(root, 'source')).toEqual(sourceBefore);
        assertInlineRows(await inlineRows(f.repository, SOURCE, 'chat'));
        return;
      }
      await copying;
      const scope = { projectId: 'p', worktreeId: 'chat' };
      const copied = await inlineRows(f.repository, scope, 'chat');
      assertInlineRows(copied);
      expect((await f.repository.getState(SOURCE)).tabsFile.tabs).toEqual([]);
      await maintain(f, root, scope, 'chat');
      expect(await inlineRows(f.repository, scope, 'chat')).toEqual(copied);
    },
  );

  describe.each(['live', 'archive', 'backup restore'] as const)(
    'temporary split %s',
    (kind) => {
      it.each([
        [false, true],
        [true, true],
        [false, false],
        [true, false],
      ])(
        'copies every retained child or refuses (settled=%s, destination4=%s)',
        async (settled, destination4) => {
          const f = await lifecycleFixture(root, settled, destination4);
          jest
            .spyOn(stateService, 'getChatStateService')
            .mockReturnValue(f.service);
          jest.spyOn(paths, 'getWorkspaceDir').mockReturnValue(root);
          jest
            .spyOn(paths, 'getWorktreeAttachmentsDir')
            .mockImplementation((_workspaceId, scopeId) =>
              join(root, 'attachments', scopeId),
            );
          jest
            .spyOn(plans, 'readTrackedPlansFileForIndex')
            .mockResolvedValue({ version: 1, plans: [] });
          jest
            .spyOn(plans, 'installRestoredTrackedPlans')
            .mockResolvedValue(undefined);
          jest
            .spyOn(plans, 'deleteTrackedPlansForWorktree')
            .mockResolvedValue(undefined);
          if (kind === 'archive') {
            expect(
              (
                await f.service.command({
                  schemaVersion: 1,
                  commandId: 'archive',
                  ...SOURCE,
                  command: { type: 'chat.archive_tab', tabId: 'chat' },
                })
              ).outcome,
            ).toBe('applied');
          }
          const before = await f.repository.getState(SOURCE);
          await f.repository.getState(DESTINATION);
          // Archive membership was journal-admitted above; compare after its durable checkpoint.
          await f.repository.flushScope(SOURCE);
          const sourceBefore = await scopeSnapshot(root, 'source');
          const destinationBefore = await scopeSnapshot(root, 'destination');
          const items: SplitWorktreeRepoItems = {
            chatTabs: before.tabsFile.tabs,
            fileTabs: [],
            archivedChats: before.archivesFile.archived,
            executions: [],
            plans: [],
            attachmentNames: [],
          };
          const empty: SplitWorktreeRepoItems = {
            chatTabs: [],
            fileTabs: [],
            archivedChats: [],
            executions: [],
            plans: [],
            attachmentNames: [],
          };
          const copying = migrateSplitChatsAndPlans({
            workspaceId: 'p',
            worktreeId: 'source',
            analysis: { perRepo: new Map([['repo', items]]), root: empty },
            targets: [
              {
                repoId: 'repo',
                destinationWorkspaceId: 'p',
                destinationWorktreeId: 'destination',
                oldCheckoutPath: join(root, 'old'),
                newCheckoutPath: join(root, 'new'),
              },
            ],
          });
          if (!destination4) {
            await expect(copying).rejects.toBeInstanceOf(
              StreamClosureCopyRefusalError,
            );
            expect(await scopeSnapshot(root, 'destination')).toEqual(
              destinationBefore,
            );
            expect(await scopeSnapshot(root, 'source')).toEqual(sourceBefore);
            assertInlineRows(await inlineRows(f.repository, SOURCE, 'chat'));
            return;
          }
          const undo = await copying;
          assertInlineRows(await inlineRows(f.repository, DESTINATION, 'chat'));
          if (kind === 'backup restore') {
            await undoSplitChatsAndPlansMigration(undo);
            assertInlineRows(await inlineRows(f.repository, SOURCE, 'chat'));
            await maintain(f, root, SOURCE, 'chat');
            assertInlineRows(await inlineRows(f.repository, SOURCE, 'chat'));
          } else {
            await maintain(f, root, DESTINATION, 'chat');
            assertInlineRows(
              await inlineRows(f.repository, DESTINATION, 'chat'),
            );
          }
        },
      );
    },
  );
});
