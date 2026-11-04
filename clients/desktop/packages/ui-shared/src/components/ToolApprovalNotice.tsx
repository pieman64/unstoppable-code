'use client';

import { useId, useState, type JSX, type ReactNode } from 'react';
import { Button } from './Button';
import { Notice, NoticeButton } from './Notice';
import { Stack } from './Stack';

/** Inputs longer than this show truncated until the person expands them. */
export const TOOL_APPROVAL_PREVIEW_CHARS = 600;

export interface ToolApprovalNoticeProps {
  /** The tool the agent wants to run. */
  toolName: string;
  /** The tool call's input as text. Rendered as plain text only. */
  input: string;
  /**
   * Records the decision. Absent for a viewer who may not decide: the notice
   * then shows `readOnlyHint` instead of buttons.
   */
  onDecide?: (approved: boolean) => void;
  /** Shown instead of the buttons when `onDecide` is absent. */
  readOnlyHint?: ReactNode;
  /** The decision being sent, or the one that failed to send. */
  sending?: 'allow' | 'deny' | null;
  /** The last send failed; only the same decision may be retried. */
  failed?: boolean;
  /** The server refused the last decision; the person may decide again. */
  rejected?: boolean;
  /** Resends the decision that failed. */
  onRetry?: () => void;
}

/**
 * Composer notice for a tool call the agent waits on approval for. Pure
 * display: the host owns the request and what a decision does. Deny sits
 * beside Allow at the same size, and nothing is decided by waiting.
 */
export function ToolApprovalNotice({
  toolName,
  input,
  onDecide,
  readOnlyHint,
  sending = null,
  failed = false,
  rejected = false,
  onRetry,
}: ToolApprovalNoticeProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const inputId = useId();
  const long = input.length > TOOL_APPROVAL_PREVIEW_CHARS;
  const shown =
    long && !expanded
      ? `${input.slice(0, TOOL_APPROVAL_PREVIEW_CHARS)}…`
      : input;

  let actions: ReactNode = null;
  if (onDecide !== undefined && failed && onRetry !== undefined) {
    actions = (
      <NoticeButton
        variant="primary"
        onClick={onRetry}
        data-testid="tool-approval-retry"
      >
        Try again
      </NoticeButton>
    );
  } else if (onDecide !== undefined) {
    actions = (
      <>
        <NoticeButton
          busy={sending === 'deny'}
          busyLabel="Denying…"
          disabled={sending !== null}
          onClick={(): void => onDecide(false)}
          data-testid="tool-approval-deny"
        >
          Deny
        </NoticeButton>
        <NoticeButton
          variant="primary"
          busy={sending === 'allow'}
          busyLabel="Allowing…"
          disabled={sending !== null}
          onClick={(): void => onDecide(true)}
          data-testid="tool-approval-allow"
        >
          Allow
        </NoticeButton>
      </>
    );
  }

  let detail: ReactNode = undefined;
  if (onDecide === undefined) detail = readOnlyHint;
  else if (failed)
    detail = `Couldn't send your ${sending === 'allow' ? 'approval' : 'denial'}.`;
  else if (rejected)
    detail =
      "Your decision wasn't accepted. Reload the page or sign in again, then decide again.";

  return (
    <Notice
      intent="attention"
      title={`Allow ${toolName}?`}
      data-testid="tool-approval-notice"
      {...(detail === undefined ? {} : { detail })}
      {...(actions === null ? {} : { actions })}
    >
      <Stack gap="tight" align="start">
        <span>The agent is waiting for your approval to run this tool.</span>
        <pre
          id={inputId}
          className="max-h-60 w-full overflow-auto whitespace-pre-wrap break-words font-mono text-xs"
          data-testid="tool-approval-input"
        >
          {shown}
        </pre>
        {long ? (
          <Button
            variant="link"
            aria-expanded={expanded}
            aria-controls={inputId}
            onClick={(): void => setExpanded((value) => !value)}
            data-testid="tool-approval-expand"
          >
            {expanded ? 'Show less' : 'Show all'}
          </Button>
        ) : null}
      </Stack>
    </Notice>
  );
}
