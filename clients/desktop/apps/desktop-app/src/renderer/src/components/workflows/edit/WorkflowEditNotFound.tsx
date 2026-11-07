import type { JSX } from 'react';
import {
  Button,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';
import { BackIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useNavigationStore } from '@/stores/navigationStore';

const NOT_FOUND_COPY: Readonly<Record<'automation' | 'pipeline', string>> = {
  automation: 'This automation no longer exists.',
  pipeline: 'This workflow no longer exists.',
};

export interface WorkflowEditNotFoundProps {
  readonly kind: 'automation' | 'pipeline';
  /** The item may still arrive: its list has not loaded yet. */
  readonly loading?: boolean;
  readonly backLabel?: string;
}

/**
 * The edit shell's target is gone: deleted from another surface, or a stale
 * history entry. Back is the only way on, and there is nothing to save.
 */
export function WorkflowEditNotFound({
  kind,
  loading = false,
  backLabel = 'Library',
}: WorkflowEditNotFoundProps): JSX.Element {
  return (
    <section
      className="flex min-h-0 w-full flex-col gap-6"
      data-testid="workflow-edit-not-found"
      data-loading={loading ? 'true' : 'false'}
    >
      <Button
        variant="ghost"
        size="compact"
        onClick={(): void => useNavigationStore.getState().closeWorkflowEdit()}
        data-testid="workflow-edit-back"
        className="-ml-3 self-start"
      >
        <BackIcon size="sm" aria-hidden="true" />
        {backLabel}
      </Button>
      {loading ? (
        <DelayedLoadingPlaceholder>
          <CenteredLoadingSpinner className="my-8" />
        </DelayedLoadingPlaceholder>
      ) : (
        <p className="text-s fg-secondary">{NOT_FOUND_COPY[kind]}</p>
      )}
    </section>
  );
}
