import {
  MARKETPLACE_UNSHARE_ALL_LABEL,
  MARKETPLACE_UNSHARE_LABEL,
  marketplaceUnshareMenuLabel,
} from '../marketplace-unshare';

describe('marketplaceUnshareMenuLabel', () => {
  it('reads Unshare for zero or one audience', () => {
    expect(marketplaceUnshareMenuLabel(0)).toBe(MARKETPLACE_UNSHARE_LABEL);
    expect(marketplaceUnshareMenuLabel(1)).toBe('Unshare');
  });

  it('reads Unshare all once two audiences are listed', () => {
    expect(marketplaceUnshareMenuLabel(2)).toBe(MARKETPLACE_UNSHARE_ALL_LABEL);
    expect(MARKETPLACE_UNSHARE_ALL_LABEL).toBe('Unshare all');
  });
});
