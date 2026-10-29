import type { AiGatewayCatalogStatus } from '@canopy/desktop-shared/types';

/**
 * Process-wide projection of the AI Gateway catalog service for the model
 * registry snapshot and the renderer retry request. `undefined` means no
 * catalog service is running (for example, no cloud origin is configured), so
 * no fetch is ever attempted and the renderer must not report a failure.
 */
let currentStatus: AiGatewayCatalogStatus | undefined;
let retryHandler: (() => Promise<void>) | undefined;

export function getAiGatewayCatalogStatus():
  | AiGatewayCatalogStatus
  | undefined {
  return currentStatus;
}

/** Returns true when the stored status changed. */
export function setAiGatewayCatalogStatus(
  status: AiGatewayCatalogStatus | undefined,
): boolean {
  if (currentStatus === status) return false;
  currentStatus = status;
  return true;
}

export function setAiGatewayCatalogRetryHandler(
  handler: (() => Promise<void>) | undefined,
): void {
  retryHandler = handler;
}

/** Retry the catalog fetch now; a no-op when no catalog service is running. */
export async function retryAiGatewayModelCatalog(): Promise<void> {
  await retryHandler?.();
}
