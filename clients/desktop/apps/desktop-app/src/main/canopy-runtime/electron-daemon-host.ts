import {
  ELECTRON_MIGRATION_ROLE,
  createElectronMigrationLaunch,
} from './migration-channel';
import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { BRAND } from '@canopy/brand/current';
import {
  CanopyClientError,
  type CanopyClient,
  type CanopyClientOptions,
} from '@canopy/core-client';
import {
  connectCanopyClient,
  createCanopyDaemonHostLaunch,
  createRecoverableCanopyStartupClaim,
  type CanopyConnectOptions,
  type CanopyDaemonBeforeSpawn,
} from '@canopy/core-client/node';
import {
  createOwnedChildServices,
  deriveLocalAuthorityIdentity,
  createPlatformEndpointServices,
  hostLocalAuthorityObservation,
  hostPlatformOperatingSystem,
  hostPlatformServices,
  WINDOWS_PROCESS_FILE,
  windowsPrincipalObserver,
} from '@canopy/core-platform';
import {
  createCanopyStartupClaimPort,
  type CanopyStartupClaimPort,
} from '@canopy/core-transport/node';
import { daemonName, type CanopyRuntimeMode } from '@canopy/protocol/brand';
import {
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  WORKER_QUERY_DEFINITIONS,
  WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
  WORKER_TERMINAL_STREAM_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  getCanopyDataDir,
  getCanopyRuntimeMode,
} from '@canopy/desktop-shared/canopy-paths';
import {
  getBundledBinDir,
  getEnhancedEnv,
} from '@canopy/desktop-shared/pipelines/config-paths';

declare const __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__: string | undefined;

export const ELECTRON_DAEMON_DEFINITIONS = {
  queries: {
    ...CORE_TRANSPORT_QUERY_DEFINITIONS,
    // Only the Files reads the opt-in route has a daemon path for (CAN-4305,
    // CAN-5509); its selection set decides which ones leave.
    'worker.filesystem.roots.list':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.roots.list'],
    'worker.filesystem.directory.list':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.directory.list'],
    'worker.filesystem.file.read':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.file.read'],
    'worker.filesystem.search':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.search'],
    'worker.filesystem.link.resolve':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.link.resolve'],
    // W6g's record port (CAN-5528): served only by a W5 qualification daemon,
    // so production's manifest refuses each call capability_unavailable.
    ...CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
    // The daemon-code-graph experiment's renderer reads (CAN-5089).
    'worker.codeGraph.query':
      WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS['worker.codeGraph.query'],
  },
  instructions: {
    ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
    // The daemon-terminals experiment's renderer terminals (CAN-5088).
    ...WORKER_TERMINAL_INSTRUCTION_DEFINITIONS,
    ...WORKER_TERMINAL_SESSION_INSTRUCTION_DEFINITIONS,
    // And its renderer worktree builds (CAN-5089).
    'worker.codeGraph.build':
      WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS['worker.codeGraph.build'],
    // Worktree cleanup ends the worktree's daemon builds (CAN-5089).
    'worker.codeGraph.builds.cancel':
      WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS[
        'worker.codeGraph.builds.cancel'
      ],
  },
  streams: {
    'core.runtime.events':
      CORE_TRANSPORT_STREAM_DEFINITIONS['core.runtime.events'],
    // W5e: served only by a W5 qualification daemon; production's manifest
    // lacks it, so the subscriber never attaches there.
    'core.events.subscribe':
      CORE_TRANSPORT_STREAM_DEFINITIONS['core.events.subscribe'],
    ...WORKER_TERMINAL_STREAM_DEFINITIONS,
  },
};
type D = typeof ELECTRON_DAEMON_DEFINITIONS;
export type ElectronDaemonClient = CanopyClient<
  D['queries'],
  D['instructions'],
  D['streams']
>;
type ConnectOptions = CanopyConnectOptions &
  Omit<
    CanopyClientOptions<D['queries'], D['instructions'], D['streams']>,
    'connection'
  >;
export interface ElectronDaemonHostInputs {
  /** Trusted main composition only; no renderer fields. */
  readonly dataRoot?: string;
  readonly runtimeMode?: CanopyRuntimeMode;
  readonly executable?: string;
  readonly ownedChildNativePath?: string;
  readonly windowsProcessPath?: string;
  /**
   * The flip launch (CAN-5543): every spawn opens the W5 host, after
   * `beforeSpawn` where the platform has a startup claim.
   */
  readonly w5?: { readonly beforeSpawn?: CanopyDaemonBeforeSpawn };
}
const unavailable = (message: string): CanopyClientError =>
  new CanopyClientError({
    kind: 'failed_precondition',
    message,
    retry: { kind: 'never' },
  });

/** Fixed install or build location only; empty when neither is defined. */
export function selectWindowsProcessPath(
  inputs: ElectronDaemonHostInputs,
): string {
  if (inputs.windowsProcessPath !== undefined) return inputs.windowsProcessPath;
  if (app.isPackaged)
    return join(process.resourcesPath, 'bin', WINDOWS_PROCESS_FILE);
  return typeof __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__ === 'string'
    ? __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__
    : '';
}

