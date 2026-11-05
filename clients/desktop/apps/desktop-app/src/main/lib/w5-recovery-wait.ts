import {
  CANOPY_CLIENT_PROTOCOL_VERSIONS,
  toCanopyClientError,
} from '@canopy/core-client';
import {
  CanopyDaemonDeadline,
  classifyCanopyDescriptor,
  waitForCanopyDaemonRelease,
  type CanopyRuntimeDescriptorSource,
  type CanopyDaemonProcessInspector,
} from '@canopy/core-client/node';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  readW5RecoveryDescriptor,
  requirePrivateW5RecoveryRuntime,
} from './w5-recovery-request';

/** One 45 s budget, with no connection, lease, signal authority or runtime repair. */
export async function waitForW5RecoveryDaemonRelease(
  dataRoot: string,
  signal: AbortSignal,
): Promise<void> {
  await requirePrivateW5RecoveryRuntime(dataRoot);
  const platform = hostPlatformServices(
    createPlatformEndpointServices(hostPlatformOperatingSystem()),
  );
  const descriptor: CanopyRuntimeDescriptorSource = {
    read: () => readW5RecoveryDescriptor(dataRoot),
    readToken: (): Promise<never> =>
      Promise.reject(new Error('Recovery never reads a daemon token.')),
  };
  const supervisor: CanopyDaemonProcessInspector = {
    inspectProcess: async (pid, signal) => {
      const inspected = await platform.supervision.inspectProcess({
        pid,
        signal,
      });
      if (inspected.state === 'running')
        return { startIdentity: inspected.startIdentity };
      if (inspected.state === 'absent') return null;
      throw new Error('Process identity is unprovable.');
    },
  };
  const deadline = new CanopyDaemonDeadline(45_000, signal);
  try {
    const found = await deadline.run(
      (signal) =>
        classifyCanopyDescriptor({
          source: descriptor,
          supervisor,
          protocolVersions: CANOPY_CLIENT_PROTOCOL_VERSIONS,
          signal,
        }),
      toCanopyClientError,
    );
    if (found.kind === 'absent' || found.kind === 'stale') return;
    const replacement = await waitForCanopyDaemonRelease({
      ports: { descriptor, supervisor },
      descriptor: found.descriptor,
      timeoutMs: deadline.remainingMs(),
      signal,
    });
    if (replacement.kind !== 'absent' && replacement.kind !== 'stale')
      throw Object.assign(
        new Error('Another background service started during recovery.'),
        { reason: 'replacement-daemon' },
      );
  } finally {
    deadline.dispose();
  }
}
