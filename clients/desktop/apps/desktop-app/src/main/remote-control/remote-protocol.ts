export * from '@canopy/protocol/remote-control';
import {
  CHANNEL_UNAVAILABLE_CODE,
  UNKNOWN_METHOD_CODE,
  unknownMethodMessage,
} from '@canopy/protocol/remote-control';
import { RpcRemoteError } from './transport/rpc-peer';

/**
 * Whether the other computer answered that it does not serve `method`.
 * Releases before the error code sent the same message without it.
 */
export function isUnknownRemoteMethodError(
  error: unknown,
  method: string,
): boolean {
  return (
    error instanceof RpcRemoteError &&
    (error.code === UNKNOWN_METHOD_CODE ||
      error.message === unknownMethodMessage(method))
  );
}

/** Whether the other computer answered that it does not tunnel the channel called. */
export function isRemoteChannelUnavailableError(error: unknown): boolean {
  return (
    error instanceof RpcRemoteError && error.code === CHANNEL_UNAVAILABLE_CODE
  );
}
