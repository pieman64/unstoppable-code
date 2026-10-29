import type { JSX } from 'react';
import { Notice } from './Notice';

export interface RepositoryCloneErrorProps {
  readonly message: string;
  readonly id?: string;
  readonly testId?: string;
  readonly prefix?: string;
}

/** Hosts supply safe copy; presentation never decides completion or Retry. */
export function RepositoryCloneError({
  message,
  id,
  testId,
  prefix,
}: RepositoryCloneErrorProps): JSX.Element {
  return (
    <Notice intent="destructive" id={id} data-testid={testId}>
      <span className="break-words">
        {prefix ? `${prefix}: ${message}` : message}
      </span>
    </Notice>
  );
}
