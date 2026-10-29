import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { CURATED_PLUGIN_MARKETPLACE_ID } from '@canopy/desktop-shared/types/plugins';

interface InstallResult {
  success: boolean;
  error?: string;
}

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockReport = jest.fn();
const mockInstallBuiltInPlugin = jest.fn();
/**
 * Set per test and returned by the mocked service. Held as a typed value so
 * the mock factory never has to return `jest.fn()`'s `any`.
 */
let installResult: InstallResult = { success: true };

jest.mock('../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => unknown,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

jest.mock('../plugins/curated-plugin-events', () => ({
  reportCuratedPluginInstalled: (...args: unknown[]): Promise<boolean> => {
    mockReport(...args);
    return Promise.resolve(true);
  },
}));

jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));

jest.mock('../plugins/plugin-service', () => ({
  installBuiltInPlugin: (...args: unknown[]): Promise<InstallResult> => {
    mockInstallBuiltInPlugin(...args);
    return Promise.resolve(installResult);
  },
}));

import { registerPluginHandlers } from '../plugins/plugin-handlers';

/**
 * The install IPC handler is the only chokepoint that carries adoption intent:
 * background sync materializes every curated plugin on every client, so a
 * content fetch cannot stand in for a user choosing to install one.
 */
describe('curated plugin install reporting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHandlers.clear();
    installResult = { success: true };
    registerPluginHandlers();
  });

  function install(
    marketplaceId: string,
    pluginName: string,
  ): Promise<unknown> {
    const handler = mockHandlers.get(PLUGINS_CHANNELS.INSTALL_BUILT_IN_PLUGIN);
    if (!handler) throw new Error('built-in install handler not registered');
    return Promise.resolve(
      handler({}, { marketplaceId, pluginName, providers: ['claude'] }),
    );
  }

  it('reports a curated install using the catalog key', async () => {
    await install(CURATED_PLUGIN_MARKETPLACE_ID, 'docs-plugin');

    // The sync engine writes `name: entry.key` into the manifest, so the
    // installed plugin name is the curated catalog key verbatim.
    expect(mockReport).toHaveBeenCalledWith('docs-plugin');
  });

  it('does not report installs from non-curated marketplaces', async () => {
    await install('some-github-marketplace', 'docs-plugin');

    expect(mockReport).not.toHaveBeenCalled();
  });

  it('does not report when the install itself failed', async () => {
    installResult = { success: false, error: 'boom' };

    await install(CURATED_PLUGIN_MARKETPLACE_ID, 'docs-plugin');

    expect(mockReport).not.toHaveBeenCalled();
  });

  it('still returns the install result when reporting throws', async () => {
    mockReport.mockImplementation(() => {
      throw new Error('cloud unreachable');
    });

    // Telemetry must never be able to break the user's install.
    await expect(
      install(CURATED_PLUGIN_MARKETPLACE_ID, 'docs-plugin'),
    ).resolves.toMatchObject({ success: true });
  });
});
