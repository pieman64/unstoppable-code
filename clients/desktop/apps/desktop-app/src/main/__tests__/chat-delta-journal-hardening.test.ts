/**
 * Phase 09 review hardening of the delta-journal write path:
 *
 * 1. A demotion that publishes the version 2 manifest and then fails to
 *    remove the journal must not leave the scope writing to that journal: a
 *    fresh version 2 load sees every acknowledged write.
 * 2. A writer poisoned by a failed checkpoint is detached from the shared
 *    transcript log, so the same backend reopens, reads and demotes.
 * 3. The choice of the version 2 path for a large record counts UTF-8 bytes.
 * 4. A failed promotion is retried after later activity, with a bounded
 *    backoff.
 */
import fs, { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatCoreMutation } from '@canopy/desktop-shared/types';
import { DELTA_JOURNAL_FILE_NAME } from '../lib/chat-delta-journal/format';
import { summarizeDeltaJournal } from '../lib/chat-delta-journal/reader';
import {
  ChatDeltaJournalWriter,
  demoteFromDeltaJournal,
  promoteToDeltaJournal,
} from '../lib/chat-delta-journal/writer';
import {
  ChatStateV2Backend,
  type ChatStateV2BackendOptions,
} from '../services/chat-state-v2-backend';
import type {
  ChatStateV2Repository,
  ChatStateV2RepositoryOptions,
} from '../services/chat-state-v2-repository';
import type { ChatStateStorageDiagnostic } from '../services/chat-state-contracts';
import { createV2Scope } from './helpers/chat-delta-journal-harness';
import {
  drainOpenRepositories,
  manifestVersion,
  repositoryAt,
  storeAt,
  streaming,
  text,
  upsert,
} from './helpers/chat-delta-journal-scope';

jest.setTimeout(300_000);

const SCOPE = { projectId: 'workspace', worktreeId: 'scope' };

function ioError(): Error {
  return Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
}

async function seed(root: string, scopeId = 'scope'): Promise<void> {
  await createV2Scope(root, scopeId, [
    {
      id: 'chat',
      messages: [text('m0', 'hello', 'user'), text('m1', 'answer')],
    },
  ]);
}

/** A repository whose idle checkpoints never run on their own. */
function quiet(
  root: string,
  options: ChatStateV2RepositoryOptions = {},
): ChatStateV2Repository {
  return repositoryAt(root, {
    deltaJournalIdleCheckpointMs: 3_600_000,
    ...options,
  });
}

let ordinal = 0;
function commit(
  repository: ChatStateV2Repository,
  mutations: ChatCoreMutation[],
): ReturnType<ChatStateV2Repository['transact']> {
  ordinal += 1;
  return repository.transact(SCOPE, mutations, {
    source: 'provider',
    mutationId: `mutation-${ordinal}`,
    chatIds: ['chat'],
  });
}

async function transact(
  backend: ChatStateV2Backend,
  mutations: ChatCoreMutation[],
): Promise<void> {
  ordinal += 1;
  await backend.transact(() => mutations, {
    source: 'provider',
    mutationId: `backend-${ordinal}`,
    chatIds: ['chat'],
  });
}

async function messageIds(
  backend: ChatStateV2Backend | ChatStateV2Repository,
): Promise<string[]> {
  const state =
    backend instanceof ChatStateV2Backend
      ? await backend.state({ chatIds: ['chat'], fullTranscript: true })
      : await backend.getState(SCOPE, {
          chatIds: ['chat'],
          fullTranscript: true,
        });
  return state.tabsFile.tabs[0].messages.map((message) => message.id);
}

/** A plain version 2 backend verifies the compatibility demotion. */
async function freshV2Ids(root: string): Promise<string[]> {
  const store = storeAt(root, 'scope');
  expect(await manifestVersion(store)).toBe(2);
  return messageIds(new ChatStateV2Backend(store));
}

