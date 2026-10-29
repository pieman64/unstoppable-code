import type { JSX } from 'react';
import { CloseIcon } from '../icons/AppIcons';
import { MCP_ROW_ACTION_CLASS_NAME } from '../lib/mcp-card-display';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { SECONDARY_SURFACE_CLASS } from '../lib/row-chips';
import { Button, buttonClassName } from './Button';
import { LoadingSpinner } from './LoadingSpinner';
import { Tooltip } from './Tooltip';

/** The status of an MCP sign-in that waits in another tab. */
export const MCP_SIGN_IN_WAITING_LABEL = 'Waiting for sign-in';
/** {@link MCP_SIGN_IN_WAITING_LABEL} where a row's status pill has to fit it. */
export const MCP_SIGN_IN_WAITING_SHORT_LABEL = 'Waiting…';
export const MCP_SIGN_IN_REOPEN_LABEL = 'Reopen sign-in';
export const MCP_SIGN_IN_CANCEL_LABEL = 'Cancel sign-in';

// Waiting on sign-in is an operational state, so it takes the stable active
// status palette rather than the brand accent.
const WAITING_PILL_CLASS_NAME = `${OPERATIONAL_STATUS_COLORS.active.backgroundBadge} ${OPERATIONAL_STATUS_COLORS.active.foreground}`;

interface McpSignInPendingStatusProps {
  /**
   * `pill` is a server row's status pill (**Waiting…**); `inline` is a
   * detail line or dialog field (**Waiting for sign-in**).
   */
  variant?: 'inline' | 'pill';
  dataTestId?: string;
}

/** Announces that an MCP sign-in is waiting on its tab. */
export function McpSignInPendingStatus({
  variant = 'inline',
  dataTestId,
}: McpSignInPendingStatusProps): JSX.Element {
  if (variant === 'pill')
    return (
      <span
        role="status"
        className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium ${WAITING_PILL_CLASS_NAME}`}
        data-testid={dataTestId}
      >
        <LoadingSpinner decorative />
        {MCP_SIGN_IN_WAITING_SHORT_LABEL}
      </span>
    );
  return (
    <span
      role="status"
      className="flex items-center gap-2"
      data-testid={dataTestId}
    >
      <LoadingSpinner decorative tone="active" />
      {MCP_SIGN_IN_WAITING_LABEL}
    </span>
  );
}

interface McpSignInPendingActionsProps {
  /** The sign-in page; Reopen opens it in a new tab. */
  authorizationUrl: string;
  /** Stops waiting. Without it, a compact row offers only Reopen. */
  onCancel?: () => void;
  /**
   * `compact` is a server row's **Reopen** and an icon-only cancel; `full`
   * is a dialog footer's **Cancel** and **Reopen sign-in**.
   */
  variant?: 'compact' | 'full';
  /** Secondary when another shared primary owns the detail header. */
  reopenVariant?: 'primary' | 'secondary';
  /** The full variant's dismiss label, e.g. **Done** where it closes the dialog. */
  cancelLabel?: string;
  /** Prefix for the `-reopen` and `-cancel` hooks. */
  dataTestId?: string;
}

/** Reopens a waiting MCP sign-in, or stops waiting on it. */
export function McpSignInPendingActions({
  authorizationUrl,
  onCancel,
  variant = 'full',
  reopenVariant = 'primary',
  cancelLabel = 'Cancel',
  dataTestId = 'mcp-sign-in-pending',
}: McpSignInPendingActionsProps): JSX.Element {
  if (variant === 'compact')
    return (
      <span className="flex items-center gap-0.5">
        <a
          className={`${MCP_ROW_ACTION_CLASS_NAME} ${SECONDARY_SURFACE_CLASS} fg-primary`}
          href={authorizationUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={MCP_SIGN_IN_REOPEN_LABEL}
          data-testid={`${dataTestId}-reopen`}
        >
          Reopen
        </a>
        {onCancel !== undefined && (
          <Tooltip label={MCP_SIGN_IN_CANCEL_LABEL}>
            <button
              type="button"
              className="focus-ring inline-flex h-5 w-5 items-center justify-center rounded-md fg-secondary transition-colors hover:bg-secondary hover:fg-primary"
              aria-label={MCP_SIGN_IN_CANCEL_LABEL}
              onClick={onCancel}
              data-testid={`${dataTestId}-cancel`}
            >
              <CloseIcon size={12} aria-hidden="true" />
            </button>
          </Tooltip>
        )}
      </span>
    );
  return (
    <>
      {onCancel !== undefined && (
        <Button
          variant="ghost"
          size="md"
          onClick={onCancel}
          data-testid={`${dataTestId}-cancel`}
        >
          {cancelLabel}
        </Button>
      )}
      <a
        className={buttonClassName({ variant: reopenVariant, size: 'md' })}
        href={authorizationUrl}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={`${dataTestId}-reopen`}
      >
        {MCP_SIGN_IN_REOPEN_LABEL}
      </a>
    </>
  );
}
