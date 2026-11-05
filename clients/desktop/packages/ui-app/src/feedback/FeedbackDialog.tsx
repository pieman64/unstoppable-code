'use client';

import { type JSX, type ReactNode, useState } from 'react';
import {
  Button,
  DialogFormField,
  DialogModal,
  LoadingSpinner,
  SegmentedControl,
  TextArea,
  TextInput,
  Notice,
} from '@canopy/ui-shared/components';

/**
 * The feedback form the desktop app's Feedback modal renders, extracted so the
 * web portal opens the same dialog from its account row. The form owns type,
 * description, optional title, submitting/error/success state and the footer;
 * hosts own submission (desktop: IPC plus diagnostics, web: the feedback
 * reports API) and may add an attachments block and error-time actions.
 */
export type FeedbackDialogReportType = 'bug' | 'idea';

export interface FeedbackDialogSubmission {
  readonly type: FeedbackDialogReportType;
  readonly description: string;
  readonly title?: string;
}

export interface FeedbackDialogProps {
  readonly appName: string;
  readonly onSubmit: (submission: FeedbackDialogSubmission) => Promise<void>;
  readonly onClose: () => void;
  /** Host block explaining what else is sent (desktop: context + diagnostics). */
  readonly attachments?: ReactNode;
  /** Host actions rendered inside the error notice (desktop: save diagnostics). */
  readonly errorActions?: ReactNode;
  /** A host note under the form body (desktop: "Saved … to Downloads"). */
  readonly note?: ReactNode;
  /** Lets a host learn what the user typed (desktop's diagnostics fallback). */
  readonly onDescriptionChange?: (description: string) => void;
  /**
   * Seeds the report type. Defaults to `idea` (CAN-2682: a suggestion should
   * not have to correct a bug-first form). Hosts opening this FROM a failure
   * the user just hit pass `bug`, because there the assumption is correct.
   */
  readonly initialReportType?: FeedbackDialogReportType;
}

const SUBMIT_ERROR_FALLBACK =
  'Could not submit your feedback. Please try again.';

const REPORT_TYPE_OPTIONS: ReadonlyArray<{
  value: FeedbackDialogReportType;
  label: string;
}> = [
  { value: 'idea', label: 'Idea' },
  { value: 'bug', label: 'Bug' },
];

const FIELD_LABEL_CLASSNAME = 'block text-xs font-medium fg-secondary';

function descriptionPlaceholder(type: FeedbackDialogReportType): string {
  return type === 'bug'
    ? 'What happened, what you expected, and how to reproduce it'
    : 'What you would like to see, and what it would help you do';
}

export function FeedbackDialog({
  appName,
  onSubmit,
  onClose,
  attachments,
  errorActions,
  note,
  onDescriptionChange,
  initialReportType,
}: FeedbackDialogProps): JSX.Element {
  const [type, setType] = useState<FeedbackDialogReportType>(
    initialReportType ?? 'idea',
  );
  const [description, setDescription] = useState('');
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = description.trim().length > 0 && !submitting;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    const trimmedTitle = title.trim();
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        type,
        description: description.trim(),
        ...(trimmedTitle.length > 0 ? { title: trimmedTitle } : {}),
      });
      setSubmitted(true);
    } catch (err: unknown) {
      setError(
        err instanceof Error && err.message.length > 0
          ? err.message
          : SUBMIT_ERROR_FALLBACK,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title="Feedback"
      subtitle={`Ideas, bugs, anything that felt off — they all go to the ${appName} team.`}
      maxWidth="lg"
      scrollableBody={false}
      dataTestId="feedback-modal"
    >
      {submitted ? (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <p
              className="text-s fg-primary"
              data-testid="feedback-modal-success"
            >
              Thanks — your feedback is with the {appName} team.
            </p>
          </div>
          <div
            className="flex items-center justify-end border-t px-6 py-3"
            data-testid="feedback-modal-success-footer"
          >
            <Button
              type="button"
              variant="primary"
              size="compact"
              onClick={onClose}
              data-testid="feedback-modal-done"
            >
              Done
            </Button>
          </div>
        </>
      ) : (
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event): void => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4"
            data-testid="feedback-modal-body"
          >
            <div className="space-y-1.5">
              <span className={FIELD_LABEL_CLASSNAME}>Type</span>
              <SegmentedControl
                label="Feedback type"
                shape="capsule"
                width="content"
                value={type}
                options={REPORT_TYPE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                  dataTestId: `feedback-modal-type-${option.value}`,
                }))}
                onChange={setType}
              />
            </div>

            <DialogFormField
              label="Description"
              htmlFor="feedback-modal-description"
            >
              <TextArea
                id="feedback-modal-description"
                data-testid="feedback-modal-description"
                value={description}
                onChange={(event): void => {
                  setDescription(event.target.value);
                  onDescriptionChange?.(event.target.value);
                  setError(null);
                }}
                placeholder={descriptionPlaceholder(type)}
                rows={5}
              />
            </DialogFormField>

            <DialogFormField
              label="Title (optional)"
              htmlFor="feedback-modal-title"
            >
              <TextInput
                id="feedback-modal-title"
                type="text"
                data-testid="feedback-modal-title"
                value={title}
                onChange={(event): void => setTitle(event.target.value)}
                placeholder="Summarized from your description if left blank"
              />
            </DialogFormField>

            {attachments}

            {error !== null && (
              <Notice
                intent="destructive"
                data-testid="feedback-modal-error"
                actions={errorActions}
              >
                {error}
              </Notice>
            )}

            {note}
          </div>

          <div
            className="flex items-center justify-end gap-3 border-t px-6 py-3"
            data-testid="feedback-modal-footer"
          >
            <Button
              type="button"
              size="compact"
              onClick={onClose}
              data-testid="feedback-modal-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="compact"
              disabled={!canSubmit}
              data-testid="feedback-modal-submit"
            >
              {submitting ? (
                <>
                  <LoadingSpinner tone="emphasis" />
                  <span>Submitting…</span>
                </>
              ) : (
                <span>Submit</span>
              )}
            </Button>
          </div>
        </form>
      )}
    </DialogModal>
  );
}
