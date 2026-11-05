import { app } from 'electron';
import { CanopyClientError, toCanopyClientError } from '@canopy/core-client';
import {
  attachOrStartCanopyDaemon,
  CanopyDaemonDeadline,
  canopyDaemonRefusal,
  canopyDaemonRefusalError,
  classifyCanopyDaemonCapability,
  probeCanopyDaemon,
  waitForCanopyDaemonRelease,
  type CanopyDaemonBeforeSpawn,
  type CanopyDaemonCapability,
  type CanopyRuntimeDescriptor,
} from '@canopy/core-client/node';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_GENERATION_REPORT_CAPABILITY,
  WORKER_CODE_GRAPH_READ_REPORT_CAPABILITY,
} from '@canopy/protocol/canopy-core';
import { isW5DaemonFlipCompiled } from '../lib/w5-flip-gate';
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
import { getElectronDaemonHealth } from './electron-daemon-health';
import { getDaemonExecutionStatus } from './daemon-execution-status';
import type { WorkspaceCommitEventBinding } from './workspace-commit-events';

type ElectronDaemonHost = Awaited<ReturnType<typeof createElectronDaemonHost>>;

let connections:
  | ElectronDaemonConnectionService<ElectronDaemonClient>
  | undefined;
let host: Promise<ElectronDaemonHost> | undefined;
let lifetime: ElectronDaemonCallerLifetime | undefined;
let stopped = false;
let w5HandoffPending = false;
let w5AttachOnly = false;
let filesConsumerEnabled = false;
let w5DegradationAwaitingFiles = false;
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

/** The pre-spawn step's own budget: a large root's backup outlasts the launch's. */
const W5_FLIP_STEP_TIMEOUT_MS = 120_000;

/**
 * TRANSITIONAL (CAN-5543, GB12): a flip build spawns every daemon with the W5
 * host; where the platform has a startup claim, the claimed spawn first runs
 * the backup and stops the in-process commit log. Windows has no claim; the
 * handoff runs that step itself before its first launch.
 */
function w5LaunchInputs(): Parameters<typeof createElectronDaemonHost>[0] {
  if (!isW5DaemonFlipCompiled()) return {};
  if (hostPlatformOperatingSystem() === 'win32') return { w5: {} };
  const beforeSpawn: CanopyDaemonBeforeSpawn = {
    timeoutMs: W5_FLIP_STEP_TIMEOUT_MS,
    run: async (): Promise<void> => {
      const { prepareW5FlipSpawn } = await import('../lib/w5-flip-backup');
      await prepareW5FlipSpawn(app.getVersion());
    },
  };
  return { w5: { beforeSpawn } };
}

// One trusted host per process; a failed setup is retried on the next use.
function getHost(): Promise<ElectronDaemonHost> {
  if (host) return host;
  const pending = createElectronDaemonHost(w5LaunchInputs());
  host = pending;
  void pending.catch(() => {
    if (host === pending) host = undefined;
    // Without a prepared data root no daemon can start. Reads resolve the host
    // before they ask the connection service, so it never sees this failure.
    getElectronDaemonHealth().observe({
      kind: 'unreachable',
      reason: 'host_unavailable',
    });
  });
  return pending;
}

/** Explicit migrated-consumer opt-in; construction does not open or start a daemon. */
export function getElectronDaemonConnections(): ElectronDaemonConnectionService<ElectronDaemonClient> {
  const flip = isW5DaemonFlipCompiled();
  connections ??= createElectronDaemonConnectionService({
    enabled: !stopped,
    authorityId: async () => (await getHost()).authorityId,
    // A flip setup can include the pre-spawn step on top of the launch.
    ...(flip && { setupTimeoutMs: 30_000 + W5_FLIP_STEP_TIMEOUT_MS }),
    attach: async (signal): Promise<ElectronDaemonClient> => {
      const trusted = await getHost();
      let client: ElectronDaemonClient;
      if (flip && w5AttachOnly) {
        // A failed handoff cannot safely repeat admission or its backup.
        const found = await probeCanopyDaemon({
          dataRootHash: trusted.launch.dataRootHash,
          ports: trusted.launch.ports,
          signal,
          connect: (endpoint, setup) =>
            connectTrusted(trusted, endpoint, setup),
          dispose: (late) => late.close(),
        });
        if (found.kind !== 'live')
          throw new CanopyClientError({
            kind: 'unavailable',
            message: 'The background service could not be reached.',
            retry: { kind: 'never' },
          });
        client = found.value;
      } else {
        // Windows: the launcher cannot run the step, so it must have run.
        if (flip && hostPlatformOperatingSystem() === 'win32')
          (await import('../lib/w5-flip-backup')).requireW5FlipSpawnPrepared();
        const result = await attachOrStartCanopyDaemon({
          ...trusted.launch,
          signal,
          attach: (endpoint, setup) => connectTrusted(trusted, endpoint, setup),
          dispose: (connected) => connected.close(),
        });
        client = result.value;
      }
      // Before the lease, on every connection: a reconnect may find another.
      if (flip) await requireW5Capability(client, signal);
      return client;
    },
    onSession: (session, caller) => {
      observeWorkspaceCommits(session, caller.clientInstanceId);
      // The resource monitor follows the daemon's status (CAN-5690).
      if (!stopped) getDaemonExecutionStatus().observe(session);
    },
    onReachability: (event) => {
      // A later consumer must not replay a handoff failure already recovered.
      if (event.kind === 'reached') w5DegradationAwaitingFiles = false;
      getElectronDaemonHealth().observe(event);
    },
    // The handoff waits a refused daemon out and settles any attach it
    // refuses; after it, a refusal is a failed start that warns and latches.
    isRestartRefusal: (error) => {
      if (!w5HandoffPending) return false;
      const refusal = canopyDaemonRefusal(error);
      return refusal !== null && refusal !== 'exited_before_ready';
    },
  });
  return connections;
}

