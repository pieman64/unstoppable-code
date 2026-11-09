import { type JSX, type KeyboardEvent, useState, useRef } from 'react';
import type { Job } from '@canopy/execution-engine/types/pipeline';
import { normalizeNeeds } from '@canopy/execution-engine/types/pipeline';
import { isValidPipelineIdentifier } from '../../../lib/pipelineEditor';
import { parseMaxIterationsInput } from '../../../lib/jobDetailPanel';
import { MAX_RETRIES_LIMIT } from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  Surface,
  Button,
  ChoiceList,
  ChoiceListRow,
} from '@canopy/ui-shared/components';
import { FormField } from '../shared/FormField';
import { TextField } from '../shared/TextField';
import { ToggleField } from '../shared/ToggleField';
import { KeyValueEditor } from '../shared/KeyValueEditor';
import { PipelineDetailPanelShell } from './PipelinePanelPrimitives';

interface JobDetailPanelProps {
  jobId: string;
  job: Job;
  allJobIds: string[];
  onChange: (jobId: string, patch: Partial<Job>) => void;
  onRenameJob: (oldId: string, newId: string) => void;
  /**
   * Removes the job and the dependencies on it. An unsaved edit like any
   * other, so Undo brings it back.
   */
  onRemove?: (jobId: string) => void;
  onClose: () => void;
  readonly?: boolean;
}

function blurInputOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') {
    event.currentTarget.blur();
  }
}

