'use client';

import { Component, useMemo, useState, type JSX, type ReactNode } from 'react';
import type { AppError } from '@canopy/protocol/app-errors';
import {
  toFeedbackReportError,
  type FeedbackReportTelemetry,
} from '@canopy/protocol/feedback-report';
import { useOptionalCanopyClient } from '@canopy/app-state';
import { Button, type ButtonSize } from '@canopy/ui-shared/components';
import { FeedbackReportDialog } from './FeedbackReportDialogEntry';

/**
 * Keeps a failure in the reporting UI from reaching the recovery UI it sits
 * beside: it renders nothing rather than rethrowing into the parent boundary.
 */
export class ReportActionBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface ReportThisActionProps {
  readonly error: AppError;
  readonly appName: string;
  /** Session links read when the error happened. */
  readonly telemetry?: FeedbackReportTelemetry;
  readonly size?: ButtonSize;
}

/**
 * The secondary `Report this` action beside a defect's recovery. Only defects
 * offer it, and only where the client can deliver the report. The shared
 * dialog entry loads its form on opening and keeps load failures recoverable.
 */
export function ReportThisAction(props: ReportThisActionProps): JSX.Element {
  return (
    <ReportActionBoundary key={props.error.referenceId}>
      <ReportThisButton {...props} />
    </ReportActionBoundary>
  );
}

function ReportThisButton({
  error,
  appName,
  telemetry,
  size = 'sm',
}: ReportThisActionProps): JSX.Element | null {
  const client = useOptionalCanopyClient();
  const [open, setOpen] = useState(false);
  const reportError = useMemo(() => {
    try {
      return toFeedbackReportError(error);
    } catch {
      return null;
    }
  }, [error]);
  const feedback =
    client?.capabilities.feedbackReports === true ? client.feedback : undefined;
  if (error.kind !== 'defect' || !feedback || !reportError) return null;
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size={size}
        aria-haspopup="dialog"
        onClick={(): void => setOpen(true)}
        data-testid="report-this-action"
      >
        Report this
      </Button>
      {open ? (
        <FeedbackReportDialog
          appName={appName}
          client={feedback}
          diagnosticsSupported={
            client?.capabilities.feedbackDiagnostics === true
          }
          error={reportError}
          {...(telemetry ? { telemetry } : {})}
          onClose={(): void => setOpen(false)}
        />
      ) : null}
    </>
  );
}
