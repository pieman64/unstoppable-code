import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import type { OperationReceiptInput } from '@canopy/core-runtime/node/operations';
import type { SummaryScope } from '@canopy/core-runtime/node/summary';
import {
  CoreSummaryGetResultSchema,
  CoreSummaryOperationRefSchema,
  type CoreSummaryGetResult,
  type CoreSummaryOperationRef,
  type OperationOrigin,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import type {
  WorktreeSummaryData,
  WorktreeSummaryFile,
} from '@canopy/desktop-shared/types';
import { createCoreSummaryAdapter } from '../core-summary-adapter';

const summary: WorktreeSummaryData = {
  title: 'Search follows commits',
  description: 'Archive search reindexes on commit.',
  highlights: ['Archives reindex', 'Summaries resume'],
  generatedAt: '2026-11-05T12:00:00.000Z',
  turnCountAtGeneration: 7,
  lastFullRefreshAt: '2026-11-05T11:00:00.000Z',
  lastFullRefreshTurnCount: 5,
};

const file: WorktreeSummaryFile = {
  version: 2,
  summary,
  history: [
    { snapshotId: 'snap-1', summary: { ...summary, turnCountAtGeneration: 3 } },
    { snapshotId: 'snap-2', summary },
  ],
};

const scope = { workspaceId: 'w1', worktreeId: 't1' };

const context: CanopyHandlerContext = {
  requestId: 'request-1',
  caller: {
    principalId: 'portal:abc',
    clientInstanceId: 'test',
    authorityId: 'local-desktop',
    interfaceKind: 'desktop',
    grants: ['core.summary.read', 'core.summary.write'],
  },
  metadata: { idempotencyKey: 'k1' },
  signal: new AbortController().signal,
};

const queued: OperationRecord = {
  operationId: 'op-1',
  kind: 'core.summary.regenerate',
  status: 'queued',
} as unknown as OperationRecord;

interface RegenerateCall {
  scope: SummaryScope;
  origin: OperationOrigin;
  receipt: OperationReceiptInput;
}

function harness(stored: WorktreeSummaryFile | null): {
  get(params: unknown): Promise<CoreSummaryGetResult>;
  regenerate(params: unknown): Promise<CoreSummaryOperationRef>;
  calls: RegenerateCall[];
  admitted: RegenerateCall[];
  captured: (WorktreeSummaryData | null)[];
  setPending(pending: boolean): void;
} {
  let pending = false;
  const calls: RegenerateCall[] = [];
  const admitted: RegenerateCall[] = [];
  const captured: (WorktreeSummaryData | null)[] = [];
  const adapter = createCoreSummaryAdapter(
    { readSummaryFile: () => Promise.resolve(stored) },
    {
      schedule: () => ({
        isPending: (): boolean => pending,
        regenerate: async (
          requestScope,
          origin,
          receipt,
          precondition,
        ): Promise<OperationRecord> => {
          const call = { scope: requestScope, origin, receipt };
          calls.push(call);
          await precondition?.();
          admitted.push(call);
          return queued;
        },
      }),
      captureLegacy: (value) => {
        captured.push(value);
      },
    },
  );
  const get = adapter.queries?.['core.summary.get'];
  const regenerate = adapter.instructions?.['core.summary.regenerate'];
  if (!get || !regenerate) throw new Error('Summary handlers are missing');
  return {
    get: (params) => Promise.resolve(get(params as never, context)),
    regenerate: (params) =>
      Promise.resolve(regenerate(params as never, context)),
    calls,
    admitted,
    captured,
    setPending: (value) => {
      pending = value;
    },
  };
}

async function rejection(
  promise: Promise<unknown>,
): Promise<CanopyOperationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error;
    throw error;
  }
  throw new Error('Expected a rejection');
}

describe('core summary operations (CAN-4114)', () => {
  it('projects the latest summary as a ready core summary', async () => {
    const result = await harness(file).get({ scope });
    expect(result).toEqual({
      summaryId: 'snap-2',
      scope,
      sourceRevision: 'turns:7',
      content: stableStringify({
        title: summary.title,
        description: summary.description,
        highlights: summary.highlights,
      }),
      state: 'ready',
      revision: Date.parse(summary.generatedAt),
      generatedAt: summary.generatedAt,
    });
    expect(CoreSummaryGetResultSchema.safeParse(result).success).toBe(true);
  });

  it('reports a pending generation as stale and no file as missing', async () => {
    const pending = harness(file);
    pending.setPending(true);
    expect((await pending.get({ scope })).state).toBe('stale');
    expect(await harness(null).get({ scope })).toMatchObject({
      state: 'missing',
      sourceRevision: 'none',
      content: '',
      revision: 0,
      generatedAt: null,
    });
  });

  it('refuses a regenerate against a stale source revision', async () => {
    const h = harness(file);
    const error = await rejection(
      h.regenerate({
        scope,
        expectedSourceRevision: 'turns:3',
        _meta: { idempotencyKey: 'k1' },
      }),
    );
    expect(error.payload).toMatchObject({
      kind: 'conflict',
      code: 'core.summary.revisionConflict',
    });
    expect(h.admitted).toHaveLength(0);
  });

  it("regenerates through the core schedule with the caller's key", async () => {
    const h = harness(file);
    const result = await h.regenerate({
      scope,
      expectedSourceRevision: 'turns:7',
      _meta: { idempotencyKey: 'k1' },
    });
    await rejection(
      h.regenerate({
        scope,
        expectedSourceRevision: 'turns:8',
        _meta: { idempotencyKey: 'k1' },
      }),
    );
    const [first, second] = h.calls;
    expect(first?.origin).toEqual({
      kind: 'client',
      sourceId: 'portal:abc',
      context: { mode: 'full' },
    });
    expect(first?.receipt.idempotencyKey).toBe('k1');
    expect(second?.receipt.fingerprint).not.toBe(first?.receipt.fingerprint);
    expect(CoreSummaryOperationRefSchema.safeParse(result).success).toBe(true);
  });

  it('refuses a target or provider profile this host cannot honour', async () => {
    const h = harness(file);
    for (const extra of [
      { targetId: 't2' },
      { providerProfile: { model: 'x' } },
    ]) {
      const error = await rejection(
        h.regenerate({
          scope,
          expectedSourceRevision: 'turns:7',
          ...extra,
          _meta: { idempotencyKey: 'k1' },
        }),
      );
      expect(error.payload.kind).toBe('capability_unavailable');
    }
    expect(h.calls).toHaveLength(0);
  });

  it('hands the IPC projection the stored summary unchanged', async () => {
    const h = harness(file);
    await h.get({ scope });
    expect(h.captured).toEqual([summary]);
  });
});
