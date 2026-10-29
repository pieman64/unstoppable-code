import type { JSX, ReactNode } from 'react';

/** The context switcher and its trailing actions share one sidebar row. */
export function SidebarContextHeader({
  children,
  action,
  testId,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly testId: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className="relative flex shrink-0 items-center gap-1 px-2 pt-2"
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action ? (
        <div className="flex shrink-0 items-center gap-0.5">{action}</div>
      ) : null}
    </div>
  );
}
