'use client';

import type { JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';

/**
 * The shared organization invite control, with permission resolved by its
 * host: the primary action, drawn as the 28px compact capsule.
 */
export function OrganizationInviteButton({
  onClick,
  testId,
}: {
  readonly onClick: () => void;
  readonly testId?: string;
}): JSX.Element {
  return (
    <Button
      size="compact"
      variant="primary"
      data-testid={testId}
      onClick={onClick}
    >
      Invite a teammate
    </Button>
  );
}
