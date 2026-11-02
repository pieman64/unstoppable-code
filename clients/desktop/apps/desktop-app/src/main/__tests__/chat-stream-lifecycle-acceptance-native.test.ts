import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forkOpenWorktreeTabs } from '../lib/worktree-open-tabs-fork';
import { adhocMigrateWorktreeTabs } from '../lib/adhoc-migrate-tabs';
import {
  createCommandOutputSpools,
  type DelegationCommandSpools,
} from '../agents/delegation/command-output-spools';
import { drainOpenRepositories } from './helpers/chat-delta-journal-scope';
import { child } from './helpers/stream-closure-copy-fixture';
import { StreamClosureCopyRefusalError } from '../lib/chat-delta-journal/stream-closure-copy';
import {
  lifecycleFixture,
  SOURCE,
  DESTINATION,
  inlineRows,
  assertInlineRows,
  maintain,
  settleLater,
  scopeSnapshot,
  LIFECYCLE_TARGET as target,
  LIFECYCLE_BLOCK,
} from './helpers/stream-lifecycle-fixture';

jest.setTimeout(180_000);

describe('real lifecycle entry points on newer format-4 scopes, option off', () => {
  let root: string;
  let spoolOwners: DelegationCommandSpools[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-lifecycle-'));
    spoolOwners = [];
  });
  afterEach(async () => {
    for (const owner of spoolOwners) await owner.close();
    await drainOpenRepositories();
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const callers = [
    'same-scope fork',
    'new-id archive restore',
    'cross-scope copy',
    'cross-scope move',
    'worktree fork',
    'ad-hoc migration',
  ] as const;
  describe.each(callers)('%s', (caller) => {
    const scenarios =
      caller === 'same-scope fork' || caller === 'new-id archive restore'
        ? ([
            [false, 'source', true],
            [true, 'source', true],
            [false, 'copy', true],
            [true, 'copy', true],
          ] as const)
        : ([
            [false, 'source', true],
            [true, 'source', true],
            [false, 'copy', true],
            [true, 'copy', true],
            [false, 'source', false],
            [true, 'source', false],
          ] as const);
    it.each(scenarios)(
      'preserves closure or refuses below format4 (settled=%s, delete=%s, destination4=%s)',
      async (settled, deleting, destination4) => {
        const f = await lifecycleFixture(root, settled, destination4);
        const ownSpools = createCommandOutputSpools({
          root: () => join(root, 'spools'),
        });
        const otherSpools = createCommandOutputSpools({
          root: () => join(root, 'spools'),
        });
        spoolOwners.push(ownSpools, otherSpools);
        await (
          await ownSpools.acquire('source-generation')
        ).append('unadmitted source spool only');
        const other = await otherSpools.acquire('other-generation');
        await other.append('another generation survives');
        const sourceState = await f.repository.getState(SOURCE);
        const destination =
          caller === 'same-scope fork' || caller === 'new-id archive restore'
            ? SOURCE
            : DESTINATION;
        await f.repository.getState(destination);
        const sourceBefore = await scopeSnapshot(root, 'source');
        const destinationBefore = await scopeSnapshot(root, 'destination');
        const copy = async (): Promise<void> => {
          if (caller === 'same-scope fork') {
            expect(
              (
                await f.service.command({
                  schemaVersion: 1,
                  commandId: 'fork',
                  ...SOURCE,
                  command: {
                    type: 'chat.fork_tab',
                    sourceTabId: 'chat',
                    targetTabId: 'copy',
                  },
                })
              ).outcome,
            ).toBe('applied');
          } else if (caller === 'new-id archive restore') {
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
            expect(
              (
                await f.service.command({
                  schemaVersion: 1,
                  commandId: 'restore',
                  ...SOURCE,
                  command: {
                    type: 'chat.restore_archive',
                    archiveEntryId: 'chat',
                    targetTabId: 'copy',
                  },
                })
              ).outcome,
            ).toBe('applied');
          } else if (
            caller === 'cross-scope copy' ||
            caller === 'cross-scope move'
          ) {
            await f.service.copyStorageChats(
              SOURCE,
              DESTINATION,
              {
                ...sourceState.tabsFile,
                tabs: sourceState.tabsFile.tabs.map((tab) => ({
                  ...tab,
                  id: 'copy',
                })),
                activeTabId: 'copy',
              },
              { version: 1, archived: [] },
              { copy: 'chat' },
            );
          } else if (caller === 'worktree fork') {
            await forkOpenWorktreeTabs(
              {
                projectId: 'p',
                sourceWorktreeId: 'source',
                destinationWorktreeId: 'destination',
              },
              {
                readTabs: async (_projectId, worktreeId) =>
                  (await f.repository.getState({ projectId: 'p', worktreeId }))
                    .tabsFile,
                copyTabs: async (
                  _request,
                  data,
                  ids,
                  through,
                  before,
                  prepare,
                ) =>
                  f.service.copyStorageChats(
                    SOURCE,
                    DESTINATION,
                    data,
                    { version: 1, archived: [] },
                    ids,
                    undefined,
                    through,
                    before,
                    prepare,
                  ),
                resolveCwd: (_projectId, worktreeId) => join(root, worktreeId),
                getCurrentBranch: () => Promise.resolve('main'),
                nextId: () => 'copy',
                now: () => new Date(1000),
                loadPanelLayout: () => Promise.resolve(null),
              },
            );
          } else {
            await adhocMigrateWorktreeTabs(
              {
                sourceWorkspaceId: 'p',
                sourceWorktreeId: 'source',
                destinationWorkspaceId: 'p',
                destinationWorktreeId: 'destination',
                filePathRewrites: [],
                selectedRepoIdRewrites: {},
              },
              {
                readTabs: async (_projectId, worktreeId) =>
                  (await f.repository.getState({ projectId: 'p', worktreeId }))
                    .tabsFile,
                updateTabs: (projectId, worktreeId, update) =>
                  f.service.updateCompatibilityTabs(
                    { projectId, worktreeId },
                    update,
                  ),
                copyTabs: (_request, data, ids) =>
                  f.service.copyStorageChats(
                    SOURCE,
                    DESTINATION,
                    data,
                    { version: 1, archived: [] },
                    ids,
                  ),
                resolveCwd: (_projectId, worktreeId) => join(root, worktreeId),
                nextId: () => 'copy',
                now: () => new Date(1000),
              },
            );
          }
        };
        if (!destination4) {
          await expect(copy()).rejects.toBeInstanceOf(
            StreamClosureCopyRefusalError,
          );
          expect(await scopeSnapshot(root, 'destination')).toEqual(
            destinationBefore,
          );
          expect(await scopeSnapshot(root, 'source')).toEqual(sourceBefore);
          assertInlineRows(await inlineRows(f.repository, SOURCE, 'chat'));
          return;
        }
        await copy();

        // Target-aware compatibility page, not a backend-copy-helper assertion.
        const page = await f.repository.page(
          destination,
          'copy',
          undefined,
          undefined,
          {
            ...destination,
            chatId: 'copy',
            target: { ...target, chatId: 'copy' },
          },
        );
        expect(page.messages.length).toBeGreaterThan(0);
        const captured = await inlineRows(f.repository, destination, 'copy');
        assertInlineRows(captured);
        if (deleting === 'copy' && caller !== 'new-id archive restore') {
          await f.repository.transact(
            destination,
            [{ type: 'tab.removed', tabId: 'copy' }],
            { source: 'migration' },
          );
          await f.repository.flushScope(destination);
          assertInlineRows(await inlineRows(f.repository, SOURCE, 'chat'));
          await maintain(f, root, SOURCE, 'chat');
          assertInlineRows(await inlineRows(f.repository, SOURCE, 'chat'));
          await ownSpools.close();
          expect(await other.read()).toBe('another generation survives');
          return;
        }
        if (caller !== 'new-id archive restore') {
          const later = f.repository.commitChildStream(
            SOURCE,
            target,
            'later-source-append',
            [
              {
                ...child(true, 'later source only'),
                id: 'late',
                delegationSequence: 106,
                parentBlockId: LIFECYCLE_BLOCK,
              },
            ],
          );
          if (settled)
            await expect(later).rejects.toThrow(
              'Settled child stream is immutable',
            );
          else {
            await later;
            await settleLater(f, root);
          }
          expect(await inlineRows(f.repository, destination, 'copy')).toEqual(
            captured,
          );
          await maintain(f, root, SOURCE, 'chat');
        }
        await maintain(f, root, destination, 'copy');
        expect(await inlineRows(f.repository, destination, 'copy')).toEqual(
          captured,
        );
        await ownSpools.close();
        expect(await other.read()).toBe('another generation survives');

        // C17 source deletion: new-id restore already removes its source atomically.
        if (caller !== 'new-id archive restore') {
          await f.repository.transact(
            SOURCE,
            [{ type: 'tab.removed', tabId: 'chat' }],
            { source: 'migration' },
          );
          await f.repository.flushScope(SOURCE);
        }
        expect(await inlineRows(f.repository, destination, 'copy')).toEqual(
          captured,
        );
        expect(
          await readFile(
            join(
              root,
              'chat-storage-manifests',
              `${destination.worktreeId}.json`,
            ),
            'utf8',
          ),
        ).toContain('4');
      },
    );
  });
});
