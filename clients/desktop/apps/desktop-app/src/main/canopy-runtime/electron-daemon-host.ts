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
} from '@canopy/core-client/node';
import {
  createOwnedChildServices,
  deriveLocalAuthorityIdentity,
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
  WINDOWS_PROCESS_FILE,
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
  WORKER_QUERY_DEFINITIONS,
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
    // Only the two Files reads the opt-in route serves (CAN-4305).
    'worker.filesystem.roots.list':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.roots.list'],
    'worker.filesystem.directory.list':
      WORKER_QUERY_DEFINITIONS['worker.filesystem.directory.list'],
  },
  instructions: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  streams: {
    'core.runtime.events':
      CORE_TRANSPORT_STREAM_DEFINITIONS['core.runtime.events'],
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
}
const unavailable = (message: string): CanopyClientError =>
  new CanopyClientError({
    kind: 'failed_precondition',
    message,
    retry: { kind: 'never' },
  });

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
  const platform = hostPlatformServices(createPlatformEndpointServices(os), {
    ...(os === 'win32' && {
      windowsProcessPath:
        inputs.windowsProcessPath ??
        (app.isPackaged
          ? join(process.resourcesPath, 'bin', WINDOWS_PROCESS_FILE)
          : typeof __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__ === 'string'
            ? __CANOPY_WINDOWS_PROCESS_SOURCE_PATH__
            : ''),
    }),
  });
  const requestedRoot = resolve(inputs.dataRoot ?? getCanopyDataDir());
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const { authorityId, canonicalDataRoot: dataRoot } =
    await deriveLocalAuthorityIdentity({
      brandId: BRAND.id,
      dataRoot: requestedRoot,
    });
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
  const launch = createCanopyDaemonHostLaunch({
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
