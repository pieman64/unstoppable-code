export const OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT =
  'canopy:shared-container-revocation-confirmation-open';

export interface SharedContainerRevocationConfirmationRequest {
  containerId: string;
  /** A member's user id, or the grant id of an email recipient. */
  recipientId: string;
  /** Absent for a personal container. */
  organizationId?: string;
}

function isSharedContainerRevocationConfirmationRequest(
  value: unknown,
): value is SharedContainerRevocationConfirmationRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'containerId' in value &&
    typeof value.containerId === 'string' &&
    'recipientId' in value &&
    typeof value.recipientId === 'string' &&
    (!('organizationId' in value) ||
      value.organizationId === undefined ||
      typeof value.organizationId === 'string')
  );
}

export function requestSharedContainerRevocationConfirmation(
  request: SharedContainerRevocationConfirmationRequest,
): boolean {
  return !window.dispatchEvent(
    new CustomEvent(OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT, {
      detail: request,
      cancelable: true,
    }),
  );
}

export function subscribeToSharedContainerRevocationConfirmationRequests(
  listener: (request: SharedContainerRevocationConfirmationRequest) => boolean,
): () => void {
  const handleRequest = (event: Event): void => {
    if (event.defaultPrevented || !(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (
      isSharedContainerRevocationConfirmationRequest(detail) &&
      listener(detail)
    ) {
      event.preventDefault();
    }
  };
  window.addEventListener(
    OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT,
    handleRequest,
  );
  return () => {
    window.removeEventListener(
      OPEN_SHARED_CONTAINER_REVOCATION_CONFIRMATION_EVENT,
      handleRequest,
    );
  };
}
