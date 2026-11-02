import { persistedDelegationSnapshot } from '../../agents/delegation/card-persistence';

describe('persisted delegation snapshot', () => {
  it('keeps opaque nested references without restoring live-only progress', () => {
    const opaque = { opaqueReference: { nested: ['keep'] } };
    const snapshot = persistedDelegationSnapshot({
      delegationId: 'child',
      status: 'running',
      outputTruncated: false,
      requestedModelId: 'reviewer',
      partialText: 'working',
      usage: { inputTokens: 1 },
      ...opaque,
    });
    expect(snapshot).toMatchObject(opaque);
    expect(snapshot).not.toHaveProperty('partialText');
    expect(snapshot).not.toHaveProperty('usage');
  });
});
