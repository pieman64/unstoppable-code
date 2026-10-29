import {
  readPortalChatPartVisual,
  type PortalChatPart,
} from '@canopy/protocol/portal';

/**
 * Tolerate older or malformed Portal parts; only a complete visual reference
 * counts, because a Portal read needs every field of it.
 */
export function portalPartHasVisual(part: PortalChatPart): boolean {
  return readPortalChatPartVisual(part) !== null;
}
