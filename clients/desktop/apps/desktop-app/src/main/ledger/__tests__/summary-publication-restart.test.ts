import { readFileSync, writeFileSync, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { LEDGER_COMMAND_OPERATIONS } from '@canopy/desktop-shared/node/ledger';
import type { WorkspaceType } from '@canopy/desktop-shared/types';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import {
  getLedgerDatabasePath,
  getLedgerLifecycleIntentsPath,
} from '../../lib/paths';
import { resolveWorktreeSummaryFilePath } from '../../lib/resolve-worktree';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';
import { writeWorktreeSummarySnapshot } from '../../lib/worktree-summary-persistence';
import {
  LedgerLifecycle,
  type LedgerArchivedContainerRead,
  type LedgerContainerRegistryRead,
  type LedgerLifecycleFailure,
  type LedgerLifecyclePersistence,
  type LedgerStartupPassOutcome,
} from '../lifecycle';
import {
  LedgerLifecycleIntentJournal,
  createLedgerLifecycleIntentFile,
} from '../lifecycle-intents';
import type {
  SummaryPublicationHost,
  SummaryScope,
} from '../summary-publication';
import {
  DESKTOP_SUMMARY_RECONCILIATION_HOST,
  publishPendingSummarySnapshots,
  reconcileSummaryPublications,
  type SummaryReconciliationHost,
  type SummaryReconciliationResult,
} from '../summary-reconciliation';
import {
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  createLedgerServiceHarness,
  reopenLedgerServiceHarness,
  type LedgerServiceHarness,
} from './fixtures/in-process-ledger-store-client';

/*
 * Summary publication across a relaunch: the summary file is the real one
 * under a temporary data directory, and the Ledger database is closed and
 * reopened on the same path between an interruption and its replay.
 */

const filesystemServices = {
  listFileTreeRoots: (): Promise<{ roots: [] }> =>
    Promise.resolve({ roots: [] }),
  listFileTreeDirectory: (): Promise<{ entries: [] }> =>
    Promise.resolve({ entries: [] }),
};

// The harness binds TEST_CONTAINER: worktree-1 of workspace-1.
const SCOPE: SummaryScope = {
  projectId: 'workspace-1',
  worktreeId: 'worktree-1',
};

const WORKTREE_STILL_LISTED: LedgerLifecyclePersistence = {
  readWorkspaceIndex: (): Promise<ReadonlyMap<string, WorkspaceType>> =>
    Promise.resolve(new Map([[SCOPE.projectId, 'single-repo']])),
  readContainerRegistry: (): Promise<LedgerContainerRegistryRead> =>
    Promise.resolve({
      status: 'ok',
      createdAtById: new Map([[SCOPE.worktreeId, TEST_CONTAINER_CREATED_AT]]),
    }),
  readArchivedContainer: (): Promise<LedgerArchivedContainerRead> =>
    Promise.resolve({ status: 'absent' }),
};

describe('Summary publication across a relaunch', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  // Entries created in the same millisecond order by random id, so every
  // store call gets its own millisecond and order assertions stay stable.
  let lastStoreMs = 0;
  const harnessOptions = {
    store: {
      now: (): Date => {
        lastStoreMs = Math.max(Date.now(), lastStoreMs + 1);
        return new Date(lastStoreMs);
      },
    },
  };
  let harness: LedgerServiceHarness;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;
  let lifecycleFailures: LedgerLifecycleFailure[];

  const publication: SummaryPublicationHost = {
    isEnabled: (): boolean => true,
    dispatcher: (): ReturnType<SummaryPublicationHost['dispatcher']> =>
      dispatcher,
    registry: (): LedgerServiceHarness['bindings'] => harness.bindings,
    container: (projectId, worktreeId): LedgerContainer | null =>
      projectId === SCOPE.projectId && worktreeId === SCOPE.worktreeId
        ? TEST_CONTAINER
        : null,
    containerCreatedAt: (): Promise<string | null> =>
      Promise.resolve(TEST_CONTAINER_CREATED_AT),
    ledgerId: async (container, containerCreatedAt): Promise<string> =>
      (await harness.service.scopes.resolve(container, containerCreatedAt))
        .ledgerId,
    publishedKeys: (ledgerId, keys): Promise<string[]> =>
      harness.store.client.listReceiptKeys({
        ledgerId,
        operation: LEDGER_COMMAND_OPERATIONS.publishSummary,
        idempotencyKeys: keys,
      }),
    recordGap: (): void => undefined,
  };
  // The desktop's own scope listing and `readWorktreeSummaryFile` reads.
  const reconciliation: SummaryReconciliationHost = {
    ...DESKTOP_SUMMARY_RECONCILIATION_HOST,
    publication,
  };

  function summaryTitles(): string[] {
    return harness.store.repository.listScopes().flatMap((scope) =>
      harness.store.repository
        .searchEntries({
          ledgerId: scope.scope.ledgerId,
          types: ['SUMMARY'],
          sort: 'created_desc',
        })
        .entries.map((entry) => entry.title),
    );
  }

  /** Writes a summary the helper generated with the Ledger on. */
  function writeSummary(
    title: string,
  ): ReturnType<typeof writeWorktreeSummarySnapshot> {
    return writeWorktreeSummarySnapshot(
      SCOPE.projectId,
      SCOPE.worktreeId,
      {
        title,
        description: `${title} in detail.`,
        highlights: [`${title} highlight`],
        generatedAt: '2026-09-30T12:00:00.000Z',
        turnCountAtGeneration: 3,
        lastFullRefreshAt: '2026-09-30T12:00:00.000Z',
        lastFullRefreshTurnCount: 3,
      },
      {
        generationId: `gen-${title}`,
        harness: 'claude',
        model: 'claude-haiku',
        thinkingEffort: 'low',
        observedTaskKey: `helper:worktree-summary:workspace-1/worktree-1:${title}`,
        capturedAt: '2026-09-30T11:59:00.000Z',
        ledgerPublishable: true,
      },
    );
  }

  async function writeSnapshot(title: string): Promise<void> {
    const written = await writeSummary(title);
    // The scheduler's condition for publishing right after the write.
    if (
      written?.kind !== 'written' ||
      !written.isNewSnapshot ||
      written.snapshot.provenance?.ledgerPublishable !== true
    ) {
      throw new Error('Expected a new publishable snapshot');
    }
  }

  function startRuntime(): void {
    dispatcher = createDesktopRuntime({
      services: filesystemServices,
      ledgerService: harness.service,
    });
  }

  /** The process exits; only the database and the summary file survive. */
  async function relaunch(): Promise<void> {
    await dispatcher.shutdown();
    harness = reopenLedgerServiceHarness(harness, harnessOptions);
    startRuntime();
  }

  /**
   * The startup Ledger work of `startup-background-tasks.ts`, whose gate its
   * own test pins: Summary reconciliation runs only once the lifecycle pass
   * settled every scope.
   */
  async function startupPass(): Promise<{
    readonly ledger: LedgerStartupPassOutcome;
    readonly summaries: SummaryReconciliationResult | 'skipped';
  }> {
    const lifecycle = new LedgerLifecycle({
      store: (): LedgerServiceHarness['store']['client'] =>
        harness.store.client,
      statDatabase: (): Promise<Stats> => stat(getLedgerDatabasePath()),
      persistence: WORKTREE_STILL_LISTED,
      caches: (): undefined => undefined,
      callerBindings: (): LedgerServiceHarness['bindings'] => harness.bindings,
      withOwnerAdmission: <T>(
        _ledgerId: string,
        fn: () => Promise<T>,
      ): Promise<T> => fn(),
      invalidateOwnerEligibility: (): void => undefined,
      recordFailure: (failure): void => {
        lifecycleFailures.push(failure);
      },
      intents: new LedgerLifecycleIntentJournal({
        file: createLedgerLifecycleIntentFile(getLedgerLifecycleIntentsPath()),
      }),
    });
    const ledger = await lifecycle.reconcileAtStartup();
    await lifecycle.whenIdle();
    return {
      ledger,
      summaries:
        ledger === 'settled'
          ? await reconcileSummaryPublications(reconciliation)
          : 'skipped',
    };
  }

  beforeEach(() => {
    harness = createLedgerServiceHarness(harnessOptions);
    // The fixture database sits where the desktop keeps it in a data directory.
    process.env.CANOPY_DATA_DIR = harness.store.directory;
    expect(getLedgerDatabasePath()).toBe(harness.store.databasePath);
    registerWorkspaceTypes(new Map([[SCOPE.projectId, 'single-repo']]));
    startRuntime();
    lifecycleFailures = [];
  });

  afterEach(async () => {
    await dispatcher.shutdown();
    harness.dispose();
    registerWorkspaceTypes(new Map());
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
  });

  it('publishes snapshots interrupted before their receipt exactly once after a relaunch, in order', async () => {
    await writeSnapshot('Adds login');
    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 1, pending: 0 });
    // The command fails before it runs: no receipt.
    await writeSnapshot('Adds logout');
    harness.store.client.failNext('publishSummary', new Error('busy'));
    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 0, pending: 1 });
    // The process exits between the write and its publication.
    await writeSnapshot('Adds sessions');

    await relaunch();
    await expect(startupPass()).resolves.toEqual({
      ledger: 'settled',
      summaries: { scopes: 1, published: 2, pending: 0 },
    });
    await relaunch();
    await expect(startupPass()).resolves.toEqual({
      ledger: 'settled',
      summaries: { scopes: 0, published: 0, pending: 0 },
    });

    expect(summaryTitles()).toEqual([
      'Adds sessions',
      'Adds logout',
      'Adds login',
    ]);
    expect(harness.store.repository.getStorageCounts().receipts).toBe(3);
    expect(lifecycleFailures).toEqual([]);
  });

  it('never republishes a snapshot whose receipt committed before the interruption', async () => {
    await writeSnapshot('Adds login');
    await writeSnapshot('Adds logout');
    // The first command commits, then its reply is lost; the pass stops.
    harness.store.client.failNextAfterRunning(
      'publishSummary',
      new Error('reply lost'),
    );
    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 0, pending: 2 });
    expect(summaryTitles()).toEqual(['Adds login']);

    await relaunch();
    await expect(startupPass()).resolves.toEqual({
      ledger: 'settled',
      summaries: { scopes: 1, published: 1, pending: 0 },
    });

    expect(summaryTitles()).toEqual(['Adds logout', 'Adds login']);
    expect(harness.store.repository.getStorageCounts().receipts).toBe(2);
  });

  it('leaves startup reconciliation pending under a newer lifecycle journal, while a new snapshot still flushes earlier ones in order', async () => {
    await writeSnapshot('Adds login');
    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 1, pending: 0 });
    // The process exits between the write and its publication.
    await writeSnapshot('Adds logout');
    // Written by a newer build before this one was reinstalled.
    const newerJournal = JSON.stringify({ version: 2, intents: [] });
    writeFileSync(getLedgerLifecycleIntentsPath(), newerJournal);

    for (let launch = 0; launch < 2; launch += 1) {
      await relaunch();
      await expect(startupPass()).resolves.toEqual({
        ledger: 'incomplete',
        summaries: 'skipped',
      });
    }
    expect(lifecycleFailures).toEqual([
      { operation: 'reconcile', reason: 'INTENT_JOURNAL_UNREADABLE' },
      { operation: 'reconcile', reason: 'INTENT_JOURNAL_UNREADABLE' },
    ]);
    expect(summaryTitles()).toEqual(['Adds login']);

    // As the scheduler does after writing a new publishable snapshot.
    await writeSnapshot('Adds sessions');
    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 2, pending: 0 });

    expect(summaryTitles()).toEqual([
      'Adds sessions',
      'Adds logout',
      'Adds login',
    ]);
    // The newer build's journal is never overwritten.
    expect(readFileSync(getLedgerLifecycleIntentsPath(), 'utf8')).toBe(
      newerJournal,
    );
  });

  it('keeps a summary file a newer build wrote instead of replacing it', async () => {
    await writeSnapshot('Adds login');
    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 1, pending: 0 });
    // Written by a newer build before this one was reinstalled.
    const summaryPath = resolveWorktreeSummaryFilePath(
      SCOPE.projectId,
      SCOPE.worktreeId,
    );
    const newerFile = JSON.stringify({
      version: 3,
      summary: { title: 'Adds logout' },
      history: [{ snapshotId: 'newer-snapshot', pending: true }],
    });
    writeFileSync(summaryPath, newerFile);

    await expect(writeSummary('Adds sessions')).resolves.toEqual({
      kind: 'aborted',
      reason: 'future_version',
    });

    expect(readFileSync(summaryPath, 'utf8')).toBe(newerFile);
    expect(summaryTitles()).toEqual(['Adds login']);
  });
});
