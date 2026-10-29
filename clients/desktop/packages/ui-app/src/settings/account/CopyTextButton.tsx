'use client';

import { useState, type JSX } from 'react';
import { Check, Copy } from '@canopy/ui-shared/icons/AppIcons';

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
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
      className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium fg-primary transition-colors hover:bg-secondary"
    >
      {copied ? (
        <Check size={15} aria-hidden="true" />
      ) : (
        <Copy size={15} aria-hidden="true" />
      )}
      {copied ? copiedLabel : label}
    </button>
  );
}
