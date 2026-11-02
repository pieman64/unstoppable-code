import { createDelegationRunState } from '../lifecycle';
import {
  decodeStoredDelegationV3,
  encodeStoredDelegationV3,
} from '../record-v3';

function fixture(): Record<string, unknown> {
  return {
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
      prompt: 'prompt',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    callKey: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    createdAt: 100,
    state: createDelegationRunState('00000000-0000-4000-8000-000000000003', 1),
    launch: {
      version: 1,
      delegationId: '00000000-0000-4000-8000-000000000003',
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
          delegationId: '00000000-0000-4000-8000-000000000003',
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
  };
}
const publication = {
  runGeneration: 1,
  cardRevision: 7,
  promptAmended: true,
  draft: { version: 2, status: 'pending', outputTruncated: false },
};

describe('v3 card publication codec', () => {
  it('preserves missing-field record bytes and absence', () => {
    const old = fixture();
    const decoded = decodeStoredDelegationV3(old);
    expect(decoded.cardPublication).toBeUndefined();
    expect(encodeStoredDelegationV3(decoded)).toBe(JSON.stringify(old));
  });
  it('round trips the exact publication bytes', () => {
    const value = { ...fixture(), cardPublication: publication };
    expect(encodeStoredDelegationV3(decodeStoredDelegationV3(value))).toBe(
      JSON.stringify(value),
    );
  });
  it.each([
    null,
    {},
    { ...publication, extra: true },
    { ...publication, runGeneration: 2 },
    { ...publication, cardRevision: 0 },
    { ...publication, cardRevision: -1 },
    { ...publication, cardRevision: 1.5 },
    { ...publication, cardRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...publication, promptAmended: 'true' },
    { ...publication, promptAmended: undefined },
    { ...publication, draft: { ...publication.draft, prompt: 'duplicated' } },
    { ...publication, draft: { ...publication.draft, prompt: undefined } },
    { ...publication, draft: { ...publication.draft, unknown: true } },
    {
      ...publication,
      draft: { version: 2, status: 'completed', outputTruncated: false },
    },
    { ...publication, draft: { version: 2, status: 'pending' } },
    {
      ...publication,
      draft: { ...publication.draft, requestedModelId: 'x'.repeat(1025) },
    },
  ])('refuses malformed publication %j', (cardPublication) => {
    expect(() =>
      decodeStoredDelegationV3({ ...fixture(), cardPublication }),
    ).toThrow('Invalid delegation record');
  });
  it('validates the independent reconstructed prompt bound when latched', () => {
    const record = decodeStoredDelegationV3(fixture());
    const task = { ...record.task, prompt: 'x'.repeat(32769) };
    expect(() =>
      decodeStoredDelegationV3({
        ...record,
        task,
        cardPublication: publication,
      }),
    ).toThrow('Invalid delegation record');
    expect(() =>
      decodeStoredDelegationV3({
        ...record,
        task,
        cardPublication: { ...publication, promptAmended: false },
      }),
    ).toThrow('Invalid delegation record');
  });
  it('permits exactly the prompt bound and keeps unknown top-level rejection', () => {
    const record = decodeStoredDelegationV3(fixture());
    expect(
      decodeStoredDelegationV3({
        ...record,
        task: { ...record.task, prompt: '\u0001'.repeat(32768) },
        cardPublication: publication,
      }).cardPublication,
    ).toEqual(publication);
    expect(() => decodeStoredDelegationV3({ ...record, unknown: 1 })).toThrow(
      'Invalid delegation record',
    );
  });
});
