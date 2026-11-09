import { useId, type JSX } from 'react';
import {
  Notice,
  NoticeButton,
  SegmentedControl,
  Select,
  type SelectOption,
  FieldError,
} from '@canopy/ui-shared/components';
import { NO_PROJECT_LABEL } from './workflow-run-model';

/**
 * Where a pipeline run goes and who owns it (CAN-4542). Hosts load owners and
 * pipeline metadata; this renders the choice once for every host that can
 * start a run with no project.
 */
export type PipelineRunLocation = 'global' | 'current-task';

export const PIPELINE_RUN_CONTEXT_COPY = {
  runIn: 'Run in',
  noProject: NO_PROJECT_LABEL,
  currentTask: 'Current task',
  currentTaskUnavailable: 'Open a compatible task to run this pipeline there.',
  owner: 'Owner',
  ownerHelper: "This run appears in the owner's Runs list.",
  ownersLoading: 'Loading owners…',
  ownersFailed: "Couldn't load owners.",
  retry: 'Try again',
  ownerStale: 'Choose an available owner.',
  ownerPlaceholder: 'Choose an owner',
} as const;

/** The owner field's state, as the host resolved it. */
export type PipelineRunOwnerField =
  /** The pipeline has a saved owner; it is shown and cannot change. */
  | { readonly kind: 'fixed'; readonly label: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly onRetry: () => void }
  | {
      readonly kind: 'choose';
      readonly options: readonly SelectOption[];
      readonly value: string | null;
      readonly onChange: (value: string) => void;
      /** The earlier choice is no longer available and was cleared. */
      readonly stale: boolean;
    };

export interface PipelineRunLocationField {
  readonly value: PipelineRunLocation;
  readonly onChange: (value: PipelineRunLocation) => void;
  /** No selected task can run this pipeline. */
  readonly currentTaskUnavailable: boolean;
}

export interface PipelineRunContextFieldsProps {
  /** Shown only for a pipeline that can run with or without a project. */
  readonly location?: PipelineRunLocationField;
  /** Shown only for a run with no project. */
  readonly owner?: PipelineRunOwnerField;
  readonly disabled?: boolean;
}

export function PipelineRunContextFields({
  location,
  owner,
  disabled = false,
}: PipelineRunContextFieldsProps): JSX.Element | null {
  const ownerLabelId = useId();
  const ownerHelperId = useId();
  if (!location && !owner) return null;
  return (
    <div
      className="flex flex-col gap-4"
      data-testid="pipeline-run-context-fields"
    >
      {location ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-s font-medium fg-primary">
            {PIPELINE_RUN_CONTEXT_COPY.runIn}
          </span>
          <SegmentedControl<PipelineRunLocation>
            label={PIPELINE_RUN_CONTEXT_COPY.runIn}
            value={location.value}
            onChange={location.onChange}
            disabled={disabled}
            width="fill"
            dataTestId="pipeline-run-location"
            options={[
              {
                value: 'global',
                label: PIPELINE_RUN_CONTEXT_COPY.noProject,
                dataTestId: 'pipeline-run-location-global',
              },
              {
                value: 'current-task',
                label: PIPELINE_RUN_CONTEXT_COPY.currentTask,
                dataTestId: 'pipeline-run-location-current-task',
                unavailable: location.currentTaskUnavailable,
                ...(location.currentTaskUnavailable
                  ? {
                      tooltip: PIPELINE_RUN_CONTEXT_COPY.currentTaskUnavailable,
                    }
                  : {}),
              },
            ]}
          />
          {location.currentTaskUnavailable ? (
            <p className="text-xs fg-tertiary">
              {PIPELINE_RUN_CONTEXT_COPY.currentTaskUnavailable}
            </p>
          ) : null}
        </div>
      ) : null}
      {owner ? (
        <div className="flex flex-col gap-1.5">
          <span id={ownerLabelId} className="text-s font-medium fg-primary">
            {PIPELINE_RUN_CONTEXT_COPY.owner}
          </span>
          <OwnerControl
            owner={owner}
            disabled={disabled}
            labelId={ownerLabelId}
            helperId={ownerHelperId}
          />
          <p id={ownerHelperId} className="text-xs fg-tertiary">
            {PIPELINE_RUN_CONTEXT_COPY.ownerHelper}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function OwnerControl({
  owner,
  disabled,
  labelId,
  helperId,
}: {
  owner: PipelineRunOwnerField;
  disabled: boolean;
  labelId: string;
  helperId: string;
}): JSX.Element {
  switch (owner.kind) {
    case 'fixed':
      return (
        <p
          // A generic paragraph can't take a name; a group announces Owner.
          role="group"
          aria-labelledby={labelId}
          aria-describedby={helperId}
          className="truncate text-s fg-secondary"
          data-testid="pipeline-run-owner-fixed"
        >
          {owner.label}
        </p>
      );
    case 'loading':
      return (
        <p
          role="status"
          className="text-s fg-tertiary"
          data-testid="pipeline-run-owner-loading"
        >
          {PIPELINE_RUN_CONTEXT_COPY.ownersLoading}
        </p>
      );
    case 'error':
      return (
        <Notice
          intent="destructive"
          data-testid="pipeline-run-owner-error"
          actions={
            <NoticeButton type="button" onClick={owner.onRetry}>
              {PIPELINE_RUN_CONTEXT_COPY.retry}
            </NoticeButton>
          }
        >
          {PIPELINE_RUN_CONTEXT_COPY.ownersFailed}
        </Notice>
      );
    case 'choose':
      return (
        <>
          <Select
            options={owner.options}
            value={owner.value}
            onValueChange={owner.onChange}
            placeholder={PIPELINE_RUN_CONTEXT_COPY.ownerPlaceholder}
            disabled={disabled}
            required
            aria-labelledby={labelId}
            data-testid="pipeline-run-owner-select"
          />
          {owner.stale ? (
            <FieldError
              id="pipeline-run-owner-stale"
              announce
              data-testid="pipeline-run-owner-stale"
            >
              {PIPELINE_RUN_CONTEXT_COPY.ownerStale}
            </FieldError>
          ) : null}
        </>
      );
  }
}