async function eventually(
  condition: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Fail `fs.rename` onto paths `matches` selects while `armed()` holds. */
function failRenames(
  matches: (to: string) => boolean,
  armed: () => boolean = (): boolean => true,
): void {
  const move = fs.rename;
  jest
    .spyOn(fs, 'rename')
    .mockImplementation((from, to) =>
      armed() && matches(String(to))
        ? Promise.reject(ioError())
        : move(from, to),
    );
}

describe('delta journal hardening', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-delta-journal-hardening-'));
    ordinal = 0;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await drainOpenRepositories();
    await rm(root, { recursive: true, force: true });
  });

  it('a writer refuses to append once its scope is demoted to version 2', async () => {
    await seed(root);
    const store = storeAt(root, 'scope');
    await promoteToDeltaJournal(store);
    const writer = await ChatDeltaJournalWriter.open(store);
    const current = writer.indexes();
    // The version 2 manifest publishes; the journal then cannot be removed.
    const journalPath = join(store.directory, DELTA_JOURNAL_FILE_NAME);
    const remove = fs.rm;
    jest
      .spyOn(fs, 'rm')
      .mockImplementation((path, options) =>
        String(path) === journalPath
          ? Promise.reject(ioError())
          : remove(path, options),
      );
    await demoteFromDeltaJournal(store, { writer }).catch(() => false);
    expect(await manifestVersion(store)).toBe(2);
    expect(writer.isOpen()).toBe(false);
    await expect(
      writer.commit({
        expectedRevision: current.live.revision,
        next: {
          live: { ...current.live, revision: current.live.revision + 1 },
          archive: {
            ...current.archive,
            revision: current.archive.revision + 1,
          },
          recovery: { ...current.recovery, mutationIds: ['stale'] },
        },
        writes: [],
        mutationIds: ['stale'],
      }),
    ).rejects.toThrow();
    expect(
      (
        await summarizeDeltaJournal({
          directory: store.directory,
          scopeId: 'scope',
        })
      ).recordCount,
    ).toBe(0);
  });

  describe('a writer poisoned by a failed checkpoint', () => {
    async function poisoned(): Promise<ChatStateV2Backend> {
      await seed(root);
      const store = storeAt(root, 'scope');
      const backend = new ChatStateV2Backend(store, { deltaJournal: {} });
      await backend.load();
      expect(await backend.promoteToDeltaJournal()).toBe(true);
      await transact(backend, [
        streaming('chat', 'p'),
        upsert('chat', text('p', 'go', 'user')),
      ]);
      await transact(backend, [upsert('chat', text('a1', 'journaled'))]);
      expect(backend.pendingJournalRecords()).toBe(1);
      let armed = true;
      failRenames(
        (to) => to.startsWith(store.directory),
        () => armed,
      );
      await expect(backend.checkpointPendingJournal()).rejects.toThrow();
      armed = false;
      return backend;
    }

    it('reopens, serves pages and demotes through the same backend and log', async () => {
      const backend = await poisoned();
      expect(await messageIds(backend)).toEqual(
        expect.arrayContaining(['p', 'a1']),
      );
      const page = await backend.page('chat');
      expect(page.messages.map((message) => message.id)).toContain('a1');
      expect(await backend.demoteFromDeltaJournal()).toBe(true);
      expect(await freshV2Ids(root)).toEqual(
        expect.arrayContaining(['p', 'a1']),
      );
    });

    it('demotes straight away without a read in between', async () => {
      const backend = await poisoned();
      expect(await backend.demoteFromDeltaJournal()).toBe(true);
      expect(await messageIds(backend)).toContain('a1');
      expect(await freshV2Ids(root)).toContain('a1');
    });
  });

  describe('the version 2 path for a large record', () => {
    async function promotedBackend(
      options: ChatStateV2BackendOptions['deltaJournal'],
    ): Promise<ChatStateV2Backend> {
      await seed(root);
      const backend = new ChatStateV2Backend(storeAt(root, 'scope'), {
        deltaJournal: options,
      });
      await backend.load();
      expect(await backend.promoteToDeltaJournal()).toBe(true);
      await transact(backend, [
        streaming('chat', 'p'),
        upsert('chat', text('p', 'go', 'user')),
      ]);
      return backend;
    }

    it('counts UTF-8 bytes, not UTF-16 code units', async () => {
      // 2,000 code units of text, 6,000 bytes of UTF-8, over two rows.
      const backend = await promotedBackend({ largeRecordBytes: 4096 });
      await transact(backend, [
        upsert('chat', text('wide-1', '漢'.repeat(1000))),
        upsert('chat', text('wide-2', '字'.repeat(1000))),
      ]);
      // Too large for one journal record: this transaction was version 2.
      expect(await manifestVersion(storeAt(root, 'scope'))).toBe(2);
      expect(backend.wantsRepromotion()).toBe(true);
      expect(await messageIds(backend)).toEqual(
        expect.arrayContaining(['wide-1', 'wide-2']),
      );
    });

    it('commits multibyte rows past the frame limit through version 2', async () => {
      // Five rows inside the 16 MiB row limit: 27.5 million code units (under
      // the 48 MiB threshold counted as UTF-16) but 82.5 MB of UTF-8, past the
      // 64 MiB frame limit.
      const backend = await promotedBackend({});
      const ids = ['huge-1', 'huge-2', 'huge-3', 'huge-4', 'huge-5'];
      await transact(
        backend,
        ids.map((id) => upsert('chat', text(id, '漢'.repeat(5_500_000)))),
      );
      expect(await manifestVersion(storeAt(root, 'scope'))).toBe(2);
      expect(await freshV2Ids(root)).toEqual(expect.arrayContaining(ids));
    });
  });

  describe('a failed promotion', () => {
    function promotionFailures(
      diagnostics: ChatStateStorageDiagnostic[],
    ): number {
      return diagnostics.filter(
        (diagnostic) => diagnostic.kind === 'delta_journal_promotion_failed',
      ).length;
    }

    it('is retried after later activity', async () => {
      await seed(root);
      const store = storeAt(root, 'scope');
      let armed = true;
      failRenames(
        (to) => to === store.manifestPath,
        () => armed,
      );
      const diagnostics: ChatStateStorageDiagnostic[] = [];

      const repository = quiet(root, {
        deltaJournalPromotionRetryMs: 0,
        onStorageDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      await repository.getState(SCOPE);
      expect(promotionFailures(diagnostics)).toBe(1);
      expect(await manifestVersion(store)).toBe(2);
      armed = false;
      await commit(repository, [upsert('chat', text('m2', 'later'))]);
      await eventually(
        async () => (await manifestVersion(store)) === 3,
        'promotion retried',
      );
      expect(await messageIds(repository)).toContain('m2');
      await repository.drainAll();
    });

    it('retries a persistent failure a bounded number of times', async () => {
      await seed(root);
      const store = storeAt(root, 'scope');
      failRenames((to) => to === store.manifestPath);
      const diagnostics: ChatStateStorageDiagnostic[] = [];

      const repository = quiet(root, {
        deltaJournalPromotionRetryMs: 0,
        deltaJournalPromotionRetryLimit: 3,
        onStorageDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      await repository.getState(SCOPE);
      for (let index = 0; index < 8; index += 1)
        await commit(repository, [
          upsert('chat', text(`m${index + 2}`, `activity ${index}`)),
        ]);
      await repository.flushScope(SCOPE);
      // The first attempt and three retries.
      expect(promotionFailures(diagnostics)).toBe(4);
      expect(await manifestVersion(store)).toBe(2);
      await repository.drainAll();
    });

    it('waits out its backoff instead of retrying on every commit', async () => {
      await seed(root);
      const store = storeAt(root, 'scope');
      failRenames((to) => to === store.manifestPath);
      const diagnostics: ChatStateStorageDiagnostic[] = [];

      const repository = quiet(root, {
        deltaJournalPromotionRetryMs: 3_600_000,
        onStorageDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      await repository.getState(SCOPE);
      for (let index = 0; index < 4; index += 1)
        await commit(repository, [
          upsert('chat', text(`m${index + 2}`, `activity ${index}`)),
        ]);
      await repository.flushScope(SCOPE);
      expect(promotionFailures(diagnostics)).toBe(1);
      await repository.drainAll();
    });
  });
});
