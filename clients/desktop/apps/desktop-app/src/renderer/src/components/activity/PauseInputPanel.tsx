import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  ExecutionState,
  PauseInputField,
  PipelinePauseCheckpoint,
  PipelinePauseResponse,
  PipelineScalar,
} from '@canopy/desktop-shared/types/pipeline';
import {
  validatePauseInputAnswerErrors,
  type PauseInputAnswerError,
} from '@canopy/desktop-shared/pipelines/pause-input-validation';
import {
  Checkbox,
  Select,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import { InputIcon } from '@canopy/ui-shared/icons';
import { pipelinePauseInputHeading } from '@canopy/ui-app';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  revalidatePauseDrafts,
  useRetainedSessionValue,
  useSessionWriter,
} from './details/pipelineDetailSession';

interface PauseInputPanelProps {
  executionId: string;
  state: ExecutionState;
  /**
   * Prefix that keeps this panel's field ids unique when several pipeline
   * details are open at once. Defaults to a per-instance React id.
   */
  idScope?: string;
}

function defaultFor(field: PauseInputField): PipelineScalar {
  if (field.default !== undefined) {
    return field.default;
  }
  if (field.type === 'boolean') {
    return false;
  }
  if (field.type === 'choice') {
    return field.required ? (field.options?.[0] ?? '') : '';
  }
  if (field.type === 'number') {
    return field.required ? (field.min ?? 0) : '';
  }
  return '';
}

function initialAnswers(
  fields: PauseInputField[],
): Record<string, PipelineScalar> {
  const answers: Record<string, PipelineScalar> = {};
  for (const field of fields) {
    answers[field.key] = defaultFor(field);
  }
  return answers;
}

function errorsForField(
  errors: PauseInputAnswerError[],
  fieldKey: string,
): string[] {
  return errors
    .filter((error) => error.field === fieldKey)
    .map((error) => error.message);
}

