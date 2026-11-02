// The renderer evaluates this package's index at startup. The protocol schema
// barrels cost about 23 MB of heap to evaluate, so the index must not load them.
jest.mock('@canopy/protocol/canopy-core', () => {
  throw new Error('The index loaded @canopy/protocol/canopy-core');
});
jest.mock('@canopy/protocol/canopy-core/core', () => {
  throw new Error('The index loaded @canopy/protocol/canopy-core/core');
});

describe('agent-transcript index runtime imports', () => {
  it('loads without the protocol schema barrels', async () => {
    const transcript = await import('../../index');
    expect(typeof transcript.overlayStreamBackedDelegationCard).toBe(
      'function',
    );
    expect(typeof transcript.persistedDelegationSnapshot).toBe('function');
  });
});
