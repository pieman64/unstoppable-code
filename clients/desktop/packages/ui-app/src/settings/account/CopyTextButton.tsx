'use client';

import type { JSX } from 'react';
import { CopyButton } from '@canopy/ui-shared/components';

interface CopyTextButtonProps {
  /** The text copied to the clipboard on click. */
  value: string;
  /** Button label (idle state). */
  label: string;
  /** Optional label shown for ~2s after a successful copy. */
  copiedLabel?: string;
}

/** Small client-only copy-to-clipboard button used on the public share pages. */
export function CopyTextButton({
  value,
  label,
  copiedLabel = 'Copied',
}: CopyTextButtonProps): JSX.Element {
  return (
    <CopyButton
      value={value}
      label={label}
      ariaLabel={label}
      title={label}
      copiedLabel={copiedLabel}
      variant="secondary"
      size="compact"
      copiedDurationMs={2000}
    />
  );
}
