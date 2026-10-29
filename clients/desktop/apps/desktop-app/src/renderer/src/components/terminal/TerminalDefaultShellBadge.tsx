import type { JSX } from 'react';
import { brandText } from '@/lib/brand';

export const TERMINAL_DEFAULT_SHELL_TOOLTIP = `This shell will be used for interactive scripts invoked by ${brandText.appName}.`;

export function TerminalDefaultShellBadge({
  testId,
  focusable = false,
}: {
  testId: string;
  focusable?: boolean;
}): JSX.Element {
  return (
    <span
      role="note"
      aria-label="Default shell"
      tabIndex={focusable ? 0 : undefined}
      data-testid={testId}
      className="inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-2xs font-medium leading-none fg-tertiary"
    >
      Default
    </span>
  );
}
