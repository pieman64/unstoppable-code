import { app } from 'electron';
import { attachOrStartCanopyDaemon } from '@canopy/core-client/node';
import {
  createElectronDaemonCallerLifetime,
  type ElectronDaemonCallerLifetime,
} from './electron-daemon-caller-lifetime';
import {
  createElectronDaemonConnectionService,
  type ElectronDaemonConnectionService,
} from './electron-daemon-connection';
import {
  createElectronDaemonHost,
  ELECTRON_DAEMON_DEFINITIONS,
  type ElectronDaemonClient,
} from './electron-daemon-host';

type ElectronDaemonHost = Awaited<ReturnType<typeof createElectronDaemonHost>>;

let connections:
  | ElectronDaemonConnectionService<ElectronDaemonClient>
  | undefined;
let host: Promise<ElectronDaemonHost> | undefined;
let lifetime: ElectronDaemonCallerLifetime | undefined;
let stopped = false;

// One trusted host per process; a failed setup is retried on the next use.
function getHost(): Promise<ElectronDaemonHost> {
  if (host) return host;
  const pending = createElectronDaemonHost();
  host = pending;
  void pending.catch(() => {
    if (host === pending) host = undefined;
  });
  return pending;
}

/** Explicit migrated-consumer opt-in; construction does not open or start a daemon. */
export function getElectronDaemonConnections(): ElectronDaemonConnectionService<ElectronDaemonClient> {
  connections ??= createElectronDaemonConnectionService({
    enabled: !stopped,
    authorityId: async () => (await getHost()).authorityId,
    attach: async (signal): Promise<ElectronDaemonClient> => {
      const trusted = await getHost();
      const result = await attachOrStartCanopyDaemon({
        ...trusted.launch,
        signal,
        attach: (endpoint, setup) =>
          trusted.connect({
            endpoint,
            ...setup,
            clientName: 'desktop',
            clientVersion: app.getVersion(),
            definitions: ELECTRON_DAEMON_DEFINITIONS,
          }),
        dispose: (client) => client.close(),
      });
      return result.value;
    },
  });
  return connections;
}

/**
 * The verified authority and canonical data root a daemon read projects
 * against. Trusted main only; resolving it prepares the data root but never
 * contacts a daemon.
 */
export async function getElectronDaemonFilesContext(): Promise<{
  authorityId: string;
  canonicalDataRoot: string;
}> {
  const { authorityId, canonicalDataRoot } = await getHost();
  return { authorityId, canonicalDataRoot };
}

/**
 * Document lifetimes shared by every migrated consumer, so one renderer
 * document holds one daemon session.
 */
export function getElectronDaemonCallerLifetime(): ElectronDaemonCallerLifetime {
  if (!lifetime) {
    lifetime = createElectronDaemonCallerLifetime();
    // Created after quit began: every owner is already closed.
    if (stopped) lifetime.disposeAll();
  }
  return lifetime;
}

export async function disposeElectronDaemonConnections(): Promise<void> {
  stopped = true;
  lifetime?.disposeAll();
  await connections?.dispose();
}
