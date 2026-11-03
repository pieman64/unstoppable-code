import type { JSX, ReactNode } from 'react';
import {
  GUEST_MODEL_GATE_DAILY_CREDITS_COPY,
  guestModelGateCopy,
  type GuestModelFallbackAccess,
  type GuestModelGateCopyInput,
  type GuestModelGateCopy,
} from './guestModelGate';
import { Button, buttonClassName } from './Button';
import { LoadingSpinner } from './LoadingSpinner';

/**
 * The gate's primary action styling. Hosts render the control themselves (an
 * anchor on the web, a button on desktop), so the class travels with the label
 * and the two cannot drift.
 */
const GUEST_MODEL_GATE_PRIMARY_CLASS = buttonClassName({
  variant: 'primary',
  size: 'lg',
  className: 'w-full',
});

/** Refusals without a display label retain their existing generic copy. */
export type GuestModelGateSubject =
  | Omit<GuestModelGateCopyInput, 'fallbackLabel' | 'fallbackAccess'>
  | { readonly copy: Omit<GuestModelGateCopy, 'fallbackAction'> };

export interface GuestModelGateContentProps {
  readonly subject: GuestModelGateSubject;
  readonly fallback?: {
    readonly label: string;
    /** Defaults to `now`. */
    readonly access?: GuestModelFallbackAccess;
    readonly onActivate: () => void;
  };
  /**
   * A retry that only re-checks, rendered in the fallback's place when the
   * fallback is withdrawn (CAN-5211: daily credits were turned on, but the
   * balance could not be confirmed or the selection was refused).
   */
  readonly recheck?: { readonly onActivate: () => void };
  /**
   * Hosts retain sign-in navigation and authentication, including its ref.
   * `className` is the shared primary styling; apply it as given.
   */
  readonly renderSignIn: (label: string, className: string) => ReactNode;
  readonly onDismiss: () => void;
  readonly busy?: boolean;
  readonly error?: string | null;
  /** Neutral progress, announced, and kept when the fallback is withdrawn. */
  readonly status?: string | null;
  readonly dataTestId: string;
  readonly bodyTestId?: string;
  readonly dismissTestId?: string;
}

/** The same guest gate body and ordered actions on every supported host. */
export function GuestModelGateContent({
  subject,
  fallback,
  recheck,
  renderSignIn,
  onDismiss,
  busy = false,
  error,
  status,
  dataTestId,
  bodyTestId = `${dataTestId}-body`,
  dismissTestId = `${dataTestId}-dismiss`,
}: GuestModelGateContentProps): JSX.Element {
  const actionableFallback = 'copy' in subject ? undefined : fallback;
  const fallbackAccess = actionableFallback?.access ?? 'now';
  const copy: GuestModelGateCopy =
    'copy' in subject
      ? subject.copy
      : guestModelGateCopy({
          ...subject,
          ...(actionableFallback === undefined
            ? {}
            : { fallbackLabel: actionableFallback.label, fallbackAccess }),
        });
  const spinner = (testId: string): ReactNode =>
    busy && <LoadingSpinner dataTestId={testId} decorative />;
  return (
    <div className="flex flex-col gap-4 px-6 pb-6 pt-4">
      <div
        className="text-s leading-relaxed fg-secondary"
        data-testid={bodyTestId}
      >
        {copy.body}
      </div>
      {error && (
        <div role="status" data-testid={`${dataTestId}-fallback-blocked`}>
          {error}
        </div>
      )}
      {status && (
        <div
          role="status"
          className="text-s fg-secondary"
          data-testid={`${dataTestId}-fallback-status`}
        >
          {status}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {renderSignIn(copy.signInAction, GUEST_MODEL_GATE_PRIMARY_CLASS)}
        {actionableFallback && (
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            data-testid={`${dataTestId}-guest-fallback`}
            data-fallback-access={fallbackAccess}
            disabled={busy}
            onClick={actionableFallback.onActivate}
          >
            {spinner(`${dataTestId}-guest-fallback-spinner`)}
            {copy.fallbackAction}
          </Button>
        )}
        {!actionableFallback && recheck && (
          <Button
            variant="outline"
            size="lg"
            className="w-full"
            data-testid={`${dataTestId}-guest-fallback-recheck`}
            disabled={busy}
            onClick={recheck.onActivate}
          >
            {spinner(`${dataTestId}-guest-fallback-spinner`)}
            {GUEST_MODEL_GATE_DAILY_CREDITS_COPY.recheckAction}
          </Button>
        )}
        <Button
          variant="ghost"
          size="lg"
          className="w-full"
          data-testid={dismissTestId}
          disabled={busy}
          onClick={onDismiss}
        >
          {copy.dismissAction}
        </Button>
      </div>
    </div>
  );
}
