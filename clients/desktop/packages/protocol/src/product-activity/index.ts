export const PRODUCT_ACTIVITY_TURNS_PATH = '/api/v1/product-activity/turns';

/**
 * `turnKey` is the lowercase SHA-256 hex digest of the UTF-8 value returned by
 * `clampTelemetryClientId(entry.id, MAX_TELEMETRY_CLIENT_ID_LENGTH)`. Turn IDs
 * are not affected by CAN-3517 worktree-ID namespacing.
 */
export interface ProductActivityTurnRequest {
  readonly turnKey: string;
  readonly organizationExternalId?: string;
}

export const PRODUCT_ACTIVITY_TURN_KEY_PATTERN = /^[0-9a-f]{64}$/;

export const MAX_PRODUCT_ACTIVITY_ORGANIZATION_ID_LENGTH = 128;
