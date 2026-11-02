import type { JSX } from 'react';

interface PlansEmptyMessageProps {
  /** The host can import a plan here, so the copy explains why you would. */
  readonly canImport: boolean;
}

/** What an empty Plans section explains, on the desktop and the Portal. */
export function PlansEmptyMessage({
  canImport,
}: PlansEmptyMessageProps): JSX.Element {
  return (
    <p className="text-xs fg-secondary">
      Plans your agent writes appear here.
      {canImport &&
        ' Import a Markdown plan to review it, comment on it, and hand it to an agent.'}
    </p>
  );
}
