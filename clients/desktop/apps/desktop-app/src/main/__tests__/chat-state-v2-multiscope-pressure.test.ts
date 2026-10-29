import fs, { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';

const scopes = Array.from({ length: 6 }, (_, index) => ({
  projectId: 'workspace',
  worktreeId: `scope-${index}`,
}));

it('admits six independent durable scope writes while ordering a publication-boundary write after failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-multiscope-pressure-'));
  const paths = (
    worktreeId: string,
  ): {
    tabs: string;
    archives: string;
    journal: string;
  } => ({
    tabs: join(root, 'chats', `${worktreeId}.json`),
    archives: join(root, 'chat-archives', `${worktreeId}.json`),
    journal: join(root, 'chat-journals', `${worktreeId}.jsonl`),
  });
  const repository = new ChatStateV2Repository({
    resolvePaths: (scope): ReturnType<typeof paths> => paths(scope.worktreeId),
  });
  let releaseWrites = (): void => undefined;
  const heldWrites = new Promise<void>((resolve) => {
    releaseWrites = resolve;
  });
  const pending: Array<Promise<unknown>> = [];
  try {
    await mkdir(join(root, 'chats'), { recursive: true });
    for (const scope of scopes) {
      const file = paths(scope.worktreeId).tabs;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          activeTabId: 'chat',
          tabs: [
            {
              id: 'chat',
              title: 'Initial',
              createdAt: '2026-09-24',
              messages: [
                {
                  id: 'user',
                  role: 'user',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: 'preserved' }],
                },
              ],
            },
          ],
        }),
      );
    }
    const journalPaths = scopes.map((scope) =>
      join(root, 'chat-storage-v2', scope.worktreeId, 'delta-journal.log'),
    );
    const open = fs.open;
    const entered = new Set<number>();
    let holdSyncs = false;
    let activeWrites = 0;
    let peakWrites = 0;
    let stagedBytes = 0;
    let releaseAllEntered = (): void => undefined;
    const allEntered = new Promise<void>((resolve) => {
      releaseAllEntered = resolve;
    });
    // Install before loading so the already-open journal handles are covered.
    jest.spyOn(fs, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await open(file, flags, mode);
      const index = typeof file === 'string' ? journalPaths.indexOf(file) : -1;
      if (index < 0 || flags !== 'r+') return handle;
      const sync = handle.sync.bind(handle);
      handle.sync = async (): Promise<void> => {
        if (!holdSyncs || entered.has(index)) return sync();
        entered.add(index);
        // Real journal records have been appended. Hold their durability
        // boundary to measure admitted operations across independent scopes.
        stagedBytes += (await handle.stat()).size;
        activeWrites += 1;
        peakWrites = Math.max(peakWrites, activeWrites);
        if (activeWrites === scopes.length) releaseAllEntered();
        try {
          await heldWrites;
          if (index === 0) throw new Error('injected journal sync failure');
          await sync();
        } finally {
          activeWrites -= 1;
        }
      };
      return handle;
    });
    await Promise.all(scopes.map((scope) => repository.getState(scope)));
    holdSyncs = true;

    const first = scopes.map((scope, index) =>
      repository.transact(
        scope,
        [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { title: `First ${index}: ${'x'.repeat(2048)}` },
          },
        ],
        { source: 'automation' },
      ),
    );
    pending.push(...first);
    const firstOutcomes = Promise.allSettled(first);
    let secondBuilderEntered = false;
    let secondPublished = false;
    const second = repository.transactWith(
      scopes[0],
      () => {
        secondBuilderEntered = true;
        return [
          {
            type: 'tab.metadata_patched',
            tabId: 'chat',
            patch: { title: 'Second after failed first' },
          },
        ];
      },
      {
        source: 'automation',
        // Ordinary journal admissions can overlap. This publication-boundary
        // write must hold the scope lease until earlier writes settle.
        beforePublish: (): void => {
          secondPublished = true;
        },
      },
    );
    pending.push(second);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        allEntered,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('six journal writes did not overlap')),
            5000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    expect(peakWrites).toBe(6);
    expect(secondBuilderEntered).toBe(false);
    expect(secondPublished).toBe(false);
    process.stdout.write(
      `MULTISCOPE_DURABLE_PRESSURE ${JSON.stringify({
        admittedScopes: entered.size,
        peakHeldDurableTransactions: peakWrites,
        stagedJournalBytes: stagedBytes,
        heapUsedWhileHeld: process.memoryUsage().heapUsed,
      })}\n`,
    );
    releaseWrites();
    const outcomes = await firstOutcomes;
    expect(outcomes[0]).toMatchObject({ status: 'rejected' });
    for (const outcome of outcomes.slice(1)) {
      expect(outcome).toMatchObject({ status: 'fulfilled' });
    }
    await second;
    expect(secondBuilderEntered).toBe(true);
    expect(secondPublished).toBe(true);
    let index = 0;
    for (const scope of scopes) {
      const state = await repository.getState(scope);
      expect(state.tabsFile.tabs[0].title).toBe(
        index === 0
          ? 'Second after failed first'
          : `First ${index}: ${'x'.repeat(2048)}`,
      );
      // A complete unacknowledged record can replay after its sync failed;
      // the ordered retry then commits the next revision in that scope.
      expect(await repository.getRevision(scope)).toBe(index === 0 ? 2 : 1);
      index += 1;
    }
  } finally {
    releaseWrites();
    await Promise.allSettled(pending);
    jest.restoreAllMocks();
    await repository.drainAll();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
