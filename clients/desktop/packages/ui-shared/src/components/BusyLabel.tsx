import type { JSX, ReactNode } from 'react';
import { LoadingSpinner } from './LoadingSpinner';
import { useLoadingIndicatorStyle } from './LoadingIndicatorStyle';

/**
 * A control's label while its work runs ("Load more" while the next page
 * loads). Under the `text` loading style the label is replaced by
 * `busyText`. Under `spinner` the label stays in place, invisible, so the
 * control keeps its width, and a spinner sits centered over it. The control
 * should also set `aria-busy` and usually `disabled`.
 */
export function BusyLabel({
  busy,
  busyText = 'Loading…',
  children,
}: {
  readonly busy: boolean;
  /** Copy shown while busy under the `text` loading style. */
  readonly busyText?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const style = useLoadingIndicatorStyle();
  if (style === 'text') {
    return <>{busy ? busyText : children}</>;
  }
  return (
    <span className="relative inline-flex items-center justify-center">
      <span className={busy ? 'invisible' : undefined}>{children}</span>
      {busy ? (
        <span className="absolute inset-0 flex items-center justify-center">
          <LoadingSpinner sizePx={14} />
        </span>
      ) : null}
    </span>
  );
}