export function JobDetailPanel({
  jobId,
  job,
  allJobIds,
  onChange,
  onRenameJob,
  onRemove,
  onClose,
  readonly = false,
}: JobDetailPanelProps): JSX.Element {
  const [localJobId, setLocalJobId] = useState(jobId);
  const [localName, setLocalName] = useState(job.name ?? '');
  const [localCondition, setLocalCondition] = useState(job.if ?? '');
  const [localTimeout, setLocalTimeout] = useState(
    job.timeout_minutes !== undefined ? String(job.timeout_minutes) : '',
  );
  const [localMaxRetries, setLocalMaxRetries] = useState(
    job.max_retries !== undefined ? String(job.max_retries) : '',
  );
  const [localMaxIterations, setLocalMaxIterations] = useState(
    job.max_iterations !== undefined ? String(job.max_iterations) : '',
  );
  const [jobIdError, setJobIdError] = useState<string | null>(null);

  // Sync local state when the selected job changes externally
  const prevJobIdRef = useRef(jobId);
  if (prevJobIdRef.current !== jobId) {
    prevJobIdRef.current = jobId;
    setLocalJobId(jobId);
    setLocalName(job.name ?? '');
    setLocalCondition(job.if ?? '');
    setLocalTimeout(
      job.timeout_minutes !== undefined ? String(job.timeout_minutes) : '',
    );
    setLocalMaxRetries(
      job.max_retries !== undefined ? String(job.max_retries) : '',
    );
    setLocalMaxIterations(
      job.max_iterations !== undefined ? String(job.max_iterations) : '',
    );
    setJobIdError(null);
  }

  const currentNeeds: string[] = normalizeNeeds(job.needs);
  const otherJobIds: string[] = allJobIds.filter(
    (id: string): boolean => id !== jobId,
  );

  function handleJobIdBlur(): void {
    const trimmed: string = localJobId.trim();
    if (!trimmed || trimmed === jobId) {
      setLocalJobId(jobId);
      setJobIdError(null);
      return;
    }
    if (!isValidPipelineIdentifier(trimmed)) {
      setJobIdError(
        'Must start with a letter or underscore, then letters/digits/underscores',
      );
      return;
    }
    if (allJobIds.includes(trimmed) && trimmed !== jobId) {
      setJobIdError('Job ID already in use');
      return;
    }
    setJobIdError(null);
    onRenameJob(jobId, trimmed);
  }

  function handleNameBlur(): void {
    const trimmed: string = localName.trim();
    if (trimmed !== (job.name ?? '')) {
      onChange(jobId, { name: trimmed || undefined });
    }
  }

  function handleConditionBlur(): void {
    const trimmed: string = localCondition.trim();
    if (trimmed !== (job.if ?? '')) {
      onChange(jobId, { if: trimmed || undefined });
    }
  }

  function handleTimeoutBlur(): void {
    const trimmed: string = localTimeout.trim();
    if (!trimmed) {
      if (job.timeout_minutes !== undefined) {
        onChange(jobId, { timeout_minutes: undefined });
      }
      return;
    }
    const num: number = parseInt(trimmed, 10);
    if (!Number.isNaN(num) && num > 0 && num !== job.timeout_minutes) {
      onChange(jobId, { timeout_minutes: num });
    }
  }

  function handleMaxRetriesBlur(): void {
    const trimmed: string = localMaxRetries.trim();
    if (!trimmed) {
      if (job.max_retries !== undefined) {
        onChange(jobId, { max_retries: undefined });
      }
      return;
    }

    const num: number = Number(trimmed);
    if (!Number.isSafeInteger(num) || num < 0 || num > MAX_RETRIES_LIMIT) {
      return;
    }

    if (num === 0) {
      if (job.max_retries !== undefined) {
        onChange(jobId, { max_retries: undefined });
      }
      return;
    }

    if (num !== job.max_retries) {
      onChange(jobId, { max_retries: num });
    }
  }

  function handleMaxIterationsBlur(): void {
    const parsedValue = parseMaxIterationsInput(localMaxIterations);
    if (parsedValue === undefined) {
      if (job.max_iterations !== undefined) {
        onChange(jobId, { max_iterations: undefined });
      }
      return;
    }

    if (parsedValue === null) {
      return;
    }

    if (parsedValue !== job.max_iterations) {
      onChange(jobId, { max_iterations: parsedValue });
    }
  }

  function handleNeedsToggle(depId: string): void {
    const isCurrentDep: boolean = currentNeeds.includes(depId);
    let updated: string[];
    if (isCurrentDep) {
      updated = currentNeeds.filter((d: string): boolean => d !== depId);
    } else {
      updated = [...currentNeeds, depId];
    }
    onChange(jobId, { needs: updated.length > 0 ? updated : undefined });
  }

  function handleContinueOnErrorChange(checked: boolean): void {
    onChange(jobId, { continue_on_error: checked || undefined });
  }

  return (
    <PipelineDetailPanelShell title="Job settings" onClose={onClose}>
      {/* Job ID */}
      <FormField label="Job ID" error={jobIdError ?? undefined}>
        <TextField
          value={localJobId}
          onChange={(e) => setLocalJobId(e.target.value)}
          onBlur={handleJobIdBlur}
          onKeyDown={blurInputOnEnter}
          placeholder="job_id"
          disabled={readonly}
        />
      </FormField>

      {/* Display Name */}
      <FormField label="Display name" hint="Optional friendly name">
        <TextField
          value={localName}
          onChange={(e) => setLocalName(e.target.value)}
          onBlur={handleNameBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="Job name"
          disabled={readonly}
        />
      </FormField>

      {/* Dependencies (needs) */}
      {otherJobIds.length > 0 && (
        <FormField label="Dependencies" hint="Jobs that must complete first">
          <ChoiceList aria-label="Dependencies">
            {otherJobIds.map((otherId: string) => (
              <ChoiceListRow
                key={otherId}
                selected={currentNeeds.includes(otherId)}
                onClick={() => handleNeedsToggle(otherId)}
                disabled={readonly}
              >
                {otherId}
              </ChoiceListRow>
            ))}
          </ChoiceList>
        </FormField>
      )}

      {/* Condition (if) */}
      <FormField label="Condition" hint="Expression that must be truthy to run">
        <TextField
          value={localCondition}
          onChange={(e) => setLocalCondition(e.target.value)}
          onBlur={handleConditionBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="e.g. ${{ needs.build.result == 'success' }}"
          disabled={readonly}
        />
      </FormField>

      {/* Environment Variables */}
      <FormField label="Environment variables">
        <KeyValueEditor
          value={job.env ?? {}}
          onChange={(env) =>
            onChange(jobId, {
              env: Object.keys(env).length > 0 ? env : undefined,
            })
          }
          readonly={readonly}
        />
      </FormField>

      {/* Outputs */}
      <FormField label="Outputs" hint="Values exposed to downstream jobs">
        <KeyValueEditor
          value={job.outputs ?? {}}
          onChange={(outputs) =>
            onChange(jobId, {
              outputs:
                Object.keys(outputs).length > 0
                  ? (outputs as Record<string, string>)
                  : undefined,
            })
          }
          stringOnly
          readonly={readonly}
        />
      </FormField>

      {/* Timeout */}
      <FormField label="Timeout (minutes)">
        <TextField
          type="number"
          value={localTimeout}
          onChange={(e) => setLocalTimeout(e.target.value)}
          onBlur={handleTimeoutBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="No timeout"
          min={1}
          disabled={readonly}
        />
      </FormField>

      {/* Max Retries */}
      <FormField label="Max retries">
        <TextField
          type="number"
          value={localMaxRetries}
          onChange={(e) => setLocalMaxRetries(e.target.value)}
          onBlur={handleMaxRetriesBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="No retries"
          min={0}
          disabled={readonly}
        />
      </FormField>

      <FormField label="Max iterations">
        <TextField
          type="number"
          value={localMaxIterations}
          onChange={(e) => setLocalMaxIterations(e.target.value)}
          onBlur={handleMaxIterationsBlur}
          onKeyDown={(e) =>
            e.key === 'Enter' && (e.target as HTMLInputElement).blur()
          }
          placeholder="Max total passes (0 skips job)"
          min={0}
          disabled={readonly}
        />
      </FormField>

      {/* Continue on Error */}
      <FormField label="Continue on error">
        <ToggleField
          checked={job.continue_on_error === true}
          onChange={handleContinueOnErrorChange}
          label="Continue on error"
          disabled={readonly}
        />
      </FormField>

      {/* Summary */}
      <Surface variant="section" boundary="top">
        <div className="flex items-center justify-between gap-2 pt-2">
          <p className="text-xs fg-secondary">
            {job.steps.length} step{job.steps.length !== 1 ? 's' : ''} in this
            job
          </p>
          {onRemove && !readonly ? (
            <Button
              variant="ghost-destructive"
              size="compact"
              onClick={(): void => onRemove(jobId)}
              data-testid="pipeline-job-remove"
            >
              Remove job
            </Button>
          ) : null}
        </div>
      </Surface>
    </PipelineDetailPanelShell>
  );
}
