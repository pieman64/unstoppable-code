import { homedir } from 'node:os';
import {
  assertHostBuildStorageStartup,
  canonicalStoragePath,
  assertSecureStorageDaemonStopped,
} from '@canopy/core-platform/build-storage-startup';
import { relocateSecureStorage } from '@canopy/core-platform/secure-storage-relocation';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';
import { BuildStorageStartupRefused } from '@canopy/core-runtime/node/build-storage-startup';
import { historicalSecureDataDir } from '@canopy/core-runtime/node/secure-data-dir';
import { hasDataDirectoryOverride } from '@canopy/core-runtime/node/build-identity';
import { BRAND } from '@canopy/brand/current';
import { getCanopyBuildIdentity, getCanopyDataDir } from '../canopy-paths';

/** Called with the host's existing per-build startup/lifetime exclusion held. */
export async function prepareCanopySecureStorage(): Promise<void> {
  // Explicit roots never discover or import a HOME credential store.
  if (hasDataDirectoryOverride(process.env)) return;
  const identity = getCanopyBuildIdentity();
  const home = canonicalStoragePath(homedir());
  assertHostBuildStorageStartup({ home, identity });
  const dataRoot = getCanopyDataDir();
  await relocateSecureStorage({
    dataRoot,
    historical: historicalSecureDataDir(
      home,
      BRAND.storage.secureDataDirNames,
      identity.build,
    ),
    assertCold: async () => {
      const unchecked = (): BuildStorageStartupRefused =>
        new BuildStorageStartupRefused(
          'secure-relocation-unsafe',
          'Secure storage cannot be checked at this data root. Quit all app, CLI and daemon processes and resolve the endpoint path limit or its private socket alias before starting again. See docs/internal-root-migration.md.',
        );
      const endpoints = createPlatformEndpointServices(
        hostPlatformOperatingSystem(),
      );
      if (endpoints.semantics === 'filesystem-socket') {
        // The platform probe re-checks a long root's alias, recreating one a
        // cleaner removed, so a live daemon is never missed (CAN-5694).
        let probe: Awaited<ReturnType<typeof endpoints.probe>>;
        try {
          probe = await endpoints.probe(
            endpoints.address({ dataRoot, endpointName: 'core' }),
          );
        } catch {
          throw unchecked();
        }
        if (probe.state === 'absent' || probe.state === 'refused') return;
        throw new BuildStorageStartupRefused(
          'secure-relocation-unsafe',
          'Secure storage is in use or its daemon could not be checked. Quit all app, CLI and daemon processes, then start the app or CLI again.',
        );
      }
      let address: string;
      try {
        address = endpoints.address({ dataRoot, endpointName: 'core' }).path;
      } catch {
        throw unchecked();
      }
      return assertSecureStorageDaemonStopped(address);
    },
  });
}
