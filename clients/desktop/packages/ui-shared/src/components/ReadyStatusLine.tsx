import type { JSX, ReactNode } from 'react';
import { CheckIcon } from '../icons/AppIcons';

export interface ReadyStatusLineProps {
  /** The sentence that says what is ready to use. */
  readonly children: ReactNode;
  readonly 'data-testid'?: string;
}

/**
 * A "ready to use" line: a decorative green check before one sentence. The
 * check means ready only, so offers, hand-offs and attention lines stay plain
 * text (CAN-4765).
 */
export function ReadyStatusLine({
  children,
  'data-testid': dataTestId,
}: ReadyStatusLineProps): JSX.Element {
  return (
    <span data-testid={dataTestId} className="flex items-start gap-1">
      <CheckIcon aria-hidden size={12} className="mt-0.5 shrink-0 fg-success" />
      <span>{children}</span>
    </span>
  );
}
