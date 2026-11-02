import { LEDGER_COMMAND_OPERATIONS } from '@canopy/desktop-shared/node/ledger';
import type {
  LedgerContainer,
  LedgerEntrySearchItem,
} from '@canopy/protocol/canopy-core';
import type {
  WorktreeSummaryData,
  WorktreeSummaryProvenance,
  WorktreeSummarySnapshot,
} from '@canopy/desktop-shared/types';
import { createDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import {
  TEST_CONTAINER,
  TEST_CONTAINER_CREATED_AT,
  createLedgerServiceHarness,
  type LedgerServiceHarness,
} from './fixtures/in-process-ledger-store-client';
import {
  isPublishableSummarySnapshot,
  projectSummaryForLedger,
  publishResolvedSummarySnapshot,
  reportAbortedSummaryWrite,
  reportDroppedSummarySnapshots,
  reportInvalidSummarySnapshots,
  reportReplacedSummaryFile,
  reportStrippedSummaryProvenance,
  resolveSummaryScopeLedger,
  type PublishableSummarySnapshot,
  type SummaryPublicationHost,
  type SummaryScope,
} from '../summary-publication';
import {
  publishPendingSummarySnapshots,
  reconcileSummaryPublications,
  type SummaryReconciliationHost,
} from '../summary-reconciliation';

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

function summary(title: string): WorktreeSummaryData {
  return {
    title,
    description: `${title} in detail.`,
    highlights: [`${title} highlight`],
    generatedAt: '2026-09-30T12:00:00.000Z',
    turnCountAtGeneration: 3,
    lastFullRefreshAt: '2026-09-30T12:00:00.000Z',
    lastFullRefreshTurnCount: 3,
  };
}

function provenance(
  generationId: string,
  overrides: Partial<WorktreeSummaryProvenance> = {},
): WorktreeSummaryProvenance {
  return {
    generationId,
    harness: 'claude',
    model: 'claude-haiku',
    thinkingEffort: 'low',
    observedTaskKey: `helper:worktree-summary:workspace-1/worktree-1:${generationId}`,
    capturedAt: '2026-09-30T11:59:00.000Z',
    ledgerPublishable: true,
    ...overrides,
  };
}

function snapshot(
  snapshotId: string,
  title: string,
  snapshotProvenance?: WorktreeSummaryProvenance,
): WorktreeSummarySnapshot {
  return {
    snapshotId,
    summary: summary(title),
    ...(snapshotProvenance === undefined
      ? {}
      : { provenance: snapshotProvenance }),
  };
}

function publishable(
  value: WorktreeSummarySnapshot,
): PublishableSummarySnapshot {
  if (!isPublishableSummarySnapshot(value)) {
    throw new Error('Expected a publishable snapshot');
  }
  return value;
}

describe('Summary publication', () => {
  let harness: LedgerServiceHarness;
  let dispatcher: ReturnType<typeof createDesktopRuntime>;
  let state: {
    enabled: boolean;
    createdAt: string | null;
    history: WorktreeSummarySnapshot[];
  };
  let gaps: string[];
  let host: SummaryPublicationHost;
  let reconciliation: SummaryReconciliationHost;

  function summaryEntries(): LedgerEntrySearchItem[] {
    const scopes = harness.store.repository.listScopes();
    return scopes.flatMap(
      (scope) =>
        harness.store.repository.searchEntries({
          ledgerId: scope.scope.ledgerId,
          types: ['SUMMARY'],
          sort: 'created_desc',
        }).entries,
    );
  }

  beforeEach(() => {
    harness = createLedgerServiceHarness();
    dispatcher = createDesktopRuntime({
      services: filesystemServices,
      ledgerService: harness.service,
    });
    state = {
      enabled: true,
      createdAt: TEST_CONTAINER_CREATED_AT,
      history: [],
    };
    gaps = [];
    host = {
      isEnabled: (): boolean => state.enabled,
      dispatcher: (): ReturnType<SummaryPublicationHost['dispatcher']> =>
        dispatcher,
      registry: (): LedgerServiceHarness['bindings'] => harness.bindings,
      container: (projectId, worktreeId): LedgerContainer | null =>
        projectId === SCOPE.projectId && worktreeId === SCOPE.worktreeId
          ? TEST_CONTAINER
          : null,
      containerCreatedAt: (): Promise<string | null> =>
        Promise.resolve(state.createdAt),
      ledgerId: async (container, containerCreatedAt): Promise<string> =>
        (await harness.service.scopes.resolve(container, containerCreatedAt))
          .ledgerId,
      publishedKeys: (ledgerId, keys): Promise<string[]> =>
        harness.store.client.listReceiptKeys({
          ledgerId,
          operation: LEDGER_COMMAND_OPERATIONS.publishSummary,
          idempotencyKeys: keys,
        }),
      recordGap: (reason): void => {
        gaps.push(reason);
      },
    };
    reconciliation = {
      publication: host,
      listScopes: (): Promise<SummaryScope[]> => Promise.resolve([SCOPE]),
      readHistory: (): Promise<readonly WorktreeSummarySnapshot[]> =>
        Promise.resolve(state.history),
    };
  });

  afterEach(async () => {
    await dispatcher.shutdown();
    harness.dispose();
  });

  it('publishes a new snapshot once, authored by the helper that generated it', async () => {
    state.history = [snapshot('snapshot-1', 'Adds login', provenance('gen-1'))];

    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 1, pending: 0 });
    // Already published: a later pass finds its receipt and does nothing.
    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 0, pending: 0 });

    const [entry] = summaryEntries();
    expect(summaryEntries()).toHaveLength(1);
    expect(entry).toMatchObject({
      type: 'SUMMARY',
      status: 'INFO',
      title: 'Adds login',
      author: { kind: 'background' },
    });
    const ledgerId =
      harness.store.repository.listScopes()[0]?.scope.ledgerId ?? '';
    const detail = harness.store.repository.getEntry({
      ledgerId,
      entryId: entry?.entryId ?? '',
    });
    expect(detail.entry.owner).toEqual(detail.entry.author);
    // The details captured before the helper ran.
    expect(detail.entry.authorDetails).toMatchObject({
      harness: 'claude',
      model: 'claude-haiku',
      thinkingEffort: 'low',
    });
    expect(detail.entry.origin).toEqual({
      kind: 'summary',
      ledgerId,
      snapshotId: 'snapshot-1',
      generationId: 'gen-1',
      helperActorId: detail.entry.author.actorId,
      observedTaskId: 'helper:worktree-summary:workspace-1/worktree-1:gen-1',
    });
    // The publication binding ends with its command.
    expect(harness.bindings.revokeWhere(() => true)).toBe(0);
  });

  it('replays a publication whose response was lost to the same entry', async () => {
    const pending = publishable(
      snapshot('snapshot-1', 'Adds login', provenance('gen-1')),
    );
    state.history = [pending];
    harness.store.client.failNextAfterRunning(
      'publishSummary',
      new Error('response lost'),
    );

    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 0, pending: 1 });
    const scopeLedger = await resolveSummaryScopeLedger(SCOPE, host);
    if (scopeLedger === null) throw new Error('Expected a scope');
    // A pass that missed the receipt replays the keyed command.
    await expect(
      publishResolvedSummarySnapshot(scopeLedger, pending, host),
    ).resolves.toBe('published');

    expect(summaryEntries()).toHaveLength(1);
    expect(harness.store.repository.getStorageCounts().receipts).toBe(1);
  });

  it('reconciles a snapshot whose publication a crash left unfinished, exactly once', async () => {
    state.history = [
      snapshot('snapshot-1', 'Adds login', provenance('gen-1')),
      snapshot('snapshot-2', 'Adds logout', provenance('gen-2')),
    ];
    // The scope was never bound: the crash came before the first publication.
    expect(harness.store.repository.listScopes()).toEqual([]);

    await expect(reconcileSummaryPublications(reconciliation)).resolves.toEqual(
      { scopes: 1, published: 2, pending: 0 },
    );
    await expect(reconcileSummaryPublications(reconciliation)).resolves.toEqual(
      { scopes: 0, published: 0, pending: 0 },
    );

    expect(summaryEntries().map((entry) => entry.title)).toEqual([
      'Adds logout',
      'Adds login',
    ]);
  });

  it('never backfills snapshots written before the Ledger was on', async () => {
    state.history = [
      snapshot('snapshot-0', 'Before any provenance'),
      snapshot(
        'snapshot-1',
        'Generated with the Ledger off',
        provenance('gen-1', { ledgerPublishable: false }),
      ),
    ];

    await expect(reconcileSummaryPublications(reconciliation)).resolves.toEqual(
      { scopes: 0, published: 0, pending: 0 },
    );

    expect(harness.store.repository.listScopes()).toEqual([]);
  });

  it('does nothing while the Ledger is off', async () => {
    state.enabled = false;
    state.history = [snapshot('snapshot-1', 'Adds login', provenance('gen-1'))];

    await expect(reconcileSummaryPublications(reconciliation)).resolves.toEqual(
      { scopes: 0, published: 0, pending: 0 },
    );
    expect(harness.store.client.calls).toEqual([]);
  });

  it('skips a scope whose container is gone', async () => {
    state.createdAt = null;
    state.history = [snapshot('snapshot-1', 'Adds login', provenance('gen-1'))];

    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 0, pending: 0 });
    expect(harness.store.client.calls).toEqual([]);
  });

  it('keeps order: a failed publication holds back later snapshots', async () => {
    state.history = [
      snapshot('snapshot-1', 'Adds login', provenance('gen-1')),
      snapshot('snapshot-2', 'Adds logout', provenance('gen-2')),
    ];
    harness.store.client.failNext('publishSummary', new Error('busy'));

    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 0, pending: 2 });
    expect(summaryEntries()).toEqual([]);

    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 2, pending: 0 });
    expect(summaryEntries().map((entry) => entry.title)).toEqual([
      'Adds logout',
      'Adds login',
    ]);
  });

  it('reports and skips a snapshot the Ledger rejects', async () => {
    state.history = [
      // Nothing but a control character: the projection has no title left.
      snapshot('snapshot-1', '\u0007', provenance('gen-1')),
      snapshot('snapshot-2', 'Adds logout', provenance('gen-2')),
    ];

    await expect(
      publishPendingSummarySnapshots(SCOPE, reconciliation),
    ).resolves.toEqual({ published: 1, pending: 1 });

    expect(gaps).toEqual(['rejected: 1']);
    expect(summaryEntries().map((entry) => entry.title)).toEqual([
      'Adds logout',
    ]);
  });

  it('reports dropped snapshots that never published, by count only', async () => {
    state.history = [snapshot('snapshot-1', 'Adds login', provenance('gen-1'))];
    await publishPendingSummarySnapshots(SCOPE, reconciliation);

    await reportDroppedSummarySnapshots(
      SCOPE,
      ['snapshot-1', 'snapshot-unpublished'],
      host,
    );
    expect(gaps).toEqual(['aged_out: 1']);

    host = {
      ...host,
      publishedKeys: (): Promise<string[]> =>
        Promise.reject(new Error('storage unavailable')),
    };
    await reportDroppedSummarySnapshots(SCOPE, ['snapshot-1'], host);
    expect(gaps).toEqual(['aged_out: 1', 'aged_out_unverified: 1']);
  });

  it('reports a replaced summary file only while the Ledger is on', () => {
    reportReplacedSummaryFile(SCOPE, host);
    expect(gaps).toEqual(['journal_replaced: 1']);

    state.enabled = false;
    reportReplacedSummaryFile(SCOPE, host);
    reportReplacedSummaryFile({ projectId: 'other', worktreeId: 'wt' }, host);
    expect(gaps).toEqual(['journal_replaced: 1']);
  });

  it('reports an aborted summary write only while the Ledger is on', () => {
    reportAbortedSummaryWrite(SCOPE, 'unreadable', host);
    reportAbortedSummaryWrite(SCOPE, 'future_version', host);
    expect(gaps).toEqual([
      'journal_unreadable: 1',
      'journal_future_version: 1',
    ]);

    state.enabled = false;
    reportAbortedSummaryWrite(SCOPE, 'future_version', host);
    expect(gaps).toHaveLength(2);
  });

  it('reports invalid history entries a write dropped, by count only', () => {
    reportInvalidSummarySnapshots(SCOPE, 0, host);
    reportInvalidSummarySnapshots(SCOPE, 3, host);
    reportInvalidSummarySnapshots(
      { projectId: 'other', worktreeId: 'wt' },
      2,
      host,
    );
    expect(gaps).toEqual(['journal_entries_dropped: 3']);
  });

  it('reports stripped provenance of snapshots that never published, by count only', async () => {
    state.history = [snapshot('snapshot-1', 'Adds login', provenance('gen-1'))];
    await publishPendingSummarySnapshots(SCOPE, reconciliation);

    await reportStrippedSummaryProvenance(
      SCOPE,
      ['snapshot-1', 'snapshot-unpublished'],
      host,
    );
    await reportStrippedSummaryProvenance(SCOPE, [], host);
    expect(gaps).toEqual(['provenance_stripped: 1']);

    state.enabled = false;
    await reportStrippedSummaryProvenance(SCOPE, ['snapshot-2'], host);
    expect(gaps).toEqual([
      'provenance_stripped: 1',
      'provenance_stripped_unverified: 1',
    ]);
  });
});

