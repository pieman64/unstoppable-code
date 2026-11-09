import type { LookupAddress } from 'node:dns';
import { buildCloneRepoArgs } from '../../lib/git';
import {
  installPluginForPrincipal,
  REMOTE_PLUGIN_SOURCE_REFUSAL,
  type PluginSourceInstall,
} from '../remote-install-source-gate';

const lookupMock = jest.fn<Promise<LookupAddress[]>, [string]>();

jest.mock('node:dns/promises', () => ({
  lookup: (host: string): Promise<LookupAddress[]> => lookupMock(host),
}));

const PUBLIC_ADDRESS = '140.82.112.3';
const PRIVATE_ADDRESS = '10.0.0.5';

function resolveHosts(addresses: Record<string, string>): void {
  lookupMock.mockImplementation((host: string) => {
    const address = addresses[host];
    return address === undefined
      ? Promise.reject(new Error(`ENOTFOUND ${host}`))
      : Promise.resolve([{ address, family: 4 }]);
  });
}

function installSpy(): jest.MockedFunction<PluginSourceInstall> {
  return jest.fn<
    ReturnType<PluginSourceInstall>,
    Parameters<PluginSourceInstall>
  >(() => Promise.resolve({ success: false, error: 'not cloned in tests' }));
}

describe('plugins:install-plugin source gate by principal (CAN-5764)', () => {
  beforeEach((): void => {
    lookupMock.mockReset();
    resolveHosts({
      'github.com': PUBLIC_ADDRESS,
      'git.internal.example.com': PRIVATE_ADDRESS,
    });
  });

  it.each([
    ['file:///etc/passwd'],
    ['ssh://git@github.com/acme/plugin.git'],
    ['git@github.com:acme/plugin.git'],
    ['https://10.0.0.5/acme/plugin.git'],
    ['https://169.254.169.254/latest/meta-data'],
    ['https://git.internal.example.com/acme/plugin.git'],
    ['https://user:token@github.com/acme/plugin.git'],
  ])(
    'refuses a remote control install from %s and never clones',
    async (sourceUrl) => {
      const install = installSpy();
      const result = await installPluginForPrincipal(
        { remote: true, marketplaceId: 'acme', pluginName: 'p', sourceUrl },
        install,
      );
      expect(result.success).toBe(false);
      expect(result.success ? '' : result.error).toContain(
        REMOTE_PLUGIN_SOURCE_REFUSAL,
      );
      expect(install).not.toHaveBeenCalled();
    },
  );

  it('clones a remote control install from a public https source with redirects refused, so a redirect to an internal host is never followed', async () => {
    const install = installSpy();
    const sourceUrl = 'https://github.com/acme/plugin.git';
    await installPluginForPrincipal(
      { remote: true, marketplaceId: 'acme', pluginName: 'p', sourceUrl },
      install,
    );
    expect(install).toHaveBeenCalledWith('acme', 'p', sourceUrl, {
      disableRedirects: true,
    });
    const args = buildCloneRepoArgs(sourceUrl, '/cache/p', false);
    expect(args.slice(0, 3)).toEqual([
      '-c',
      'http.followRedirects=false',
      'clone',
    ]);
  });

  it('keeps a local install of an ssh or private source working as before', async () => {
    for (const sourceUrl of [
      'git@github.com:acme/plugin.git',
      'https://git.internal.example.com/acme/plugin.git',
    ]) {
      const install = installSpy();
      await installPluginForPrincipal(
        { remote: false, marketplaceId: 'acme', pluginName: 'p', sourceUrl },
        install,
      );
      expect(install).toHaveBeenCalledWith('acme', 'p', sourceUrl);
    }
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
