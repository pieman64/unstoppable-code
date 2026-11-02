import { app } from 'electron';
import { attachOrStartCanopyDaemon } from '@canopy/core-client/node';
import {
  createElectronDaemonCallerLifetime,
  type ElectronDaemonCallerLifetime,
} from './electron-daemon-caller-lifetime';
import {
  createElectronDaemonConnectionService,
  type ElectronDaemonConnectionService,
  type ElectronDaemonSession,
} from './electron-daemon-connection';
import {
  createElectronDaemonHost,
  ELECTRON_DAEMON_DEFINITIONS,
  type ElectronDaemonClient,
} from './electron-daemon-host';
import type { WorkspaceCommitEventBinding } from './workspace-commit-events';

type ElectronDaemonHost = Awaited<ReturnType<typeof createElectronDaemonHost>>;

let connections:
  | ElectronDaemonConnectionService<ElectronDaemonClient>
  | undefined;
let host: Promise<ElectronDaemonHost> | undefined;
let lifetime: ElectronDaemonCallerLifetime | undefined;
let stopped = false;
// W5e: every client instance id this process ever leased, so its subscriber
// skips the commit events of its own commits (a session may end first).
const ownClientInstances = new Set<string>();
let workspaceCommitEvents: Promise<WorkspaceCommitEventBinding> | undefined;

/** Loaded with the first session; observing never opens a connection. */
function observeWorkspaceCommits(
  session: ElectronDaemonSession<ElectronDaemonClient>,
  clientInstanceId: string,
): void {
  ownClientInstances.add(clientInstanceId);
  if (stopped) return;
  const pending = (workspaceCommitEvents ??= Promise.all([
    import('./workspace-commit-events'),
    import('./workspace-commit-event-handlers'),
  ]).then(([events, handlers]) =>
    events.createWorkspaceCommitEventBinding({
      handlers: handlers.createDesktopWorkspaceCommitEventHandlers(),
      isOwnOrigin: (id) => ownClientInstances.has(id),
    }),
  ));
  void pending
    .then((binding) => {
      if (!stopped) binding.observe(session);
    })
    .catch(() => undefined);
}

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
    onSession: (session, caller) =>
      observeWorkspaceCommits(session, caller.clientInstanceId),
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
  await workspaceCommitEvents
    ?.then((binding) => binding.close())
    .catch(() => undefined);
  await connections?.dispose();
}
