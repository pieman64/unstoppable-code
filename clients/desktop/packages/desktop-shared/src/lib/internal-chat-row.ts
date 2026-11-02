/**
 * Whether a send request is an internal row that no surface may render.
 * Only a host-issued managed delegation delivery id makes a row internal:
 * dispatch checks that id against a live delegation delivery, so it cannot
 * be forged, while an `internalRow` marker alone is not trusted. Rows a
 * previous build queued carry only the delivery id and still count.
 */
export function isInternalChatRequest(request: {
  managedDelegationDeliveryId?: string;
}): boolean {
  // Dispatch skips its owner check for an empty id, so an empty id is never
  // host-issued.
  return (
    typeof request.managedDelegationDeliveryId === 'string' &&
    request.managedDelegationDeliveryId.length > 0
  );
}
