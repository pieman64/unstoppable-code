import { MarketplaceUnshareError } from '@canopy/ui-shared/lib/marketplace-unshare';
import { unshareMarketplaceResource } from '../marketplaceUnshare';

const deleteSkill = jest.fn();
const deleteCollection = jest.fn();
const deleteAgent = jest.fn();
const deletePlugin = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(globalThis, {
    window: {
      skills: { deleteShared: deleteSkill },
      collections: { deleteShared: deleteCollection },
      agents: { deleteShared: deleteAgent },
      plugins: { deleteShared: deletePlugin },
    },
  });
});

describe('unshareMarketplaceResource (CAN-4263)', () => {
  it("sends each kind's own account identifier", async () => {
    deleteSkill.mockResolvedValue(undefined);
    deleteCollection.mockResolvedValue(undefined);
    deleteAgent.mockResolvedValue(undefined);
    deletePlugin.mockResolvedValue({ success: true });

    await unshareMarketplaceResource('skill', 's1');
    await unshareMarketplaceResource('collection', 'c1');
    await unshareMarketplaceResource('agent', 'a1');
    await unshareMarketplaceResource('plugin', 'p-ext');

    expect(deleteSkill).toHaveBeenCalledWith({ skillId: 's1' });
    expect(deleteCollection).toHaveBeenCalledWith({ collectionId: 'c1' });
    expect(deleteAgent).toHaveBeenCalledWith({ agentId: 'a1' });
    expect(deletePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ remoteId: 'p-ext' }),
    );
  });

  it('turns a resolved plugin failure into a rejection, never success', async () => {
    deletePlugin.mockResolvedValue({
      success: false,
      error: 'Request failed (403)',
    });
    const result = unshareMarketplaceResource('plugin', 'p-ext');
    await expect(result).rejects.toBeInstanceOf(MarketplaceUnshareError);
    await expect(result).rejects.toMatchObject({ reason: 'forbidden' });
  });

  it('classifies a skill still used by collections', async () => {
    deleteSkill.mockRejectedValue(
      Object.assign(new Error('conflict'), { status: 409 }),
    );
    await expect(
      unshareMarketplaceResource('skill', 's1'),
    ).rejects.toMatchObject({ reason: 'in-use' });
  });

  it('keeps an unexplained failure retryable', async () => {
    deleteAgent.mockRejectedValue(new Error('offline'));
    await expect(
      unshareMarketplaceResource('agent', 'a1'),
    ).rejects.toMatchObject({ reason: 'unknown' });
  });
});
