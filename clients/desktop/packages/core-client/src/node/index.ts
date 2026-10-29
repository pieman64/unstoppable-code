// Node entry point (@canopy/core-client/node): socket and named-pipe
// connectors, descriptor discovery, and the attach-or-start launcher.
export {
  connectCanopyClient,
  connectCanopyFramedConnection,
  type CanopyConnectOptions,
} from './connect';
export {
  CANOPY_DAEMON_CLAIM_HANDOFF_ENV,
  createCanopyDaemonHostLaunch,
  type CanopyDaemonHostLaunch,
  type CanopyDaemonHostLaunchOptions,
  type CanopyDaemonHostSupervision,
  type CanopyOwnedDaemonChild,
  type CanopyOwnedDaemonChildren,
} from './daemon-host';
export type { CanopyClientEndpoint } from './endpoint';
export {
  attachOrStartCanopyDaemon,
  type CanopyDaemonLaunchOptions,
  type CanopyDaemonLaunchResult,
} from './launcher';
export {
  classifyCanopyDescriptor,
  parseCanopyRuntimeDescriptor,
  type CanopyDescriptorClassifyInput,
  type CanopyDescriptorState,
} from './descriptor';
export type {
  CanopyDaemonProcessInspector,
  CanopyRuntimeDescriptor,
  CanopyRuntimeDescriptorSource,
} from './daemon-ports';
export type {
  CanopyDaemonSpawnCommand,
  CanopyDaemonSupervisor,
  CanopySpawnedDaemon,
  CanopyStartupClaimAcquisition,
  CanopyStartupClaimHandle,
  CanopyStartupClaimPort,
} from './launcher-ports';
export {
  createRecoverableCanopyStartupClaim,
  type CanopyRetainedStartupClaimPort,
} from './recoverable-startup-claim';
