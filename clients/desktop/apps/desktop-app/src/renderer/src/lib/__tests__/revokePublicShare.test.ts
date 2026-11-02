import { MarketplaceUnshareError } from '@canopy/ui-shared/lib/marketplace-unshare';
import { revokeMarketplacePublicShare } from '../revokePublicShare';

const revokeSkill = jest.fn();
const revokeCollection = jest.fn();
const revokeAgent = jest.fn();
const revokePlugin = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(globalThis, {
    window: {
      skills: { revokePublicShare: revokeSkill },
      collections: { revokePublicShare: revokeCollection },
      agents: { revokePublicShare: revokeAgent },
      plugins: { revokePublicShare: revokePlugin },
    },
  });
});

describe('revokeMarketplacePublicShare (CAN-4842)', () => {
  it("sends each kind's own share identifier", async () => {
    revokeSkill.mockResolvedValue(undefined);
    revokeCollection.mockResolvedValue(undefined);
    revokeAgent.mockResolvedValue(undefined);
    revokePlugin.mockResolvedValue({ success: true });

    await expect(
      revokeMarketplacePublicShare('skill', 's1'),
    ).resolves.toBeUndefined();
    await revokeMarketplacePublicShare('collection', 'c1');
    await revokeMarketplacePublicShare('agent', 'a1');
    await expect(
      revokeMarketplacePublicShare('plugin', 'p-ext'),
    ).resolves.toBeUndefined();

    expect(revokeSkill).toHaveBeenCalledWith('s1');
    expect(revokeCollection).toHaveBeenCalledWith('c1');
    expect(revokeAgent).toHaveBeenCalledWith('a1');
    expect(revokePlugin).toHaveBeenCalledWith('p-ext');
  });

  it('turns a resolved plugin failure into a rejection, never success', async () => {
    revokePlugin.mockResolvedValue({
      success: false,
      error: 'Request failed (403)',
    });
    const result = revokeMarketplacePublicShare('plugin', 'p-ext');
    await expect(result).rejects.toBeInstanceOf(MarketplaceUnshareError);
    await expect(result).rejects.toMatchObject({
      reason: 'forbidden',
      message: 'Request failed (403)',
    });
  });

  it('classifies a refusal status from a rejected channel', async () => {
    revokeSkill.mockRejectedValue(
      Object.assign(new Error('gone'), { status: 404 }),
    );
    await expect(
      revokeMarketplacePublicShare('skill', 's1'),
    ).rejects.toMatchObject({ reason: 'not-found' });
  });

  it('keeps an unexplained failure retryable', async () => {
    revokeAgent.mockRejectedValue(new Error('offline'));
    await expect(
      revokeMarketplacePublicShare('agent', 'a1'),
    ).rejects.toMatchObject({ reason: 'unknown' });
  });
});
