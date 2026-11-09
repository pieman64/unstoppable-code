import type { JSX } from 'react';
import { Surface, ListRow, Skeleton } from '@canopy/ui-shared/components';
import type { ExecutionSummary } from '@canopy/execution-engine/types/pipeline';
import { ArchivedAttachmentRow } from './ArchivedAttachmentRow';
import { ArchivedExecutionRow } from './ArchivedExecutionRow';

/**
 * Loading states for the archive's row lists. Each renders the loaded rows
 * from plain samples inside `Skeleton`, so skullet measures them into bars
 * and the loaded list replaces the skeleton in place. Wrap each in
 * `DelayedLoadingPlaceholder` so a fast read never flashes it.
 */

const noop = (): void => undefined;

const SAMPLE_TIME = '2026-01-01T12:00:00.000Z';

const SAMPLE_NAV_ROWS = [
  'Fix the checkout retry',
  'Update the docs sidebar',
  'Add release notes',
] as const;

/**
 * A left nav of chats or plans; the selected item's pane stays empty until
 * the list arrives.
 */
export function ArchivedNavListSkeleton({
  label,
  testId,
}: {
  readonly label: string;
  readonly testId: string;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1">
      <Surface variant="section" boundary="right" className="w-64 shrink-0">
        <div className="shrink-0 p-2">
          <Skeleton loading label={label} testId={testId}>
            <div className="flex flex-col">
              {SAMPLE_NAV_ROWS.map((title) => (
                <ListRow key={title} onClick={noop}>
                  {title}
                </ListRow>
              ))}
            </div>
          </Skeleton>
        </div>
      </Surface>
    </div>
  );
}

function sampleExecution(id: string, name: string): ExecutionSummary {
  return {
    id,
    pipeline_id: id,
    pipeline_name: name,
    status: 'success',
    status_reasons: [],
    started_at: SAMPLE_TIME,
    cwd: '',
  };
}

const SAMPLE_EXECUTIONS: readonly ExecutionSummary[] = [
  sampleExecution('sample-1', 'Code review'),
  sampleExecution('sample-2', 'Release checks'),
  sampleExecution('sample-3', 'Nightly tests'),
];

/** The retained workflow runs. */
export function ArchivedExecutionListSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading workflow runs"
      testId="archived-executions-loading"
      className="mx-auto w-full max-w-3xl"
    >
      <div className="flex flex-col gap-1.5">
        {SAMPLE_EXECUTIONS.map((execution) => (
          <ArchivedExecutionRow
            key={execution.id}
            summary={execution}
            executionState={undefined}
            onOpen={noop}
          />
        ))}
      </div>
    </Skeleton>
  );
}

const SAMPLE_ATTACHMENTS = [
  'checkout-flow.png',
  'release-notes.md',
  'error-log.txt',
] as const;

/** The retained attachments. */
export function ArchivedAttachmentListSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading attachments"
      testId="archived-attachments-loading"
      className="mx-auto w-full max-w-3xl"
    >
      <div className="flex flex-col gap-1.5">
        {SAMPLE_ATTACHMENTS.map((filename) => (
          <ArchivedAttachmentRow
            key={filename}
            filename={filename}
            createdAt={SAMPLE_TIME}
            onReveal={noop}
          />
        ))}
      </div>
    </Skeleton>
  );
}
