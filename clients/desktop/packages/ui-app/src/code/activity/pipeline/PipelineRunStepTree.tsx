'use client';

import { type JSX } from 'react';
import { ListRow } from '@canopy/ui-shared/components';
import {
  pipelineRunDetailStatusClassName,
  pipelineRunStepKey,
  type PipelineRunDetailJobGroup,
  type PipelineRunDetailStepEntry,
} from './PipelineRunDetailModel';

export interface PipelineRunStepTreeSelection {
  readonly job_id: string;
  readonly step_id: string;
}

export interface PipelineRunStepTreeProps {
  readonly groups: readonly PipelineRunDetailJobGroup[];
  readonly selected: PipelineRunStepTreeSelection | null;
  readonly onSelect: (selection: PipelineRunStepTreeSelection) => void;
}

function isSelected(
  entry: PipelineRunDetailStepEntry,
  selected: PipelineRunStepTreeSelection | null,
): boolean {
  return (
    selected !== null &&
    selected.job_id === entry.job_id &&
    selected.step_id === entry.step.step_id
  );
}

function StepButton({
  entry,
  selected,
  onSelect,
  indented,
}: {
  entry: PipelineRunDetailStepEntry;
  selected: PipelineRunStepTreeSelection | null;
  onSelect: (selection: PipelineRunStepTreeSelection) => void;
  indented: boolean;
}): JSX.Element {
  const active = isSelected(entry, selected);
  const row = (
    <ListRow
      selected={active}
      aria-pressed={active}
      data-testid={`portal-pipeline-step-${entry.job_id}-${entry.step.step_id}`}
      onClick={(): void =>
        onSelect({ job_id: entry.job_id, step_id: entry.step.step_id })
      }
      trailing={
        <span className={pipelineRunDetailStatusClassName(entry.step.status)}>
          {entry.step.status}
        </span>
      }
    >
      {entry.step.name}
    </ListRow>
  );
  // A matrix variant's steps sit one level in, under the variant's heading.
  return indented ? <div className="pl-3">{row}</div> : row;
}

/**
 * Job-grouped step tree. Jobs head their own steps; matrix variants nest one
 * level below their logical job. See `buildPipelineRunDetailJobs` for why one
 * level is the ceiling.
 */
export function PipelineRunStepTree({
  groups,
  selected,
  onSelect,
}: PipelineRunStepTreeProps): JSX.Element {
  return (
    <div
      className="flex flex-col gap-2 p-2"
      data-testid="pipeline-run-step-tree"
    >
      {groups.map((group) => (
        <div
          key={group.job_id}
          className="flex flex-col gap-0.5"
          data-testid={`pipeline-run-job-${group.job_id}`}
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <span className="truncate text-2xs font-semibold fg-secondary">
              {group.name}
            </span>
            <span className={pipelineRunDetailStatusClassName(group.status)}>
              {group.status}
            </span>
          </div>
          {group.steps.map((entry) => (
            <StepButton
              key={pipelineRunStepKey(entry.job_id, entry.step.step_id)}
              entry={entry}
              selected={selected}
              onSelect={onSelect}
              indented={false}
            />
          ))}
          {group.variants.map((variant) => (
            <div
              key={variant.job_id}
              className="flex flex-col gap-0.5"
              data-testid={`pipeline-run-variant-${variant.job_id}`}
            >
              <div className="flex items-center justify-between gap-2 pl-4 pr-2 py-1">
                <span className="truncate text-3xs fg-secondary">
                  {variant.name}
                </span>
                <span
                  className={pipelineRunDetailStatusClassName(variant.status)}
                >
                  {variant.status}
                </span>
              </div>
              {variant.steps.map((entry) => (
                <StepButton
                  key={pipelineRunStepKey(entry.job_id, entry.step.step_id)}
                  entry={entry}
                  selected={selected}
                  onSelect={onSelect}
                  indented
                />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
