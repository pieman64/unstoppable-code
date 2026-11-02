const mockReadLock = jest.fn();
const mockMarketplaces = jest.fn();
jest.mock('../skills/lock-file', () => ({
  readLockFile: (): unknown => mockReadLock(),
}));
jest.mock('../plugins/plugin-service', () => ({
  loadMarketplacesCacheOnly: (): unknown => mockMarketplaces(),
}));
import { hasInstalledCapability } from '../notifications/campaigns/installed-capability';

beforeEach(() => {
  jest.clearAllMocks();
  mockReadLock.mockReturnValue({ version: 2, skills: {} });
  mockMarketplaces.mockResolvedValue({
    success: true,
    data: { marketplaces: [] },
  });
});
it('accepts a canonical skill without needing a plugin probe', async () => {
  mockReadLock.mockReturnValue({ version: 2, skills: { example: {} } });
  await expect(hasInstalledCapability()).resolves.toBe(true);
  expect(mockMarketplaces).not.toHaveBeenCalled();
});
it.each(['claude', 'codex'])(
  'recognizes a %s plugin install',
  async (provider) => {
    mockMarketplaces.mockResolvedValue({
      success: true,
      data: {
        marketplaces: [
          {
            plugins: [
              { globalInstallStatus: { [provider]: { installed: true } } },
            ],
          },
        ],
      },
    });
    await expect(hasInstalledCapability()).resolves.toBe(true);
  },
);
it('does not count available but uninstalled plugins', async () => {
  mockMarketplaces.mockResolvedValue({
    success: true,
    data: {
      marketplaces: [
        {
          plugins: [{ globalInstallStatus: { claude: { installed: false } } }],
        },
      ],
    },
  });
  await expect(hasInstalledCapability()).resolves.toBe(false);
});
it.each([{ success: false }, { success: true }])(
  'rejects unavailable plugin state: %p',
  async (result) => {
    mockMarketplaces.mockResolvedValue(result);
    await expect(hasInstalledCapability()).rejects.toThrow('could not be read');
  },
);
