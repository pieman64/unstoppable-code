import type { LedgerPendingTitleRecord } from '@canopy/desktop-shared/node/ledger';
import type { LedgerContainer } from '@canopy/protocol/canopy-core';
import type { AgentModelConfig } from '@canopy/desktop-shared/types';
import { BACKGROUND_HELPER_PRIORITIES } from '../../lib/background-helper-queue';
import {
  schedulePendingTitleFromStore,
  setLedgerPendingTitleScheduler,
} from '../service';
import {
  PendingTitleOrchestrator,
  createPendingTitleSummaryGenerator,
  type PendingTitleEntryContext,
  type PendingTitleGenerationInput,
  type PendingTitleOrchestratorHost,
  type PendingTitleSummaryInvocation,
} from '../pending-titles';

const CONTAINER: LedgerContainer = {
  kind: 'code_worktree',
  workspaceId: 'workspace-1',
  worktreeId: 'worktree-1',
};

const ENTRY_ID = '00000000-0000-4000-8000-000000000101';
const LEDGER_ID = '00000000-0000-4000-8000-000000000201';
const NOW = Date.parse('2026-10-07T12:00:00.000Z');

const RECORD: LedgerPendingTitleRecord = {
  entryId: ENTRY_ID,
  ledgerId: LEDGER_ID,
  createdAt: new Date(NOW).toISOString(),
  attempts: 0,
  lastAttemptAt: null,
};

describe('pending-title service scheduling', () => {
  it('reads and schedules only a matching provisional-title marker after commit', async () => {
    const scheduled: LedgerPendingTitleRecord[] = [];
    let reads = 0;
    setLedgerPendingTitleScheduler((record): void => {
      scheduled.push(record);
    });
    const store = {
      listPendingTitles: (): Promise<LedgerPendingTitleRecord[]> => {
        reads += 1;
        return Promise.resolve([RECORD]);
      },
    };

    try {
      await schedulePendingTitleFromStore(
        store,
        LEDGER_ID,
        ENTRY_ID,
        undefined,
      );
      expect(scheduled).toEqual([RECORD]);
      expect(reads).toBe(1);

      await schedulePendingTitleFromStore(
        store,
        LEDGER_ID,
        ENTRY_ID,
        'User supplied title',
      );
      expect(reads).toBe(1);
    } finally {
      setLedgerPendingTitleScheduler(undefined);
    }
  });
});

interface PendingTitleChange {
  readonly container: LedgerContainer;
  readonly entryId: string;
  readonly revision: number;
  readonly titleResolved: true;
}

interface Harness {
  readonly host: PendingTitleOrchestratorHost;
  readonly orchestrator: PendingTitleOrchestrator;
  readonly queued: Array<() => Promise<void>>;
  readonly priorities: number[];
  readonly attempts: number[];
  readonly resolutions: Array<{
    readonly entryId: string;
    readonly title: string | null;
  }>;
  readonly changes: PendingTitleChange[];
  readonly setDatabaseMayExist: (value: boolean) => void;
  readonly setEnabled: (value: boolean) => void;
  readonly setNow: (value: number) => void;
}

interface HarnessOptions {
  readonly records?: readonly LedgerPendingTitleRecord[];
  readonly generateTitle?: (
    input: PendingTitleGenerationInput,
  ) => Promise<string | null>;
  readonly readEntry?: (
    record: LedgerPendingTitleRecord,
  ) => Promise<PendingTitleEntryContext | null>;
  readonly initialRevision?: number;
  readonly generationTimeoutMs?: number;
}

