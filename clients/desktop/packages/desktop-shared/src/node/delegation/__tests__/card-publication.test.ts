import type { AgentDelegationSnapshot } from '@canopy/protocol/delegation';
import {
  CardStateDraftSchema,
  CardStateV1Schema,
  type CardStateDraft,
} from '@canopy/protocol/canopy-core';
import { createDelegationRunState } from '../lifecycle';
import {
  decodeStoredDelegationV3,
  type StoredDelegationV3,
  type StoredCardPublication,
} from '../record-v3';
import { admissibleCardDraft } from '../card-state-rules';
import {
  prepareCardPublication,
  materializeCardDraft,
  setCardPromptAmended,
  classifyCardDescriptor,
} from '../card-publication';

const id = '00000000-0000-4000-8000-000000000003';
const pending: CardStateDraft = {
  version: 2,
  status: 'pending',
  outputTruncated: false,
};
const running: CardStateDraft = {
  version: 2,
  status: 'running',
  outputTruncated: false,
};
const snapshot: AgentDelegationSnapshot = {
  delegationId: id,
  runGeneration: 1,
  status: 'pending',
  outputTruncated: false,
};
const route: NonNullable<CardStateDraft['routeSnapshot']> = {
  selectedModelId: 'model',
  runtimeModelId: 'runtime-model',
  harnessId: 'harness',
  runtimeKind: 'runtime',
  runnerRegistrationId: 'runner',
  runtimeVersion: '1',
  adapterVersion: '1',
  modelSource: 'catalog',
  providerType: 'provider',
  assignmentRevision: 'assignment',
  billingAuthority: 'provider',
  aiCreditsRouted: false,
  capabilities: [],
  supportedThinkingLevels: [],
  capabilitySnapshotHash: 'snapshot',
  capabilityGeneration: 1,
  policyRevision: 'policy',
};
function record(pair?: StoredCardPublication): StoredDelegationV3 {
  return decodeStoredDelegationV3({
    version: 3,
    parent: {
      harnessId: 'harness',
      projectId: 'project',
      worktreeId: 'worktree',
      chatId: 'chat',
      sessionKey: 'session',
      turnId: 'turn',
      toolCallId: 'call',
      runtimeGeneration: 1,
      depth: 0,
    },
    task: {
      modelId: 'model',
      description: 'task',
      prompt: 'original',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    callKey: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: 100,
    state: createDelegationRunState(id, 1),
    launch: {
      version: 1,
      delegationId: id,
      launchKey: 'a'.repeat(64),
      runGeneration: 1,
      phase: 'reserved',
    },
    delivery: { status: 'unclaimed' },
    readMetadata: {
      originAt: 100,
      lastActivityAt: 100,
      current: {
        store: 'stream',
        target: {
          kind: 'delegation',
          chatId: 'chat',
          delegationId: id,
          runGeneration: 1,
        },
      },
    },
    registration: {
      runGeneration: 1,
      createdAt: 100,
      store: 'stream',
      origin: { kind: 'launch' },
      executionMode: 'background',
    },
    receipts: { commandReceipts: [], stopReceipts: [] },
    ...(pair === undefined ? {} : { cardPublication: pair }),
  });
}
function pair(
  draft: CardStateDraft,
  cardRevision = 4,
  promptAmended = false,
): StoredCardPublication {
  return { runGeneration: 1, cardRevision, promptAmended, draft };
}
function committed(
  previous: StoredDelegationV3,
  next: AgentDelegationSnapshot,
  candidate = previous,
): StoredDelegationV3 {
  const cardPublication = prepareCardPublication(
    previous,
    candidate,
    snapshot,
    next,
  );
  return {
    ...candidate,
    ...(cardPublication === undefined ? {} : { cardPublication }),
  };
}
function settled(value: StoredDelegationV3): StoredDelegationV3 {
  return {
    ...value,
    latestResult: {
      runGeneration: 1,
      resultIndex: 1,
      status: 'completed',
      settledAt: 200,
    },
  };
}

describe('durable card preparation', () => {
  it('allocates first same-generation draft but omits fresh generations', () => {
    const old = record();
    expect(prepareCardPublication(old, old, snapshot, snapshot)).toEqual({
      runGeneration: 1,
      cardRevision: 1,
      promptAmended: false,
      draft: pending,
    });
    expect(
      prepareCardPublication(undefined, old, undefined, snapshot),
    ).toBeUndefined();
    const next = { ...old, state: createDelegationRunState(id, 2) };
    expect(
      prepareCardPublication(old, next, snapshot, {
        ...snapshot,
        runGeneration: 2,
      }),
    ).toBeUndefined();
  });
  it('retains the identical full pair for unchanged and live-only changes', () => {
    const old = record(pair(pending));
    expect(prepareCardPublication(old, old, snapshot, snapshot)).toEqual({
      runGeneration: 1,
      cardRevision: 4,
      promptAmended: false,
      draft: pending,
    });
    expect(
      prepareCardPublication(old, old, snapshot, {
        ...snapshot,
        partialText: 'text',
        approvalPending: true,
        phase: 'running',
        queue: {
          id: 'default',
          name: 'Default',
          position: 2,
          waitingFor: 'queue',
          running: 1,
          waiting: 3,
          limit: 1,
        },
        control: { operationId: 'op', operation: 'steer', status: 'accepted' },
      }),
    ).toEqual(old.cardPublication);
  });
  it('allocates exactly once for durable metadata without mutating its inputs', () => {
    const old = record(pair(pending));
    const before = JSON.stringify(old);
    const updated = committed(old, { ...snapshot, workspaceDiscarded: true });
    expect(updated.cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 5,
      promptAmended: false,
      draft: { ...pending, workspaceDiscarded: true },
    });
    expect(JSON.stringify(old)).toBe(before);
  });
  it('latches two queued amendments separately and preserves an unchanged amended pair', () => {
    const old = record(pair(pending));
    const first = committed(
      old,
      snapshot,
      setCardPromptAmended(
        { ...old, task: { ...old.task, prompt: 'first' } },
        snapshot,
      ),
    );
    expect(first.cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 5,
      promptAmended: true,
      draft: pending,
    });
    expect(materializeCardDraft(first)).toEqual({
      ...pending,
      prompt: 'first',
    });
    const second = committed(
      first,
      snapshot,
      setCardPromptAmended(
        { ...first, task: { ...first.task, prompt: 'second' } },
        snapshot,
      ),
    );
    expect(second.cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 6,
      promptAmended: true,
      draft: pending,
    });
    expect(materializeCardDraft(second)).toEqual({
      ...pending,
      prompt: 'second',
    });
    expect(committed(second, snapshot).cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 6,
      promptAmended: true,
      draft: pending,
    });
  });
  it('explicitly seeds the first amendment but never infers it from task text', () => {
    const old = record();
    const amended = setCardPromptAmended(
      { ...old, task: { ...old.task, prompt: 'first' } },
      snapshot,
    );
    expect(committed(old, snapshot, amended).cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 1,
      promptAmended: true,
      draft: pending,
    });
    expect(
      materializeCardDraft(
        committed(old, snapshot, {
          ...old,
          task: { ...old.task, prompt: 'different' },
        }),
      ),
    ).toEqual(pending);
  });
  it('locks prompt presence/value through running and reopen despite pending projection', () => {
    const old = record(pair(pending, 4, true));
    const active = committed(old, { ...snapshot, status: 'running' });
    expect(active.cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 5,
      promptAmended: true,
      draft: running,
    });
    const reopened = decodeStoredDelegationV3(
      JSON.parse(JSON.stringify(active)),
    );
    const changed = {
      ...reopened,
      task: { ...old.task, prompt: 'not admitted' },
    };
    expect(() => committed(reopened, snapshot, changed)).toThrow(
      'locked prompt',
    );
    expect(committed(reopened, snapshot).cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 5,
      promptAmended: true,
      draft: running,
    });
  });
  it('keeps requested-model and prepared-route fallback sources across reopen', () => {
    const old = record(pair({ ...pending, requestedModelId: 'requested' }));
    const prepared = committed(old, { ...snapshot, routeSnapshot: route });
    expect(prepared.cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 5,
      promptAmended: false,
      draft: {
        ...pending,
        requestedModelId: 'requested',
        routeSnapshot: route,
      },
    });
    const reopened = decodeStoredDelegationV3(
      JSON.parse(JSON.stringify(prepared)),
    );
    expect(committed(reopened, snapshot).cardPublication).toEqual(
      prepared.cardPublication,
    );
  });
  it('keeps fitted truncation when the canonical locator first commits', () => {
    const old = record(pair(running));
    const bulky = {
      ...snapshot,
      status: 'running',
      childDelegationIds: Array.from({ length: 65 }, () => 'x'),
    } satisfies AgentDelegationSnapshot;
    const fitted = committed(old, bulky);
    expect(fitted.cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 5,
      promptAmended: false,
      draft: {
        ...running,
        outputTruncated: true,
        childDelegationIds: Array.from({ length: 64 }, () => 'x'),
      },
    });
    const canonical = committed(
      fitted,
      { ...bulky, status: 'completed' },
      settled(fitted),
    );
    expect(canonical.cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 6,
      promptAmended: false,
      draft: {
        ...running,
        outputTruncated: true,
        childDelegationIds: Array.from({ length: 64 }, () => 'x'),
        detailOmitted: true,
      },
    });
    const smaller = committed(canonical, {
      ...snapshot,
      status: 'completed',
      childDelegationIds: [],
      workspaceDiscarded: true,
    });
    expect(smaller.cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 7,
      promptAmended: false,
      draft: {
        ...running,
        outputTruncated: true,
        childDelegationIds: [],
        workspaceDiscarded: true,
        detailOmitted: true,
      },
    });
  });
  it('preserves fitted execution truncation after settle and smaller workspace/control updates', () => {
    const fitted: CardStateDraft = {
      ...running,
      outputTruncated: true,
      childDelegationIds: ['x'],
    };
    const old = settled(record(pair(fitted)));
    const next = committed(old, {
      ...snapshot,
      status: 'completed',
      childDelegationIds: [],
      workspaceDiscarded: true,
      control: { operationId: 'op', operation: 'discard', status: 'completed' },
    });
    expect(next.cardPublication).toEqual({
      runGeneration: 1,
      cardRevision: 5,
      promptAmended: false,
      draft: {
        ...running,
        outputTruncated: true,
        childDelegationIds: [],
        workspaceDiscarded: true,
        control: {
          operationId: 'op',
          operation: 'discard',
          status: 'completed',
        },
      },
    });
    expect(
      admissibleCardDraft(fitted, materializeCardDraft(next) ?? pending, true),
    ).toBe(true);
  });
  it('fits post-settle detail without inventing execution truncation, and latches omission', () => {
    const old = settled(record(pair(running)));
    const next = committed(old, {
      ...snapshot,
      status: 'completed',
      childDelegationIds: Array.from({ length: 65 }, () => 'x'),
    });
    expect(next.cardPublication?.draft).toEqual({
      ...running,
      childDelegationIds: Array.from({ length: 64 }, () => 'x'),
      detailOmitted: true,
    });
    const smaller = committed(next, {
      ...snapshot,
      status: 'completed',
      childDelegationIds: [],
    });
    expect(smaller.cardPublication?.draft).toEqual({
      ...running,
      childDelegationIds: [],
      detailOmitted: true,
    });
    expect(
      admissibleCardDraft(running, materializeCardDraft(next) ?? pending, true),
    ).toBe(true);
  });
  it('fails safely on counter exhaustion only when the full draft changes', () => {
    const old = record(pair(pending, Number.MAX_SAFE_INTEGER));
    expect(
      prepareCardPublication(old, old, snapshot, snapshot)?.cardRevision,
    ).toBe(Number.MAX_SAFE_INTEGER);
    expect(() =>
      prepareCardPublication(old, old, snapshot, {
        ...snapshot,
        workspaceDiscarded: true,
      }),
    ).toThrow('exhausted');
    expect(old.cardPublication?.cardRevision).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('validates amended prompts without silently fitting them', () => {
    const old = record(pair(pending, 4, true));
    expect(() =>
      prepareCardPublication(
        old,
        { ...old, task: { ...old.task, prompt: 'x'.repeat(32769) } },
        snapshot,
        snapshot,
      ),
    ).toThrow();
  });
  it('never yields a draft the frozen admissibility rules refuse', () => {
    const oldDraft: CardStateDraft = {
      ...running,
      routeSnapshot: route,
      requestedModelId: 'model',
      nativeSessionId: 'session',
      cancelledByUser: true,
      stoppedBy: { kind: 'user' },
      outputTruncated: true,
    };
    const old = settled(record(pair(oldDraft, 4, true)));
    const next = committed(old, {
      ...snapshot,
      status: 'pending',
      nativeSessionId: 'different',
      outputTruncated: false,
      routeSnapshot: { ...route, runtimeModelId: 'other' },
    });
    const full = materializeCardDraft(next);
    expect(full).toEqual({ ...oldDraft, prompt: 'original' });
    expect(CardStateDraftSchema.safeParse(full).success).toBe(true);
    expect(
      admissibleCardDraft(
        { ...oldDraft, prompt: 'original' },
        full ?? pending,
        true,
      ),
    ).toBe(true);
  });
});