/** Uses the H1 shared launch policy and the staged opaque native ownership adapter. */
export async function createElectronDaemonHost(
  inputs: ElectronDaemonHostInputs = {},
): Promise<{
  authorityId: string;
  /** The realpath of the data root the daemon serves; revisions hash it. */
  canonicalDataRoot: string;
  launch: ReturnType<typeof createCanopyDaemonHostLaunch>;
  connect: (options: ConnectOptions) => Promise<ElectronDaemonClient>;
}> {
  const os = hostPlatformOperatingSystem();
  // One selection serves both process inspection and the authority principal.
  const windowsProcessPath =
    os === 'win32' ? selectWindowsProcessPath(inputs) : undefined;
  const platform = hostPlatformServices(createPlatformEndpointServices(os), {
    ...(windowsProcessPath !== undefined && { windowsProcessPath }),
  });
  const requestedRoot = resolve(inputs.dataRoot ?? getCanopyDataDir());
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const { authorityId, canonicalDataRoot: dataRoot } =
    await deriveLocalAuthorityIdentity(
      { brandId: BRAND.id, dataRoot: requestedRoot },
      hostLocalAuthorityObservation(
        windowsProcessPath
          ? windowsPrincipalObserver(windowsProcessPath)
          : undefined,
      ),
    );
  const runtimeDirectory = platform.paths.runtimeDirectory({ dataRoot });
  const name = `${daemonName(BRAND)}${os === 'win32' ? '.exe' : ''}`;
  const executable =
    inputs.executable ??
    (app.isPackaged
      ? join(getBundledBinDir(), name)
      : resolve('dist/core-daemon', name));
  async function privatePath(
    path: string,
    kind: 'file' | 'directory',
  ): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await platform.secureFiles.permissions({
        path,
        kind,
        action: kind === 'directory' ? 'restrict' : 'verify',
        mode: 'owner-only',
      });
      if (result.state === 'private') return;
      if (kind === 'file' && result.reason === 'check failed: ENOENT')
        throw Object.assign(new Error('Core runtime file is absent.'), {
          code: 'ENOENT',
        });
      if (
        kind !== 'file' ||
        ![
          'path changed while opening',
          'path changed during permission check',
        ].includes(result.reason)
      )
        break;
    }
    throw unavailable('Core runtime permissions are not private.');
  }
  const prepareRuntime = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    if ((await realpath(dataRoot)) !== dataRoot)
      throw unavailable('Core data root is not canonical.');
    await privatePath(dataRoot, 'directory');
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
    if ((await realpath(runtimeDirectory)) !== runtimeDirectory)
      throw unavailable('Core runtime directory is not canonical.');
    await privatePath(runtimeDirectory, 'directory');
    signal.throwIfAborted();
  };
  let claims: Promise<CanopyStartupClaimPort> | undefined;
  const claimPort = (): Promise<CanopyStartupClaimPort> => {
    claims ??= (async (): Promise<CanopyStartupClaimPort> => {
      const self = await platform.supervision.inspectProcess({
        pid: process.pid,
      });
      if (self.state !== 'running')
        throw unavailable('Core launcher process identity is unverifiable.');
      return createCanopyStartupClaimPort({
        dataRoot,
        owner: { pid: process.pid, startIdentity: self.startIdentity },
        inspectProcess: async (pid, signal) => {
          const state = await platform.supervision.inspectProcess({
            pid,
            signal,
          });
          return state.state === 'running'
            ? { kind: 'alive', startIdentity: state.startIdentity }
            : { kind: state.state === 'absent' ? 'dead' : 'unknown' };
        },
      });
    })();
    void claims.catch(() => {
      claims = undefined;
    });
    return claims;
  };
  const address = platform.endpoints.address({
    dataRoot,
    endpointName: 'core',
  });
  const migration = createElectronMigrationLaunch({
    enabled: ELECTRON_MIGRATION_ROLE.enabled,
  });
  const launch = createCanopyDaemonHostLaunch({
    ...(migration && { migration }),
    dataRoot,
    runtimeMode: inputs.runtimeMode ?? getCanopyRuntimeMode(),
    executable,
    platform: os,
    supervision: platform.supervision,
    ownedChildren: createOwnedChildServices({
      os,
      nativePath:
        inputs.ownedChildNativePath ??
        (app.isPackaged
          ? join(process.resourcesPath, 'cli/core-owned-child.node')
          : resolve(
              '.cache/native-owned-child',
              `${os}-${process.arch}`,
              'core-owned-child.node',
            )),
    }),
    ...(inputs.w5 && { w5Host: true }),
    ...(inputs.w5?.beforeSpawn && { beforeSpawn: inputs.w5.beforeSpawn }),
    environmentSource: getEnhancedEnv({
      includeCanopySecrets: false,
      environment: false,
    }),
    prepareRuntime,
    expectedEndpoint: {
      kind: address.kind === 'unix-socket' ? 'socket' : 'pipe',
      path: address.path,
    },
    verifyPrivateFile: async (path, signal): Promise<void> => {
      signal.throwIfAborted();
      await privatePath(path, 'file');
      signal.throwIfAborted();
    },
    ...(os !== 'win32' && {
      claim: createRecoverableCanopyStartupClaim(claimPort),
    }),
  });
  return {
    authorityId,
    canonicalDataRoot: dataRoot,
    launch,
    async connect(options): Promise<ElectronDaemonClient> {
      const signal = options.signal ?? new AbortController().signal;
      await launch.verifyRuntime(signal);
      const client = await connectCanopyClient(options);
      try {
        await launch.verifyRuntime(signal);
        return client;
      } catch (error) {
        await client.close();
        throw error;
      }
    },
  };
}
