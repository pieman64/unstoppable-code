import { openAuthenticatedCloudPageReported } from '../openAuthenticatedCloudPage';

const openAuthenticatedPortalPage = jest.fn<Promise<boolean>, [string]>();

beforeEach(() => {
  openAuthenticatedPortalPage.mockReset();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { api: { openAuthenticatedPortalPage } },
  });
});

describe('openAuthenticatedCloudPageReported', () => {
  it('resolves true when the signed-in page opens', async () => {
    openAuthenticatedPortalPage.mockResolvedValue(true);
    await expect(
      openAuthenticatedCloudPageReported('/organization'),
    ).resolves.toBe(true);
    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith('/organization');
  });

  it('resolves false when the hand-off reports it did not open', async () => {
    openAuthenticatedPortalPage.mockResolvedValue(false);
    await expect(
      openAuthenticatedCloudPageReported('/organization'),
    ).resolves.toBe(false);
  });

  it('resolves false when the hand-off rejects', async () => {
    openAuthenticatedPortalPage.mockRejectedValue(new Error('offline'));
    await expect(
      openAuthenticatedCloudPageReported('/organization'),
    ).resolves.toBe(false);
  });

  it('resolves false when the bridge throws synchronously', async () => {
    openAuthenticatedPortalPage.mockImplementation(() => {
      throw new Error('missing handler');
    });
    await expect(
      openAuthenticatedCloudPageReported('/organization'),
    ).resolves.toBe(false);
  });
});