function createHarness(options: HarnessOptions = {}): Harness {
  let pendingRecords = [...(options.records ?? [RECORD])];
  const revision = options.initialRevision ?? 1;
  let databaseMayExist = true;
  let enabled = true;
  let now = NOW;
  const queued: Array<() => Promise<void>> = [];
  const priorities: number[] = [];
  const attempts: number[] = [];
  const resolutions: Array<{
    readonly entryId: string;
    readonly title: string | null;
  }> = [];
  const changes: PendingTitleChange[] = [];

  const host: PendingTitleOrchestratorHost = {
    databaseMayExist: (): Promise<boolean> => Promise.resolve(databaseMayExist),
    isEnabled: (): boolean => enabled,
    listPendingTitles: (): Promise<LedgerPendingTitleRecord[]> =>
      Promise.resolve([...pendingRecords]),
    recordPendingTitleAttempt: (
      input,
    ): Promise<LedgerPendingTitleRecord | null> => {
      const record = pendingRecords.find(
        (candidate) => candidate.entryId === input.entryId,
      );
      if (record === undefined) return Promise.resolve(null);
      const next = {
        ...record,
        attempts: record.attempts + 1,
        lastAttemptAt: new Date(NOW).toISOString(),
      };
      attempts.push(next.attempts);
      pendingRecords = pendingRecords.map((candidate) =>
        candidate.entryId === next.entryId ? next : candidate,
      );
      return Promise.resolve(next);
    },
    readEntry: (record): Promise<PendingTitleEntryContext | null> =>
      options.readEntry?.(record) ??
      Promise.resolve({
        container: CONTAINER,
        entry: {
          entryId: record.entryId,
          content: 'Implement the durable retry.',
        },
        titlePending: true,
      }),
    resolvePendingTitle: (input) => {
      resolutions.push(input);
      const found = pendingRecords.some(
        (record) => record.entryId === input.entryId,
      );
      if (!found) return Promise.resolve({ resolved: false, entry: null });
      pendingRecords = pendingRecords.filter(
        (record) => record.entryId !== input.entryId,
      );
      return Promise.resolve({
        resolved: true,
        entry: {
          entryId: input.entryId,
          revision,
          scope: { container: CONTAINER },
        },
      });
    },
  };

  const orchestrator = new PendingTitleOrchestrator({
    host,
    generateTitle:
      options.generateTitle ??
      ((): Promise<string | null> => Promise.resolve('Retry pending title')),
    enqueue: (task, priority): Promise<void> => {
      priorities.push(priority);
      queued.push(task);
      return Promise.resolve();
    },
    notifyResolved: (change): void => {
      changes.push(change);
    },
    now: (): number => now,
    sweepIntervalMs: 60_000,
    generationTimeoutMs: options.generationTimeoutMs ?? 1_000,
  });

  return {
    host,
    orchestrator,
    queued,
    priorities,
    attempts,
    resolutions,
    changes,
    setDatabaseMayExist: (value): void => {
      databaseMayExist = value;
    },
    setEnabled: (value): void => {
      enabled = value;
    },
    setNow: (value): void => {
      now = value;
    },
  };
}

async function runNext(harness: Harness): Promise<void> {
  const task = harness.queued.shift();
  if (task === undefined) throw new Error('Expected a queued title task');
  await task();
}