describe('projectSummaryForLedger', () => {
  it('passes a short summary through unchanged', () => {
    expect(
      projectSummaryForLedger(
        publishable(snapshot('snapshot-1', 'Adds login', provenance('gen-1'))),
      ),
    ).toEqual({
      snapshotId: 'snapshot-1',
      generationId: 'gen-1',
      title: 'Adds login',
      content: 'Adds login in detail.',
      highlights: ['Adds login highlight'],
      sourceTruncated: false,
      observedTaskId: 'helper:worktree-summary:workspace-1/worktree-1:gen-1',
    });
  });

  it('keeps a long summary within the Ledger limits, with an ellipsis', () => {
    const long: WorktreeSummarySnapshot = {
      snapshotId: 'snapshot-1',
      summary: {
        ...summary('t'),
        // Astral characters are one code point but two UTF-16 units.
        title: '🚀'.repeat(150),
        description: 'd'.repeat(1_500),
        highlights: Array.from({ length: 7 }, (_unused, index) =>
          `${String(index)}`.padEnd(150, 'h'),
        ),
      },
      provenance: provenance('gen-1'),
    };

    const projected = projectSummaryForLedger(publishable(long));

    expect(Array.from(projected.title)).toHaveLength(100);
    expect(projected.title.endsWith('🚀…')).toBe(true);
    expect(Array.from(projected.content)).toHaveLength(1_000);
    expect(projected.highlights).toHaveLength(5);
    expect(
      projected.highlights?.every(
        (highlight) =>
          Array.from(highlight).length === 100 && highlight.endsWith('…'),
      ),
    ).toBe(true);
    expect(projected.sourceTruncated).toBe(true);
  });

  it('replaces control characters a Ledger field rejects', () => {
    const projected = projectSummaryForLedger(
      publishable({
        snapshotId: 'snapshot-1',
        summary: {
          ...summary('t'),
          title: 'Adds\tlogin\nflow',
          description: 'Line one\nLine two\u0000',
          highlights: ['One\ntwo'],
        },
        provenance: provenance('gen-1'),
      }),
    );

    expect(projected).toMatchObject({
      title: 'Adds login flow',
      content: 'Line one\nLine two',
      highlights: ['One two'],
      sourceTruncated: false,
    });
  });
});
