import { BRAND } from '@canopy/brand/current';
import type { DesktopShareDeepLinkAudience } from '@canopy/protocol';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
  requestCanopyCloudPublicJson,
} from './client';

/**
 * Desktop legs of the CAN-2361 share-handoff funnel
 * (APP_OPENED → INSTALLED → TRY_NOW), posted to the web beacon route.
 * Fire-and-forget: never throws, never blocks a user action, and downgrades
 * to the anonymous transport when no cloud credentials exist — signed-out
 * opens still count (accepted product decision). Payloads are ids and enums
 * only.
 */

export interface ShareHandoffEventInput {
  entity:
    | 'skill'
    | 'pipeline'
    | 'plugin'
    | 'agent'
    | 'workspace'
    | 'collection'
    | 'automation';
  externalId: string;
  eventType: 'APP_OPENED' | 'INSTALLED' | 'TRY_NOW';
  audience?: DesktopShareDeepLinkAudience;
}

function beaconPath(): string {
  return `/api/v1/${BRAND.web.apiNamespace}/share-events/desktop-handoff`;
}

export async function reportShareHandoffEvent(
  input: ShareHandoffEventInput,
): Promise<void> {
  const body = JSON.stringify({
    entityType:
      input.entity === 'skill'
        ? 'SKILL'
        : input.entity === 'pipeline'
          ? 'PIPELINE'
          : input.entity === 'plugin'
            ? 'PLUGIN'
            : input.entity === 'agent'
              ? 'AGENT'
              : input.entity === 'collection'
                ? 'COLLECTION'
                : input.entity === 'automation'
                  ? 'AUTOMATION'
                  : 'WORKSPACE_TEMPLATE',
    eventType: input.eventType,
    audience: input.audience ?? 'PUBLIC',
    entityExternalId: input.externalId,
  });
  try {
    await requestCanopyCloudJson(beaconPath(), { method: 'POST', body });
  } catch (error) {
    const missingCredentials =
      error instanceof CanopyCloudClientError &&
      (error.code === 'missing-api-key' ||
        error.code === 'cloud-not-configured');
    if (!missingCredentials) return;
    try {
      await requestCanopyCloudPublicJson(beaconPath(), {
        method: 'POST',
        body,
      });
    } catch {
      // Anonymous fallback is best-effort too.
    }
  }
}
