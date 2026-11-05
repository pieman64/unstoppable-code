import type { CanopyStreamCursor } from '@canopy/protocol/canopy-core';

/**
 * Where a stream that ends before its `refused` item stands: the last item it
 * delivered, else the cursor it resumed from, else just before `refused`. A
 * resume from it reads the refused item again rather than skipping it.
 */
export function streamPositionBefore(
  refused: CanopyStreamCursor,
  delivered: CanopyStreamCursor | undefined,
  accepted: CanopyStreamCursor | null,
): CanopyStreamCursor {
  return (
    delivered ??
    accepted ?? {
      daemonEpoch: refused.daemonEpoch,
      sequence: Math.max(0, refused.sequence - 1),
    }
  );
}
