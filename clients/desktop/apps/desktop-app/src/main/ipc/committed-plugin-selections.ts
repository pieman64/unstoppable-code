import { isDeepStrictEqual } from 'node:util';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';

/**
 * Whether a live session may take selections its caller already committed
 * through a checked core.chat.update: only while they are still the stored
 * ones, so a later edit is never overwritten or shadowed (CAN-5999).
 */
export function committedSelectionsStillStored(
  stored: ChatTabPluginSelections | undefined,
  committed: ChatTabPluginSelections | undefined,
): boolean {
  return isDeepStrictEqual(
    normalizePluginSelections(stored),
    normalizePluginSelections(committed),
  );
}
