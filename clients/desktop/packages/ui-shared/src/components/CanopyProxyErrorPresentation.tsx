import type { JSX, ReactNode } from 'react';
import { MODEL_LIBRARY_UNLOCK_COPY } from './modelLibraryLock';
import { Notice } from './Notice';

export interface CanopyProxyErrorPresentationProps {
  state: 'unresolved' | 'resolved';
  role: 'alert' | 'status';
  dataTestId: string;
  title?: ReactNode;
  children?: ReactNode;
  correlationId?: string | null;
  /** Inline diagnostics in a message, or a supporting line in a short replay. */
  diagnostics: 'inline' | 'supporting';
  detail?: ReactNode;
  actions?: ReactNode;
}

/** Proxy refusal display shared by interactive notices and read-only replays. */
export function CanopyProxyErrorPresentation({
  state,
  role,
  dataTestId,
  title,
  children,
  correlationId,
  diagnostics,
  detail,
  actions,
}: CanopyProxyErrorPresentationProps): JSX.Element {
  const resolved = state === 'resolved';
  // A resolved notice reports that nothing is wrong any more, so it carries no
  // error id: "Error id" under a confirmation reads as a fresh failure.
  const errorId =
    correlationId && !resolved ? (
      diagnostics === 'inline' ? (
        <span className="whitespace-nowrap">
          Error id{' '}
          <span
            data-testid={`${dataTestId}-correlation-id`}
            className="font-mono select-all"
          >
            {correlationId}
          </span>
        </span>
      ) : (
        <>
          Error id:{' '}
          <span
            className="font-mono text-2xs"
            data-testid={`${dataTestId}-correlation-id`}
          >
            {correlationId}
          </span>
        </>
      )
    ) : null;
  return (
    <Notice
      intent={resolved ? 'positive' : 'attention'}
      role={resolved ? 'status' : role}
      data-testid={dataTestId}
      // Transcript rows size to their content, and the notice's container
      // query gives it no intrinsic width; this marker lets the desktop and
      // Portal rows stretch it to the reading width instead.
      data-chat-notice=""
      title={
        resolved ? (
          <span data-testid={`${dataTestId}-unlock-confirmed`}>
            {MODEL_LIBRARY_UNLOCK_COPY.confirmed}
          </span>
        ) : (
          title
        )
      }
      detail={
        resolved ? undefined : diagnostics === 'supporting' ? errorId : detail
      }
      actions={actions}
    >
      {resolved ? null : (
        <>
          {children}
          {diagnostics === 'inline' && errorId ? <> {errorId}</> : null}
        </>
      )}
    </Notice>
  );
}