/**
 * TRANSITIONAL (CAN-5543, GB12): the flip handoff's phase, as daemon
 * reachability sees it. Pending is a restart window (q-13): attach refusals
 * show nothing and Files reads stay in-process. A degraded handoff warns at
 * once and latches, so reads stop contacting a daemon that cannot serve this
 * app; `cancelled` is quit.
 */
export function noteElectronW5Handoff(
  phase: 'pending' | 'ready' | 'degraded' | 'cancelled',
): void {
  w5HandoffPending = phase === 'pending';
  w5AttachOnly = phase === 'degraded' || phase === 'cancelled';
  w5DegradationAwaitingFiles = phase === 'degraded' && !filesConsumerEnabled;
  if (phase === 'degraded')
    getElectronDaemonHealth().observe({
      kind: 'unreachable',
      reason: 'start_failed',
    });
}

/** Replay an early flip failure once Files actually depends on the service. */
export function setElectronDaemonFilesConsumerEnabled(enabled: boolean): void {
  filesConsumerEnabled = enabled;
  const health = getElectronDaemonHealth();
  health.setConsumerEnabled('files_reads', enabled);
  if (enabled && w5DegradationAwaitingFiles) {
    w5DegradationAwaitingFiles = false;
    health.observe({ kind: 'unreachable', reason: 'start_failed' });
  }
}

/** Files reads bypass the daemon meanwhile, with nothing shown. */
export function isElectronW5HandoffPending(): boolean {
  return w5HandoffPending;
}

type Endpoint = Parameters<ElectronDaemonHost['connect']>[0]['endpoint'];

/** Connects and initializes; never leases. */
function connectTrusted(
  trusted: ElectronDaemonHost,
  endpoint: Endpoint,
  setup: { readonly timeoutMs: number; readonly signal: AbortSignal },
): Promise<ElectronDaemonClient> {
  return trusted.connect({
    endpoint,
    ...setup,
    clientName: 'desktop',
    clientVersion: app.getVersion(),
    // Electron main records daemon builds' generation reports (CAN-5627)
    // and daemon reads' read reports (CAN-5691).
    clientCapabilities: [
      WORKER_CODE_GRAPH_GENERATION_REPORT_CAPABILITY,
      WORKER_CODE_GRAPH_READ_REPORT_CAPABILITY,
    ],
    definitions: ELECTRON_DAEMON_DEFINITIONS,
  });
}

/** The record port the daemon-backed W5 store calls, at these versions. */
const W5_REQUIRED_OPERATIONS = {
  ...CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
};

/** Lease-free reads only, so a daemon's idle grace keeps running. */
async function classifyW5Daemon(
  client: ElectronDaemonClient,
  deadline: CanopyDaemonDeadline,
): Promise<CanopyDaemonCapability> {
  const [{ operations }, health] = await deadline.run((signal) => {
    const options = {
      signal,
      metadata: {
        deadlineAt: new Date(Date.now() + deadline.remainingMs()).toISOString(),
      },
    };
    return Promise.all([
      client.query('core.runtime.manifest.get', {}, options),
      // Health only tells writer_held from a daemon to wait out.
      client
        .query('core.runtime.health.get', {}, options)
        .catch(() => undefined),
    ]);
  }, toCanopyClientError);
  return classifyCanopyDaemonCapability({
    required: W5_REQUIRED_OPERATIONS,
    manifest: client.manifest,
    operations,
    ...(health && { checks: health.checks }),
  });
}