export function PauseInputPanel({
  executionId,
  state,
  idScope,
}: PauseInputPanelProps): JSX.Element {
  const instanceId = useId();
  const fieldIdPrefix = `pause-input-${idScope ?? instanceId}`;
  const resumeExecution = usePipelineRunsStore((s) => s.resumeExecution);
  const checkpoints = state.pending_pauses;
  const [selectedId, setSelectedId] = useState(checkpoints[0]?.id ?? '');
  // A panel keeps unsent answers across remounts. They are revalidated
  // against the checkpoints pending now: answers for a resumed checkpoint or
  // a field the request no longer asks for are dropped, never submitted.
  const retainedDrafts = useRetainedSessionValue(
    (session) => session.pauseDrafts[executionId],
  );
  const writeSession = useSessionWriter();
  const [drafts, setDraftsState] = useState<
    Record<string, Record<string, PipelineScalar>>
  >(() => {
    const retained = revalidatePauseDrafts(retainedDrafts, checkpoints);
    return Object.fromEntries(
      checkpoints.map((checkpoint) => [
        checkpoint.id,
        {
          ...initialAnswers(checkpoint.request?.fields ?? []),
          ...retained[checkpoint.id],
        },
      ]),
    );
  });
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const setDrafts = useCallback(
    (
      update: (
        current: Record<string, Record<string, PipelineScalar>>,
      ) => Record<string, Record<string, PipelineScalar>>,
    ): void => {
      const next = update(draftsRef.current);
      draftsRef.current = next;
      setDraftsState(next);
      writeSession((previous) => ({
        ...previous,
        pauseDrafts: { ...previous.pauseDrafts, [executionId]: next },
      }));
    },
    [executionId, writeSession],
  );
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    setDrafts((current) =>
      Object.fromEntries(
        checkpoints.map((checkpoint) => [
          checkpoint.id,
          current[checkpoint.id] ??
            initialAnswers(checkpoint.request?.fields ?? []),
        ]),
      ),
    );
    if (!checkpoints.some((checkpoint) => checkpoint.id === selectedId)) {
      setSelectedId(checkpoints[0]?.id ?? '');
    }
  }, [checkpoints, selectedId, setDrafts]);

  const selected =
    checkpoints.find((checkpoint) => checkpoint.id === selectedId) ??
    checkpoints[0];
  const request = selected?.request;
  const answers = useMemo(
    () => (selected ? (drafts[selected.id] ?? {}) : {}),
    [drafts, selected],
  );

  const errors = useMemo(
    () => (request ? validatePauseInputAnswerErrors(request, answers) : []),
    [answers, request],
  );
  const allValid = checkpoints.every((checkpoint) => {
    if (!checkpoint.request) return true;
    return (
      validatePauseInputAnswerErrors(
        checkpoint.request,
        drafts[checkpoint.id] ?? {},
      ).length === 0
    );
  });

  const setAnswer = (key: string, value: PipelineScalar): void => {
    if (!selected) return;
    setDrafts((current) => ({
      ...current,
      [selected.id]: { ...current[selected.id], [key]: value },
    }));
  };

  const responseFor = (
    checkpoint: PipelinePauseCheckpoint,
  ): PipelinePauseResponse => ({
    checkpoint_id: checkpoint.id,
    job_id: checkpoint.job_id,
    step_id: checkpoint.step_id,
    ...(checkpoint.request ? { answers: drafts[checkpoint.id] ?? {} } : {}),
  });

  const submit = async (responses: PipelinePauseResponse[]): Promise<void> => {
    if (submitting) return;

    // Answer only checkpoints that are still waiting. A view restored or
    // revealed from an older snapshot must not answer a request the run has
    // already moved past.
    const live = usePipelineRunsStore.getState().statesById[executionId];
    const pendingIds =
      live === undefined
        ? null
        : new Set(live.pending_pauses.map((checkpoint) => checkpoint.id));
    const current =
      pendingIds === null
        ? responses
        : responses.filter(
            (response) =>
              response.checkpoint_id === undefined ||
              pendingIds.has(response.checkpoint_id),
          );
    if (current.length === 0) {
      setServerError('This request is no longer waiting for input.');
      return;
    }

    setSubmitting(true);
    setServerError(null);
    try {
      const result = await resumeExecution(executionId, {
        pauseResponses: current,
      });
      if (!result.success) {
        setServerError(result.error ?? 'Failed to resume execution');
      }
    } catch (err) {
      setServerError(
        err instanceof Error ? err.message : 'Failed to resume execution',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (!selected) return <></>;
  const definition = state.job_definitions[selected.job_id];
  const matrixLabel = definition?.matrix
    ? ` (${Object.entries(definition.matrix.values)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(', ')})`
    : '';

  return (
    <div
      data-testid="pause-input-panel"
      className="mb-4 rounded-lg border border-line-attention/30 bg-warning-subtle p-4"
    >
      <div className="flex items-center gap-2 fg-warning">
        <InputIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="text-s font-semibold">
          {pipelinePauseInputHeading(checkpoints.length)}
        </span>
      </div>
      {checkpoints.length > 1 ? (
        <p className="mt-1 text-s fg-secondary">
          {checkpoints.length} jobs are waiting for input. Submit one response
          or complete all requests and resume them together.
        </p>
      ) : null}
      {checkpoints.length > 1 ? (
        <div className="mt-3 flex flex-col gap-1 text-xs fg-secondary">
          <span id={`${instanceId}-waiting-job`}>Waiting job</span>
          <Select
            data-testid="pause-input-selector"
            aria-labelledby={`${instanceId}-waiting-job`}
            disabled={submitting}
            value={selected.id}
            onValueChange={setSelectedId}
            options={checkpoints.map((checkpoint, index) => {
              const job = state.job_definitions[checkpoint.job_id];
              const matrix = job?.matrix
                ? ` (${Object.entries(job.matrix.values)
                    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                    .join(', ')})`
                : '';
              return {
                value: checkpoint.id,
                label: `${job?.name ?? checkpoint.logical_job_id}${matrix} — Request ${index + 1} of ${checkpoints.length}`,
              };
            })}
          />
        </div>
      ) : null}
      <div className="mt-2 text-xs fg-secondary">
        {definition?.name ?? selected.logical_job_id}
        {matrixLabel}
      </div>
      {request?.title ? (
        <div className="mt-2 text-s font-medium fg-primary">
          {request.title}
        </div>
      ) : null}
      <p className="mt-1 whitespace-pre-wrap text-s fg-secondary">
        {request?.message ??
          (request
            ? 'This run is paused and waiting for input.'
            : 'This job is paused and ready to continue.')}
      </p>

      {request ? (
        // The answers are blocked from session replay; the request itself,
        // the job, and the actions stay recorded.
        <div
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-4 flex flex-col gap-3`}
        >
          {request.fields.map((field) => (
            <PauseField
              key={field.key}
              field={field}
              value={answers[field.key]}
              errors={errorsForField(errors, field.key)}
              onChange={(value) => setAnswer(field.key, value)}
              disabled={submitting}
              inputId={`${fieldIdPrefix}-${field.key}`}
            />
          ))}
        </div>
      ) : null}

      {serverError ? (
        <p className="mt-3 text-xs fg-destructive">{serverError}</p>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          data-testid="pause-input-resume"
          disabled={submitting || errors.length > 0}
          onClick={() => void submit([responseFor(selected)])}
          className="rounded-md bg-accent px-4 py-1.5 text-s font-medium fg-emphasis disabled:opacity-50"
        >
          {submitting
            ? 'Resuming…'
            : request
              ? 'Submit response'
              : 'Resume job'}
        </button>
        {checkpoints.length > 1 ? (
          <button
            type="button"
            data-testid="pause-input-submit-all"
            disabled={submitting || !allValid}
            onClick={() =>
              void submit(
                checkpoints.map((checkpoint) => responseFor(checkpoint)),
              )
            }
            className="rounded-md border px-4 py-1.5 text-s font-medium fg-primary disabled:opacity-50"
          >
            {submitting ? 'Resuming…' : 'Submit all responses'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface PauseFieldProps {
  field: PauseInputField;
  value: PipelineScalar;
  errors: string[];
  onChange: (value: PipelineScalar) => void;
  disabled: boolean;
  inputId: string;
}

/** A choice field's options; an optional field without a default can be cleared. */
function choiceOptions(
  field: PauseInputField,
): { value: string; label: string }[] {
  const options = (field.options ?? []).map((option) => ({
    value: option,
    label: option,
  }));
  return !field.required && field.default === undefined
    ? [{ value: '', label: 'No selection' }, ...options]
    : options;
}

/** The chosen option, or `null` so the select shows its placeholder. */
function choiceValue(
  field: PauseInputField,
  value: PipelineScalar,
): string | null {
  const chosen = String(value);
  return choiceOptions(field).some((option) => option.value === chosen)
    ? chosen
    : null;
}

function PauseField({
  field,
  value,
  errors,
  onChange,
  disabled,
  inputId,
}: PauseFieldProps): JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-xs font-medium fg-primary">
        {field.label}
        {field.required ? (
          <span className="ml-2 text-3xs font-medium fg-warning">Required</span>
        ) : null}
      </label>
      {field.description ? (
        <span className="text-xs fg-secondary">{field.description}</span>
      ) : null}

      {field.type === 'choice' ? (
        <Select
          id={inputId}
          data-testid={`pause-field-${field.key}`}
          disabled={disabled}
          value={choiceValue(field, value)}
          onValueChange={onChange}
          placeholder="No selection"
          options={choiceOptions(field)}
        />
      ) : field.type === 'boolean' ? (
        <label className="flex items-center gap-2 text-s fg-primary">
          <Checkbox
            id={inputId}
            data-testid={`pause-field-${field.key}`}
            disabled={disabled}
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{value === true ? 'Yes' : 'No'}</span>
        </label>
      ) : field.type === 'number' ? (
        <TextInput
          id={inputId}
          data-testid={`pause-field-${field.key}`}
          type="number"
          disabled={disabled}
          min={field.min}
          max={field.max}
          value={String(value)}
          onChange={(event) => {
            const next = event.target.value;
            onChange(next === '' ? '' : Number(next));
          }}
        />
      ) : field.multiline ? (
        <TextArea
          id={inputId}
          data-testid={`pause-field-${field.key}`}
          disabled={disabled}
          rows={3}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <TextInput
          id={inputId}
          data-testid={`pause-field-${field.key}`}
          disabled={disabled}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      )}

      {errors.map((error) => (
        <span key={error} className="text-xs fg-destructive">
          {error}
        </span>
      ))}
    </div>
  );
}
