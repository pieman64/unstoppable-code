import type { JSX } from 'react';
import { useCanopyClient } from '@canopy/app-state';
import {
  FeedbackReportDialog,
  type FeedbackDialogReportType,
} from '@canopy/ui-app';
import { brandText } from '@/lib/brand';

interface FeedbackModalProps {
  onClose: () => void;
  /**
   * Seeds the form's report type. Omitted opens on `Idea`, the default for the
   * account-menu entry point; a host opening this straight off a failure the
   * user just hit passes `bug`.
   */
  initialReportType?: FeedbackDialogReportType;
}

/**
 * First-class feedback entry point launched from the sidebar account rail. The
 * form is the shared dialog the web renders too; on submit the report becomes a
 * Linear issue with diagnostics attached.
 */
export function FeedbackModal({
  onClose,
  initialReportType,
}: FeedbackModalProps): JSX.Element | null {
  const client = useCanopyClient();
  if (!client.feedback) return null;
  return (
    <FeedbackReportDialog
      appName={brandText.appName}
      client={client.feedback}
      diagnosticsSupported={client.capabilities.feedbackDiagnostics === true}
      onClose={onClose}
      {...(initialReportType ? { initialReportType } : {})}
    />
  );
}