/** Closes and refuses a daemon that cannot serve the W5 store. */
async function requireW5Capability(
  client: ElectronDaemonClient,
  signal: AbortSignal,
): Promise<void> {
  const deadline = new CanopyDaemonDeadline(30_000, signal);
  let verdict: CanopyDaemonCapability;
  try {
    verdict = await classifyW5Daemon(client, deadline);
  } catch (error) {
    await client.close();
    throw error;
  } finally {
    deadline.dispose();
  }
  if (verdict.kind === 'accept') return;
  await client.close();
  // The handoff already waited a refused daemon out; a connection never waits.
  throw verdict.kind === 'wait'
    ? canopyDaemonRefusalError(
        'peer_held',
        'Another core is running and cannot serve this app.',
      )
    : canopyDaemonRefusalError(
        verdict.refusal,
        verdict.refusal === 'writer_held'
          ? 'Another app holds the workspace records.'
          : 'The running core serves another version of the workspace records.',
      );
}

export type ElectronW5DaemonProbe =
  /** Nothing live: a launch spawns ours. */
  | { readonly kind: 'absent' }
  | { readonly kind: 'accept' }
  /** A peer holds the log; it will not go idle, so nothing waits. */
  | { readonly kind: 'refuse'; readonly refusal: 'writer_held' }
  /**
   * Live but unable to serve W5, or refusing connections: wait it out. A
   * daemon that outlives the wait refuses `refusal`, else `peer_held`.
   */
  | {
      readonly kind: 'wait';
      readonly descriptor: CanopyRuntimeDescriptor;
      /** An older W5 build's daemon after an update, or an RC or prod peer. */
      readonly refusal?: 'version_skew';
    };

/** GB12 step 1: reads, connects and classifies without a lease; closes what it opened. */
export async function probeElectronDaemonW5(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ElectronW5DaemonProbe> {
  const deadline = new CanopyDaemonDeadline(timeoutMs, signal);
  let client: ElectronDaemonClient | undefined;
  try {
    const trusted = await deadline.run(() => getHost(), toCanopyClientError);
    const found = await deadline.run(
      (probeSignal) =>
        probeCanopyDaemon({
          dataRootHash: trusted.launch.dataRootHash,
          ports: trusted.launch.ports,
          connect: (endpoint, setup) =>
            connectTrusted(trusted, endpoint, setup),
          dispose: (client) => client.close(),
          timeoutMs: deadline.remainingMs(),
          signal: probeSignal,
        }),
      toCanopyClientError,
      (pending) => {
        // Discovery can finish late; its returned client still needs closing.
        void pending
          .then((late) =>
            late.kind === 'live' ? late.value.close() : undefined,
          )
          .catch(() => undefined);
      },
    );
    if (found.kind === 'absent' || found.kind === 'stale')
      return { kind: 'absent' };
    const { descriptor } = found;
    if (found.kind === 'incompatible')
      return { kind: 'wait', descriptor, refusal: 'version_skew' };
    if (found.kind !== 'live') return { kind: 'wait', descriptor };
    client = found.value;
    try {
      const verdict = await classifyW5Daemon(client, deadline);
      if (verdict.kind === 'accept') return verdict;
      if (verdict.kind === 'wait') return { kind: 'wait', descriptor };
      return verdict.refusal === 'writer_held'
        ? { kind: 'refuse', refusal: 'writer_held' }
        : { kind: 'wait', descriptor, refusal: 'version_skew' };
    } catch (error) {
      // Timeout/cancellation may close the socket too; they are not idle exits.
      if (deadline.failure) throw deadline.failure;
      // A daemon exiting on idle can drop the probe mid-read.
      if (
        client.signal.aborted ||
        toCanopyClientError(error).payload.kind === 'unavailable'
      )
        return { kind: 'wait', descriptor };
      throw error;
    }
  } finally {
    deadline.dispose();
    await client?.close();
  }
}

/** Re-reads the descriptor until `descriptor`'s daemon stops publishing. */
export async function waitForElectronDaemonRelease(
  descriptor: CanopyRuntimeDescriptor,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const trusted = await getHost();
  await waitForCanopyDaemonRelease({
    ports: trusted.launch.ports,
    descriptor,
    timeoutMs,
    ...(signal && { signal }),
  });
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

/** Quit, before the W5 slot: ends document sessions, keeping W5 sessions and observation. */
export function disposeElectronDaemonCallerLifetimes(): void {
  // Quitting is never an unreachable service, though W5 sessions stay open.
  getElectronDaemonHealth().stop();
  lifetime?.disposeAll();
}

export async function disposeElectronDaemonConnections(): Promise<void> {
  stopped = true;
  // Before the sessions close: quitting is never an unreachable service.
  getElectronDaemonHealth().stop();
  lifetime?.disposeAll();
  await workspaceCommitEvents
    ?.then((binding) => binding.close())
    .catch(() => undefined);
  getDaemonExecutionStatus().close();
  await connections?.dispose();
}
