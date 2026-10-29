import type { JSX, ReactNode } from 'react';

export interface CustomizeInstalledUnavailableProps {
  readonly title: string;
  readonly body: string;
  /** The host's existing pairing or sign-in control; omitted when neither applies. */
  readonly action?: ReactNode;
  readonly dataTestId?: string;
}

/** Capability-gated Installed state: inventory cannot be read on this host yet. */
export function CustomizeInstalledUnavailable({
  title,
  body,
  action,
  dataTestId = 'customize-installed-unavailable',
}: CustomizeInstalledUnavailableProps): JSX.Element {
  return (
    <div
      data-testid={dataTestId}
      className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-xl bg-subtle px-4 py-3.5"
    >
      <div className="min-w-0">
        <p className="text-s font-medium fg-primary">{title}</p>
        <p className="mt-0.5 text-xs fg-secondary">{body}</p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
