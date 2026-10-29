/**
 * Promotion to the delta journal (storage manifest version 3) on a scope's
 * first load by default, from version 2
 * fixtures at each scope kind's real location under the data directory:
 * worktrees, cowork Work Entries, App Advisor, plan-explore (data root),
 * legacy version 1 scopes once migrated, and a scope with a pending version 2
 * transaction. Shared-container viewer scopes and archive captures never
 * promote. A loaded scope promotes at its next idle point, never mid-commit.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { resetResolvedCanopyDataDirForTests } from '@canopy/desktop-shared/canopy-paths';
import {
  getPlanExploreChatTabsFilePath,
  getWorkspaceChatTabsFilePath,
} from '../lib/paths';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStorageTransactions } from '../lib/chat-storage-transactions';
import { ChatStorageNewerFormatError } from '../lib/chat-delta-journal/format';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import type { ChatScopeKey } from '../services/chat-state-contracts';
import { scopeSource } from './helpers/chat-delta-journal-harness';
import {
  drainAfterTest,
  drainOpenRepositories,
  manifestVersion,
  streaming,
  text,
  upsert,
} from './helpers/chat-delta-journal-scope';

function pathsFor(scope: ChatScopeKey): {
  tabs: string;
  archives: string;
  journal: string;
} {
  const tabs =
    scope.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID
      ? getPlanExploreChatTabsFilePath(scope.worktreeId)
      : getWorkspaceChatTabsFilePath(scope.projectId, scope.worktreeId);
  const workspace = dirname(dirname(tabs));
  const name = basename(tabs, '.json');
  return {
    tabs,
    archives: join(workspace, 'chat-archives', `${name}.json`),
    journal: join(workspace, 'chat-journals', `${name}.jsonl`),
  };
}

function repository(): ChatStateV2Repository {
  // Tests keep two repositories on one scope; only the second may write, so
  // the first never checkpoints on its own (production has one).
  return drainAfterTest(
    new ChatStateV2Repository({
      resolvePaths: pathsFor,
      deltaJournalIdleCheckpointMs: 3_600_000,
    }),
  );
}

const CHATS: Array<{ id: string; messages: PersistedChatMessage[] }> = [
  {
    id: 'chat',
    messages: [text('m0', 'hello', 'user'), text('m1', 'answer 🌲')],
  },
  { id: 'other', messages: [text('o0', 'other', 'user')] },
];

async function seedV2(scope: ChatScopeKey): Promise<ChatStorageV2> {
  const store = ChatStorageV2.fromLegacyPaths(pathsFor(scope));
  await store.migrate(scopeSource(CHATS));
  return store;
}

async function v2View(store: ChatStorageV2): Promise<string> {
  return JSON.stringify(
    await new ChatStateV2Backend(store).state({
      chatIds: ['chat', 'other'],
      fullTranscript: true,
    }),
  );
}

describe('delta journal promotion', () => {
  let dataDir: string;
  const previous = process.env.CANOPY_DATA_DIR;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'chat-delta-journal-migration-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    resetResolvedCanopyDataDirForTests();
  });

  afterEach(async () => {
    await drainOpenRepositories();

    if (previous === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previous;
    resetResolvedCanopyDataDirForTests();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('promotes a writable scope without a preference loader or opt-in', async () => {
    const scope = { projectId: 'workspace-default', worktreeId: 'default' };
    const store = await seedV2(scope);
    const target = repository();
    await target.getState(scope);
    expect(await manifestVersion(store)).toBe(3);
    await target.drainAll();
  });

  it.each([
    ['a worktree', { projectId: 'workspace-a', worktreeId: 'worktree-a' }],
    ['a cowork Work Entry', { projectId: 'cowork-b', worktreeId: 'entry-b' }],
    [
      'an App Advisor entry',
      { projectId: APP_ADVISOR_PROJECT_ID, worktreeId: 'advisor-entry' },
    ],
    [
      'a plan-explore chat at the data root',
      { projectId: PLAN_EXPLORE_CHAT_PROJECT_ID, worktreeId: 'plan-c' },
    ],
  ])('promotes %s on its first load', async (_label, scope) => {
    const store = await seedV2(scope);
    const before = await v2View(store);
    const v2Manifest = await readFile(store.manifestPath, 'utf8');

    const target = repository();
    const state = await target.getState(scope, {
      chatIds: ['chat', 'other'],
      fullTranscript: true,
    });
    expect(JSON.stringify(state)).toBe(before);
    expect(await manifestVersion(store)).toBe(3);
    // The version 3 manifest keeps the version 2 one verbatim for demotion.
    const manifest: unknown = JSON.parse(
      await readFile(store.manifestPath, 'utf8'),
    );
    const demotesTo: unknown = JSON.parse(v2Manifest);
    expect(manifest).toEqual(expect.objectContaining({ demotesTo }));
    // And it is written through the journal from now on.
    await target.transact(scope, [upsert('chat', text('m2', 'journaled'))], {
      source: 'provider',
      mutationId: 'after-promotion',
    });
    const reopened = repository();
    expect(
      (
        await reopened.getState(scope, {
          chatIds: ['chat'],
          fullTranscript: true,
        })
      ).tabsFile.tabs
        .find((tab) => tab.id === 'chat')
        ?.messages.map((row) => row.id),
    ).toEqual(['m0', 'm1', 'm2']);
    await target.drainAll();
    await reopened.drainAll();
  });

  it('promotes a legacy version 1 scope once it migrates', async () => {
    const scope = { projectId: 'workspace-d', worktreeId: 'legacy' };
    const paths = pathsFor(scope);
    await mkdir(dirname(paths.tabs), { recursive: true });
    await writeFile(
      paths.tabs,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat',
        tabs: [
          {
            id: 'chat',
            title: 'Chat',
            createdAt: '2026-09-05',
            messages: [
              text('l0', 'legacy prompt', 'user'),
              text('l1', 'reply'),
            ],
          },
        ],
      }),
    );

    const target = repository();
    const state = await target.getState(scope, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    expect(state.tabsFile.tabs[0].messages.map((row) => row.id)).toEqual([
      'l0',
      'l1',
    ]);
    expect(await manifestVersion(ChatStorageV2.fromLegacyPaths(paths))).toBe(3);
    await target.drainAll();
  });

  it('recovers a pending version 2 transaction before promoting', async () => {
    const scope = { projectId: 'workspace-e', worktreeId: 'pending' };
    const store = await seedV2(scope);
    const interrupted = new ChatStorageTransactions(store, (point) =>
      point === 'journal'
        ? Promise.reject(new Error('interrupt'))
        : Promise.resolve(),
    );
    const next = await interrupted.load();
    next.live.revision = next.archive.revision = next.live.revision + 1;
    next.live.tabs[0] = { ...next.live.tabs[0], title: 'Recovered' };
    await expect(
      interrupted.commit(next.live.revision - 1, next, [
        {
          chatId: 'chat',
          kind: 'append',
          messages: [text('r1', 'recovered row', 'user')],
        },
      ]),
    ).rejects.toThrow('interrupt');

    const target = repository();
    const state = await target.getState(scope, {
      chatIds: ['chat'],
      fullTranscript: true,
    });
    expect(state.tabsFile.tabs[0].title).toBe('Recovered');
    expect(state.tabsFile.tabs[0].messages.map((row) => row.id)).toContain(
      'r1',
    );
    expect(await manifestVersion(store)).toBe(3);
    expect(
      (await readFile(join(store.directory, 'metadata-journal.jsonl'))).length,
    ).toBe(0);
    await target.drainAll();
  });

  it('never promotes a shared-container viewer scope', async () => {
    const scope = {
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: 'container',
    };
    const store = await seedV2(scope);

    const target = repository();
    await target.getState(scope);
    await target.transact(scope, [upsert('chat', text('v', 'projected'))], {
      source: 'provider',
      mutationId: 'viewer',
    });
    expect(await manifestVersion(store)).toBe(2);
    await target.drainAll();
  });

  it('captures a version 3 scope as a version 2 copy that never promotes by itself', async () => {
    const scope = { projectId: 'workspace-f', worktreeId: 'live' };
    await seedV2(scope);

    const target = repository();
    await target.getState(scope);
    await target.transact(
      scope,
      [streaming('chat', 'p'), upsert('chat', text('p', 'prompt', 'user'))],
      { source: 'provider', mutationId: 'p' },
    );
    await target.transact(scope, [upsert('chat', text('a', 'streamed'))], {
      source: 'provider',
      mutationId: 'a',
    });
    await target.transact(
      scope,
      [
        {
          type: 'runtime.patched',
          chatId: 'chat',
          runtime: { status: 'idle', queuedMessageIds: [] },
        },
      ],
      { source: 'provider', mutationId: 'end' },
    );
    // A journaled metadata change the capture must include.
    await target.transact(
      scope,
      [
        {
          type: 'tab.metadata_patched',
          tabId: 'chat',
          patch: { title: 'Journaled title' },
        },
      ],
      { source: 'provider', mutationId: 'title' },
    );
    // An archive capture: the repository checkpoints, then copies.
    const capture = new ChatStorageV2(join(dataDir, 'archive'), 'captured');
    await target.captureScope(scope, capture);
    expect(await capture.format()).toBe('v2');
    const captured = await new ChatStateV2Backend(capture).state({
      chatIds: ['chat'],
      fullTranscript: true,
    });
    expect(captured.tabsFile.tabs[0].title).toBe('Journaled title');
    expect(captured.tabsFile.tabs[0].messages.map((row) => row.id)).toEqual([
      'm0',
      'm1',
      'p',
      'a',
    ]);
    // Archive and history backends write version 2 only; on a version 3
    // scope they fail closed instead of writing version 2 files into it.
    await expect(
      new ChatStateV2Backend(
        ChatStorageV2.fromLegacyPaths(pathsFor(scope)),
      ).load(),
    ).rejects.toBeInstanceOf(ChatStorageNewerFormatError);
    expect(await capture.format()).toBe('v2');
    await target.drainAll();
  });
});
