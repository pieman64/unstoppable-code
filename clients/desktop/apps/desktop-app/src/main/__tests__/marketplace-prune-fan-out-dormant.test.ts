// CAN-4717: the keyed marketplace prune (A25(b)) stays dormant. No production
// caller may supply a fan-out request ID until plugin reconciliation is
// bounded (D1, CAN-4405 coordination); only tests and the internal
// construction in plugin-service and workspace-plugin-defaults name it.
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: jest.fn(),
}));
jest.mock('../plugins/plugin-service', () => ({
  removeMarketplace: jest.fn(),
}));
jest.mock('../canopy-cloud/client', () => ({
  assertCanopyCloudCapability: jest.fn(),
}));

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import { registerIpcHandler } from '../ipc/register';
import { registerPluginHandlers } from '../plugins/plugin-handlers';
import * as pluginService from '../plugins/plugin-service';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const FAN_OUT_ID = 'fanOutRequestId';

function productionSources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        !['__tests__', 'node_modules', 'dist', 'tests', 'fixtures'].includes(
          entry.name,
        )
      )
        files.push(...productionSources(fullPath));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('keyed marketplace prune stays dormant (CAN-4717)', () => {
  it('names the fan-out request ID only in the prune boundary and the plugin service', () => {
    const roots = [
      path.join(REPO_ROOT, 'apps', 'desktop-app', 'src'),
      ...readdirSync(path.join(REPO_ROOT, 'packages'), {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(REPO_ROOT, 'packages', entry.name, 'src')),
    ];
    const naming = roots
      .flatMap((root) => {
        try {
          return productionSources(root);
        } catch {
          return [];
        }
      })
      .filter((file) => readFileSync(file, 'utf8').includes(FAN_OUT_ID))
      .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
      .sort();
    expect(naming).toEqual([
      'apps/desktop-app/src/main/lib/workspace-plugin-defaults.ts',
      'apps/desktop-app/src/main/plugins/plugin-service.ts',
    ]);
  });

  it('drops a fan-out request ID from the plugins:removeMarketplace payload', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    jest
      .mocked(registerIpcHandler)
      .mockImplementation(
        (channel, handler: (...args: unknown[]) => unknown) => {
          handlers.set(channel, handler);
        },
      );
    const remove = jest.mocked(pluginService.removeMarketplace);
    remove.mockResolvedValue({ success: false, error: 'not found' });

    registerPluginHandlers();
    await handlers.get(PLUGINS_CHANNELS.REMOVE)?.(
      { sender: { send: jest.fn() } },
      { id: 'acme/plugins', providers: ['codex'], [FAN_OUT_ID]: 'renderer' },
    );

    expect(remove).toHaveBeenCalledTimes(1);
    const [id, options] = remove.mock.calls[0] ?? [];
    expect(id).toBe('acme/plugins');
    expect(options).toEqual({ providers: ['codex'] });
    expect(options).not.toHaveProperty(FAN_OUT_ID);
  });
});
