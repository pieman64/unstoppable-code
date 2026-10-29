import { type JSX, useEffect, useState } from 'react';
import { Button, LoadingPlaceholder } from '@canopy/ui-shared/components';
import { DialogModal } from '@/components/shared/DialogModal';
import type {
  ResolvedAutomationSharedPipelinePin,
  ScheduledActivity,
} from '@canopy/desktop-shared/types';
import { useAutomationsStore } from '@/stores/automationsStore';
import { InlinePipelineYamlPreview } from './InlinePipelineYamlPreview';

export const SHARED_PIPELINE_REVIEW_TITLE = 'Review pipeline update';
export const SHARED_PIPELINE_REVIEW_EXPLANATION =
  'This pipeline was updated. Take a look and approve it to keep your automation running.';
export const SHARED_PIPELINE_REVIEW_NEEDED_MESSAGE =
  'This pipeline was updated, so take a look before it runs again.';

type ResolveState =
  | { status: 'loading' }
  | { status: 'ready'; resolved: ResolvedAutomationSharedPipelinePin }
  | { status: 'error'; message: string };

export interface ReviewSharedPipelineChangeModalProps {
  activity: ScheduledActivity;
  onClose: () => void;
  /** Document hosting the overlay (panel pull-out windows pass their own). */
  ownerDocument?: Document;
  /** Called after a successful approval, before the modal closes. */
  onApproved?: (activity: ScheduledActivity | undefined) => void;
}

function sharedRemoteId(activity: ScheduledActivity): string | null {
  const action = activity.action;
  if (action.type !== 'worktree_pipeline') return null;
  if (action.pipelineSource !== 'shared') return null;
  return (
    action.sharedPipeline?.remoteId ??
    activity.sharedPipelineReview?.remoteId ??
    null
  );
}

function pipelineDisplayName(activity: ScheduledActivity): string {
  const action = activity.action;
  const fromAction =
    action.type === 'worktree_pipeline' ? action.pipelineName : undefined;
  return (
    activity.sharedPipelineReview?.pipelineName ??
    fromAction ??
    'Shared pipeline'
  );
}

/**
 * Recipient review for a shared pipeline whose publisher saved a new version
 * (CAN-3354). Shows the full current version and only re-pins on an explicit
 * click, sending the exact install pin that was previewed so a second edit
 * in the meantime fails closed in main.
 */
export function ReviewSharedPipelineChangeModal({
  activity,
  onClose,
  ownerDocument,
  onApproved,
}: ReviewSharedPipelineChangeModalProps): JSX.Element {
  const approve = useAutomationsStore((s) => s.approveSharedPipelineReview);
  const remoteId = sharedRemoteId(activity);
  const [resolveState, setResolveState] = useState<ResolveState>({
    status: 'loading',
  });
  const [submitting, setSubmitting] = useState<'approve' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approvedRunError, setApprovedRunError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!remoteId) {
      setResolveState({
        status: 'error',
        message: 'This automation does not use a shared pipeline.',
      });
      return (): void => {
        cancelled = true;
      };
    }
    setResolveState({ status: 'loading' });
    window.api.automations
      .resolveSharedPipelineInstallPin({ remoteId })
      .then((resolved) => {
        if (!cancelled) setResolveState({ status: 'ready', resolved });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setResolveState({
          status: 'error',
          message:
            cause instanceof Error && cause.message
              ? cause.message
              : 'Could not load this pipeline. Try again.',
        });
      });
    return (): void => {
      cancelled = true;
    };
  }, [remoteId, reloadToken]);

  const handleApprove = async (runNow: boolean): Promise<void> => {
    if (resolveState.status !== 'ready' || submitting) return;
    setSubmitting(runNow ? 'run' : 'approve');
    setError(null);
    const result = await approve({
      id: activity.id,
      installPin: resolveState.resolved.installPin,
      ...(runNow ? { runNow: true } : {}),
    });
    setSubmitting(null);
    if (!result.ok) {
      setError(result.error);
      // The pipeline may have changed again; reload what the user reviews.
      setReloadToken((token) => token + 1);
      return;
    }
    onApproved?.(result.activity);
    if (result.runError) {
      setApprovedRunError(
        `Pipeline approved, but the automation could not run: ${result.runError}`,
      );
      return;
    }
    onClose();
  };

  const busy = submitting !== null;
  const ready = resolveState.status === 'ready';

  return (
    <DialogModal
      onClose={busy ? (): void => undefined : onClose}
      closeOnBackdrop={!busy}
      title={SHARED_PIPELINE_REVIEW_TITLE}
      maxWidth="2xl"
      dataTestId="shared-pipeline-review-modal"
      ownerDocument={ownerDocument}
    >
      <div className="space-y-4 px-5 py-4">
        <div>
          <h3
            className="text-base font-semibold fg-primary"
            data-testid="shared-pipeline-review-name"
          >
            {pipelineDisplayName(activity)}
          </h3>
          <p className="mt-1 text-s fg-secondary">
            {SHARED_PIPELINE_REVIEW_EXPLANATION}
          </p>
        </div>

        {resolveState.status === 'loading' && (
          <LoadingPlaceholder label="Loading pipeline…" showSpinner />
        )}

        {resolveState.status === 'error' && (
          <p
            className="text-s fg-destructive"
            role="alert"
            data-testid="shared-pipeline-review-load-error"
          >
            {resolveState.message}
          </p>
        )}

        {resolveState.status === 'ready' && (
          <InlinePipelineYamlPreview
            rawPipeline={resolveState.resolved.rawPipeline}
            testId="shared-pipeline-review-yaml"
            maxHeightClassName="max-h-80"
          />
        )}

        {error && (
          <p
            className="text-s fg-destructive"
            role="alert"
            data-testid="shared-pipeline-review-error"
          >
            {error}
          </p>
        )}

        {approvedRunError && (
          <p
            className="text-s fg-destructive"
            role="alert"
            data-testid="shared-pipeline-review-approved-run-error"
          >
            {approvedRunError}
          </p>
        )}
      </div>

      <div className="relative flex justify-end gap-2 px-5 py-3">
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-[var(--border-hairline)] bg-line-base"
          data-testid="shared-pipeline-review-footer-separator"
        />
        {approvedRunError ? (
          <Button
            type="button"
            variant="primary"
            onClick={onClose}
            data-testid="shared-pipeline-review-close"
          >
            Close
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleApprove(false)}
              disabled={!ready || busy}
              data-testid="shared-pipeline-review-approve"
            >
              {submitting === 'approve' ? 'Approving…' : 'Approve'}
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void handleApprove(true)}
              disabled={!ready || busy}
              data-testid="shared-pipeline-review-approve-run"
            >
              {submitting === 'run' ? 'Approving…' : 'Approve and run'}
            </Button>
          </>
        )}
      </div>
    </DialogModal>
  );
}