describe('Ledger pending titles', () => {
  it('generates from the current entry on the chat-metadata queue and broadcasts resolution at its committed revision', async () => {
    const harness = createHarness({ initialRevision: 1 });

    harness.orchestrator.enqueue(RECORD);
    expect(harness.priorities).toEqual([
      BACKGROUND_HELPER_PRIORITIES.chatMetadata,
    ]);
    harness.orchestrator.enqueue(RECORD);
    expect(harness.queued).toHaveLength(1);
    await runNext(harness);

    expect(harness.attempts).toEqual([1]);
    expect(harness.resolutions).toEqual([
      { entryId: ENTRY_ID, title: 'Retry pending title' },
    ]);
    expect(harness.changes).toEqual([
      {
        container: CONTAINER,
        ledgerId: LEDGER_ID,
        entryId: ENTRY_ID,
        revision: 1,
        titleResolved: true,
      },
    ]);
  });

  it('resolves helper fallback immediately with a null title', async () => {
    const harness = createHarness({
      generateTitle: (): Promise<string | null> => Promise.resolve(null),
    });

    harness.orchestrator.enqueue(RECORD);
    await runNext(harness);
    expect(harness.attempts).toEqual([1]);
    expect(harness.resolutions).toEqual([{ entryId: ENTRY_ID, title: null }]);
    expect(harness.changes).toEqual([
      {
        container: CONTAINER,
        ledgerId: LEDGER_ID,
        entryId: ENTRY_ID,
        revision: 1,
        titleResolved: true,
      },
    ]);
  });

  it('retries thrown helper failures up to three persisted attempts, then resolves null at the same revision', async () => {
    const harness = createHarness({
      generateTitle: (): Promise<string | null> =>
        Promise.reject(new Error('helper unavailable')),
    });

    harness.orchestrator.enqueue(RECORD);
    await runNext(harness);
    expect(harness.resolutions).toEqual([]);

    await harness.orchestrator.sweep();
    await runNext(harness);
    expect(harness.resolutions).toEqual([]);

    await harness.orchestrator.sweep();
    await runNext(harness);

    expect(harness.attempts).toEqual([1, 2, 3]);
    expect(harness.resolutions).toEqual([{ entryId: ENTRY_ID, title: null }]);
    expect(harness.changes).toEqual([
      {
        container: CONTAINER,
        ledgerId: LEDGER_ID,
        entryId: ENTRY_ID,
        revision: 1,
        titleResolved: true,
      },
    ]);
  });

  it('sweep releases a persisted marker that already exhausted its attempts', async () => {
    const exhausted = { ...RECORD, attempts: 3 };
    const harness = createHarness({ records: [exhausted] });

    await harness.orchestrator.sweep();

    expect(harness.attempts).toEqual([]);
    expect(harness.resolutions).toEqual([{ entryId: ENTRY_ID, title: null }]);
  });

  it('releases a marker older than 24 hours without invoking the helper', async () => {
    let generated = false;
    const staleRecord = {
      ...RECORD,
      createdAt: new Date(NOW - 24 * 60 * 60 * 1000 - 1).toISOString(),
    };
    const harness = createHarness({
      records: [staleRecord],
      generateTitle: (): Promise<string | null> => {
        generated = true;
        return Promise.resolve('Should not be generated');
      },
    });

    harness.orchestrator.enqueue(staleRecord);
    await runNext(harness);

    expect(generated).toBe(false);
    expect(harness.attempts).toEqual([]);
    expect(harness.resolutions).toEqual([{ entryId: ENTRY_ID, title: null }]);
  });

  it('neither probes nor opens the store while the Ledger is off, and releases a stale marker once it is on', async () => {
    const staleRecord = {
      ...RECORD,
      createdAt: new Date(NOW - 24 * 60 * 60 * 1000).toISOString(),
    };
    let generated = false;
    const harness = createHarness({
      records: [staleRecord],
      generateTitle: (): Promise<string | null> => {
        generated = true;
        return Promise.resolve('Unexpected');
      },
    });
    const databaseMayExist = jest.spyOn(harness.host, 'databaseMayExist');
    const listPendingTitles = jest.spyOn(harness.host, 'listPendingTitles');
    harness.setEnabled(false);

    await harness.orchestrator.sweep();

    expect(databaseMayExist).not.toHaveBeenCalled();
    expect(listPendingTitles).not.toHaveBeenCalled();
    expect(harness.resolutions).toEqual([]);

    harness.setEnabled(true);
    await harness.orchestrator.sweep();

    expect(generated).toBe(false);
    expect(harness.attempts).toEqual([]);
    expect(harness.resolutions).toEqual([{ entryId: ENTRY_ID, title: null }]);
  });

  it('waits out the startup delay before its first sweep, then sweeps every interval', async () => {
    jest.useFakeTimers();
    const harness = createHarness();
    const databaseMayExist = jest.spyOn(harness.host, 'databaseMayExist');
    try {
      harness.orchestrator.start();
      await jest.advanceTimersByTimeAsync(15_000 - 1);
      expect(databaseMayExist).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      expect(databaseMayExist).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(60_000);
      expect(databaseMayExist).toHaveBeenCalledTimes(2);
    } finally {
      await harness.orchestrator.shutdown();
      jest.useRealTimers();
    }
  });

  it('expires a marker during a helper-queue backlog even when its queued task has not started', async () => {
    let generated = false;
    const harness = createHarness({
      generateTitle: (): Promise<string | null> => {
        generated = true;
        return Promise.resolve('Must not outlive its marker');
      },
    });
    harness.orchestrator.enqueue(RECORD);
    expect(harness.queued).toHaveLength(1);

    harness.setNow(NOW + 24 * 60 * 60 * 1000 + 1);
    await harness.orchestrator.sweep();

    expect(generated).toBe(false);
    expect(harness.resolutions).toEqual([{ entryId: ENTRY_ID, title: null }]);
    expect(harness.queued).toHaveLength(1);
  });

  it('does not open the store during startup when no database exists', async () => {
    const harness = createHarness();
    const listPendingTitles = jest.spyOn(harness.host, 'listPendingTitles');
    harness.setDatabaseMayExist(false);

    harness.orchestrator.start();
    await harness.orchestrator.sweep();

    expect(listPendingTitles).not.toHaveBeenCalled();
    expect(harness.queued).toEqual([]);
    await harness.orchestrator.shutdown();
  });

  it('drains active storage work on shutdown and never generates after shutdown starts', async () => {
    let finishRead: ((context: PendingTitleEntryContext) => void) | undefined;
    let readStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    const harness = createHarness({
      readEntry: (): Promise<PendingTitleEntryContext> =>
        new Promise((resolve) => {
          finishRead = resolve;
          readStarted?.();
        }),
    });
    harness.orchestrator.enqueue(RECORD);
    const running = runNext(harness);
    await started;

    let shutdownFinished = false;
    const shuttingDown = harness.orchestrator.shutdown().then(() => {
      shutdownFinished = true;
    });
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);

    finishRead?.({
      container: CONTAINER,
      entry: { entryId: ENTRY_ID, content: 'A title to generate' },
      titlePending: true,
    });
    await shuttingDown;
    await running;

    expect(shutdownFinished).toBe(true);
    expect(harness.attempts).toEqual([1]);
    expect(harness.resolutions).toEqual([]);
  });

  it('does not wait for a hung helper at shutdown or let its late result touch storage', async () => {
    let completeProvider: ((title: string | null) => void) | undefined;
    let providerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const harness = createHarness({
      generationTimeoutMs: 60_000,
      generateTitle: (): Promise<string | null> =>
        new Promise((resolve) => {
          completeProvider = resolve;
          providerStarted?.();
        }),
    });
    harness.orchestrator.enqueue(RECORD);
    const running = runNext(harness);
    await started;

    await harness.orchestrator.shutdown();
    completeProvider?.('Late title');
    await running;

    expect(harness.resolutions).toEqual([]);
  });

  it('releases a timed-out helper marker once, holds the queue slot until the provider settles, and ignores its late result', async () => {
    jest.useFakeTimers();
    let completeProvider: ((title: string | null) => void) | undefined;
    let providerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const harness = createHarness({
      generationTimeoutMs: 1_000,
      generateTitle: (): Promise<string | null> =>
        new Promise((resolve) => {
          completeProvider = resolve;
          providerStarted?.();
        }),
    });

    try {
      harness.orchestrator.enqueue(RECORD);
      let settled = false;
      const running = runNext(harness).then((): void => {
        settled = true;
      });
      await started;
      await jest.advanceTimersByTimeAsync(1_000);

      // The marker is released at the deadline, so the scope's sync goes on,
      // but the task keeps its queue slot while the provider still runs.
      expect(harness.resolutions).toEqual([{ entryId: ENTRY_ID, title: null }]);
      expect(settled).toBe(false);

      completeProvider?.('Late title');
      await running;
      expect(settled).toBe(true);
      expect(harness.resolutions).toEqual([{ entryId: ENTRY_ID, title: null }]);
      expect(harness.changes).toEqual([
        {
          container: CONTAINER,
          ledgerId: LEDGER_ID,
          entryId: ENTRY_ID,
          revision: 1,
          titleResolved: true,
        },
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('passes saved summary settings, workspace cwd and an explicit authoritative owner to the real helper seam', async () => {
    const calls: PendingTitleSummaryInvocation[] = [];
    const modelConfig: AgentModelConfig = {
      thinkingLevel: 'medium',
      speed: 'fast',
      fastMode: true,
    };
    const generateTitle = createPendingTitleSummaryGenerator({
      readSettings: () =>
        Promise.resolve({
          model: 'summary-model',
          thinkingLevel: 'low',
          modelConfig,
        }),
      resolveScope: () => ({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        cwd: '/workspace/worktrees/worktree-1',
      }),
      resolveWorkOwner: () =>
        Promise.resolve({
          kind: 'organization',
          organizationId: 'organization-1',
        }),
      generateChatSummary: (_text, invocation): Promise<{ text: string }> => {
        calls.push(invocation);
        return Promise.resolve({
          text: 'Summarize the durable retry behavior',
        });
      },
    });

    await expect(
      generateTitle({
        record: RECORD,
        container: CONTAINER,
        entry: { entryId: ENTRY_ID, content: 'The full finding.' },
      }),
    ).resolves.toBe('Summarize the durable retry behavior');

    expect(calls).toEqual([
      {
        projectId: 'workspace-1',
        cwd: '/workspace/worktrees/worktree-1',
        observabilityTaskKey: `helper:ledger-title:${LEDGER_ID}/${ENTRY_ID}`,
        model: 'summary-model',
        thinkingLevel: 'low',
        modelConfig,
        workOwner: { kind: 'organization', organizationId: 'organization-1' },
      },
    ]);
  });

  it('pins an unresolved work-owner authority to null rather than re-reading live selection', async () => {
    const calls: PendingTitleSummaryInvocation[] = [];
    const generateTitle = createPendingTitleSummaryGenerator({
      readSettings: () =>
        Promise.resolve({
          model: 'summary-model',
          thinkingLevel: 'low',
        }),
      resolveScope: () => ({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        cwd: '/workspace/worktrees/worktree-1',
      }),
      resolveWorkOwner: () => Promise.resolve(undefined),
      generateChatSummary: (_text, invocation): Promise<{ text: string }> => {
        calls.push(invocation);
        return Promise.resolve({ text: 'Scoped title' });
      },
    });

    await generateTitle({
      record: RECORD,
      container: CONTAINER,
      entry: { entryId: ENTRY_ID, content: 'A finding.' },
    });

    expect(calls[0]?.workOwner).toBeNull();
  });

  it("keeps a global (workflow) entry's title without a task to generate in", async () => {
    const generateChatSummary = jest.fn(() =>
      Promise.resolve({ text: 'Never asked' }),
    );
    const resolveWorkOwner = jest.fn(() => Promise.resolve(undefined));
    const generateTitle = createPendingTitleSummaryGenerator({
      readSettings: () => Promise.resolve({ model: 'summary-model' }),
      resolveScope: () => null,
      resolveWorkOwner,
      generateChatSummary,
    });

    await expect(
      generateTitle({
        record: RECORD,
        container: { kind: 'global', owner: { kind: 'personal' } },
        entry: { entryId: ENTRY_ID, content: 'A finding.' },
      }),
    ).resolves.toBeNull();
    expect(resolveWorkOwner).not.toHaveBeenCalled();
    expect(generateChatSummary).not.toHaveBeenCalled();
  });

  it('does not treat the helper fallback as a generated title', async () => {
    const generateTitle = createPendingTitleSummaryGenerator({
      readSettings: () =>
        Promise.resolve({
          model: 'summary-model',
          thinkingLevel: 'low',
        }),
      resolveScope: () => ({
        projectId: 'workspace-1',
        worktreeId: 'worktree-1',
        cwd: '/workspace/worktrees/worktree-1',
      }),
      resolveWorkOwner: () => Promise.resolve(undefined),
      generateChatSummary: (): Promise<{
        text: string;
        fallback: { reason: string };
      }> =>
        Promise.resolve({
          text: 'A finding.',
          fallback: { reason: 'provider failed' },
        }),
    });

    await expect(
      generateTitle({
        record: RECORD,
        container: CONTAINER,
        entry: { entryId: ENTRY_ID, content: 'A finding.' },
      }),
    ).resolves.toBeNull();
  });
});
