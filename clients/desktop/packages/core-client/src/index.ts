// Browser-safe facade: production code here imports only @canopy/protocol and
// @canopy/core-transport/types. The Node connector lives under src/node/ and is
// exported only as @canopy/core-client/node; it stays out of this file.
export type {
  CanopyByteChannel,
  CanopyChannelCapsInput,
  CanopyChannelOpenRequest,
  CanopyFramedConnection,
} from '@canopy/core-transport/types';
export type {
  CanopyJsonRpcErrorResponse,
  CanopyJsonRpcMessage,
  CanopyJsonRpcNotification,
  CanopyJsonRpcRequest,
  CanopyJsonRpcSuccessResponse,
  CoreRuntimeInitializeResult,
} from '@canopy/protocol/canopy-core';

export { createCanopyClient } from './client';
export { createCanopyEventSubscription } from './events/subscription';
export type * from './events/types';
export {
  createCanopyAuthorityRegistry,
  type CanopyAuthorityConnection,
  type CanopyAuthorityCursorSlot,
  type CanopyAuthorityRegistry,
  type CanopyAuthorityRegistryOptions,
  type CanopyCommandDestination,
  type CanopyResolvedRoute,
} from './authority-registry';
export {
  CANOPY_CLIENT_PROTOCOL_VERSIONS,
  CanopyClientError,
  decodeCanopyClientResponseError,
  toCanopyClientError,
} from './errors';
export {
  acceptCanopyInitializeResult,
  buildCanopyInitializeParams,
  toCanopyInitializeError,
  type CanopyAcceptedInitialize,
  type CanopyInitializeParamsInput,
} from './handshake';
export {
  createCanopyClientLease,
  type CanopyClientLease,
  type CanopyClientLeaseIdentity,
  type CanopyClientLeaseOptions,
  type CanopyClientLeasePresence,
  type CanopyClientLeaseRegistration,
  type CanopyClientLeaseReleaseReason,
  type CanopyClientLeaseState,
  type CanopyLeaseClient,
} from './lease';
export type * from './types';
