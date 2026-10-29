import type { JSX } from 'react';

import { StatusPill } from '@canopy/ui-shared/components';

/**
 * Read-only status marker for a shared container, in the sidebar row and the
 * recipient surface header.
 *
 * A pill rather than an outlined box: this is state the recipient reads, not a
 * control they can act on, and the previous bordered treatment read as a
 * disabled button sitting next to real ones. Shape and metrics come from the
 * shared `StatusPill` rather than being restated here, so this and
 * `CapabilityPill` stay one visual family by construction.
 */
export function ViewOnlyPill(): JSX.Element {
  return (
    <StatusPill data-testid="shared-container-read-only-badge">
      View only
    </StatusPill>
  );
}