describe('descriptor classifier', () => {
  it('covers equal full identities, not canonical wrappers, and publishes lower counters', () => {
    const old = record(pair(pending));
    expect(
      classifyCardDescriptor(old, {
        ...pending,
        cardRevision: 4,
        canonical: { status: 'completed', resultIndex: 1 },
      }),
    ).toEqual({ kind: 'covered', cardRevision: 4 });
    expect(
      classifyCardDescriptor(old, { ...pending, cardRevision: 3 }),
    ).toEqual({ kind: 'publish' });
    expect(classifyCardDescriptor(old, null)).toEqual({ kind: 'publish' });
    expect(classifyCardDescriptor(record(), null)).toEqual({
      kind: 'covered',
      cardRevision: 0,
    });
  });
  it('conflicts on equal mismatched full drafts or higher descriptor counters with a pair', () => {
    const old = record(pair(pending, 4, true));
    expect(
      classifyCardDescriptor(old, {
        ...pending,
        cardRevision: 4,
        prompt: 'different',
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      classifyCardDescriptor(old, { ...pending, cardRevision: 5 }),
    ).toEqual({ kind: 'conflict' });
    const active = settled(record(pair(running)));
    expect(
      classifyCardDescriptor(active, { ...pending, cardRevision: 8 }),
    ).toEqual({ kind: 'conflict' });
  });
  it('rebases old records from higher descriptor counters without rewriting the task prompt', () => {
    expect(
      classifyCardDescriptor(record(), {
        ...pending,
        cardRevision: 9,
        prompt: 'original',
      }),
    ).toEqual({
      kind: 'rebase',
      cardPublication: {
        runGeneration: 1,
        cardRevision: 9,
        promptAmended: true,
        draft: pending,
      },
    });
    expect(
      classifyCardDescriptor(record(), {
        ...pending,
        cardRevision: 9,
        prompt: 'descriptor prompt',
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      classifyCardDescriptor(record(), { ...running, cardRevision: 9 }),
    ).toEqual({
      kind: 'rebase',
      cardPublication: {
        runGeneration: 1,
        cardRevision: 9,
        promptAmended: false,
        draft: running,
      },
    });
  });
  it('does not fabricate a draft for a canonical-only higher descriptor', () => {
    expect(
      classifyCardDescriptor(record(), {
        version: 2,
        cardRevision: 0,
        canonical: { status: 'completed', resultIndex: 1 },
      }),
    ).toEqual({ kind: 'covered', cardRevision: 0 });
    expect(
      classifyCardDescriptor(record(), {
        version: 2,
        cardRevision: 9,
        canonical: { status: 'completed', resultIndex: 1 },
      }),
    ).toEqual({ kind: 'conflict' });
  });
  it('excludes pre-12a settled null or V1 states rather than upgrading them', () => {
    const v1 = CardStateV1Schema.parse({
      version: 1,
      status: 'completed',
      resultIndex: 1,
      error: null,
      usage: null,
      workspaceRevision: null,
      workspaceDiscarded: false,
      stopOutcome: null,
      controlOutcome: null,
      attribution: null,
      capabilitySummary: null,
      nestedChildSummary: null,
      partialPreview: null,
      finalPreview: null,
    });
    const old = settled(record(pair(running)));
    expect(classifyCardDescriptor(old, null)).toEqual({
      kind: 'covered',
      cardRevision: 0,
      excluded: true,
    });
    expect(classifyCardDescriptor(old, v1)).toEqual({
      kind: 'covered',
      cardRevision: 0,
      excluded: true,
    });
  });
});
