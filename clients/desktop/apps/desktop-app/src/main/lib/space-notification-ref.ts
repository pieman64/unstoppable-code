import { createHash, createHmac } from 'node:crypto';
import type { SpaceNotificationSource } from '@canopy/protocol/space-notifications';

/**
 * The producer id this install uses for notification spaces: a one-way,
 * feature-scoped derivation of the OAuth device id. The device id itself can
 * mint a guest session, so it must never travel in a request path or be
 * stored with a space.
 */
export function spaceNotificationProducerId(clientDeviceId: string): string {
  return createHash('sha256')
    .update('space-notifications-producer\0')
    .update(clientDeviceId)
    .digest('hex');
}

/**
 * The server-facing reference for one local id in a space identity
 * (CAN-3615). Workspace ids are derived from project names, and the desktop
 * registers its spaces whether or not telemetry sharing is on, so it sends a
 * digest keyed by the derived producer id instead of the id itself. This
 * keeps raw names out of requests and logs; it is not anonymity, because the
 * server also receives the producer id and could recompute a digest for a
 * guessed name. The server only compares these for equality; producer sync
 * and telemetry provenance must both go through this one function so they
 * name the same space.
 */
export function spaceNotificationRef(producerId: string, id: string): string {
  return createHmac('sha256', producerId).update(id).digest('base64url');
}

export function spaceNotificationSourceRef(
  producerId: string,
  source: SpaceNotificationSource,
): SpaceNotificationSource {
  return {
    workspaceId: spaceNotificationRef(producerId, source.workspaceId),
    spaceId: spaceNotificationRef(producerId, source.spaceId),
  };
}
