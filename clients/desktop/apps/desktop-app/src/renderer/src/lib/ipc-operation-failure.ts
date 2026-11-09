import {
  safeErrorProperty,
  type IpcOperationFailure,
} from '@canopy/desktop-shared/ipc/app-error-rejection';
import { IpcOperationFailureSchema } from '@canopy/desktop-shared/ipc/operation-failure';

/**
 * A caught daemon failure's status, retry directive and effects, when preload
 * can attribute them. Same-message failures that disagree resolve to a miss.
 * A miss proves nothing: never treat it as permission to retry a mutation.
 * Kept apart from `ipc-app-error`, which loads at renderer startup, because the
 * schema pulls in the protocol catalog; CAN-4405 is its first consumer.
 */
export function resolveIpcOperationFailure(
  value: unknown,
): IpcOperationFailure | undefined {
  const message = safeErrorProperty(value, 'message');
  if (typeof message !== 'string') return undefined;
  const parsed = IpcOperationFailureSchema.safeParse(
    window.appErrors?.resolveOperationFailure(message),
  );
  return parsed.success ? parsed.data : undefined;
}
