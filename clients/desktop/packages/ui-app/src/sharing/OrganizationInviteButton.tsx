'use client';

import type { JSX } from 'react';

/** The shared organization invite control, with permission resolved by its host. */
export function OrganizationInviteButton({
  onClick,
  testId,
}: {
  readonly onClick: () => void;
  readonly testId?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="focus-ring rounded-lg bg-accent px-3 py-1.5 text-s font-medium fg-emphasis transition hover:opacity-90"
      data-testid={testId}
      onClick={onClick}
    >
      Invite a teammate
    </button>
  );
}
