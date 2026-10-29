import type { JSX } from 'react';
import type {
  LogFormatHint,
  PipelineScalar,
  Step,
} from '@canopy/desktop-shared/types/pipeline';
import { FormField } from '../shared/FormField';
import { TextField } from '../shared/TextField';
import { TextAreaField } from '../shared/TextAreaField';
import { SelectField } from '../shared/SelectField';
import { ToggleField } from '../shared/ToggleField';
import { KeyValueEditor } from '../shared/KeyValueEditor';
import { PipelineDetailPanelShell } from './PipelinePanelPrimitives';
import { pt } from '@/lib/platform-text';
import { uiText } from '@/lib/ui-text';
import {
  buildStepTargetFromForm,
  readStepTargetForm,
  type StepTargetFormState,
  type StepTargetScope,
} from '@/lib/pipelineStepTarget';
import {
  PIPELINE_SHELL_OPTIONS,
  type PipelineShellOption,
} from '../pipeline-shell-options';

interface StepDetailPanelProps {
  step: Step;
  stepIndex: number;
  jobId: string;
  onChange: (step: Step) => void;
  onClose: () => void;
  readonly?: boolean;
}

type StepMode = 'action' | 'script';

function buildShellOptions(): PipelineShellOption[] {
  return [
    { value: '', label: pt(uiText.pipelineShell.unsetDefault) },
    ...PIPELINE_SHELL_OPTIONS,
  ];
}

const LOG_FORMAT_HINT_OPTIONS = [
  { value: '', label: 'Plain text log' },
  { value: 'agent', label: 'Agent transcript' },
];

function getMode(step: Step): StepMode {
  if (step.run !== undefined) return 'script';
  return 'action';
}

function parseLogFormatHintValue(value: string): LogFormatHint | undefined {
  if (value === 'agent') {
    return 'agent';
  }

  return undefined;
}

/** The only `uses` value that carries a `target`. */
const RUN_PIPELINE_USES = 'builtin/run-pipeline';

const TARGET_SCOPE_OPTIONS: { value: StepTargetScope; label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'global', label: 'Global' },
  { value: 'directory', label: 'Directory' },
  { value: 'worktree', label: 'Worktree' },
];

function parseStepTargetScope(value: string): StepTargetScope | undefined {
  for (const option of TARGET_SCOPE_OPTIONS) {
    if (value === option.value) {
      return option.value;
    }
  }
  return undefined;
}

export function StepDetailPanel({
  step,
  stepIndex,
  onChange,
  onClose,
  readonly = false,
}: StepDetailPanelProps): JSX.Element {
  const mode = getMode(step);
  const headerLabel = step.id || `Step ${stepIndex + 1}`;

  function handleModeSwitch(newMode: StepMode): void {
    if (newMode === mode) return;

    if (newMode === 'script') {
      // Switching to Script: clear action-specific fields. `target` is part of
      // the action contract (it only applies to `builtin/run-pipeline`), so it
      // is cleared alongside `uses`/`with` rather than left orphaned.
      const updated = { ...step };
      delete updated.uses;
      delete updated.with;
      delete updated.log_format_hint;
      delete updated.skip_on_missing_action;
      delete updated.target;
      updated.run = '';
      onChange(updated);
    } else {
      // Switching to Action: clear script-specific fields
      const updated = { ...step };
      delete updated.run;
      delete updated.shell;
      delete updated.working_directory;
      updated.uses = '';
      onChange(updated);
    }
  }

  function handleFieldChange<K extends keyof Step>(
    field: K,
    value: Step[K] | undefined,
  ): void {
    const updated = { ...step };
    if (value === undefined || value === '') {
      delete updated[field];
    } else {
      updated[field] = value;
    }
    onChange(updated);
  }

  function handleUsesChange(value: string): void {
    const uses = value || undefined;
    const updated = { ...step };
    if (uses === undefined) {
      delete updated.uses;
    } else {
      updated.uses = uses;
    }
    if (uses !== RUN_PIPELINE_USES) {
      delete updated.target;
    }
    onChange(updated);
  }

  function handleWithChange(newWith: Record<string, PipelineScalar>): void {
    const updated = { ...step };
    if (Object.keys(newWith).length > 0) {
      updated.with = newWith;
    } else {
      delete updated.with;
    }
    onChange(updated);
  }

  function handleEnvChange(newEnv: Record<string, PipelineScalar>): void {
    const updated = { ...step };
    if (Object.keys(newEnv).length > 0) {
      updated.env = newEnv;
    } else {
      delete updated.env;
    }
    onChange(updated);
  }

  const isRunPipeline = step.uses === RUN_PIPELINE_USES;
  const targetForm = readStepTargetForm(step.target);

  // Rebuild and store the whole `target` object on every field change. We never
  // delete `target` here, so editing an unrelated target field cannot drop it.
  function updateTargetForm(patch: Partial<StepTargetFormState>): void {
    const next = buildStepTargetFromForm({ ...targetForm, ...patch });
    onChange({ ...step, target: next });
  }

  return (
    <PipelineDetailPanelShell title={headerLabel} onClose={onClose}>
      {/* Step ID */}
      <FormField label="Step ID" hint="Optional identifier for this step">
        <TextField
          value={step.id || ''}
          onChange={(e): void =>
            handleFieldChange('id', e.target.value || undefined)
          }
          placeholder="e.g. build, test, deploy"
          disabled={readonly}
        />
      </FormField>

      {/* Step Name */}
      <FormField label="Step name" hint="Optional display name">
        <TextField
          value={step.name || ''}
          onChange={(e): void =>
            handleFieldChange('name', e.target.value || undefined)
          }
          placeholder="e.g. Build project"
          disabled={readonly}
        />
      </FormField>

      {/* Type toggle */}
      <FormField label="Type">
        <div className="flex rounded-md border overflow-hidden">
          <button
            type="button"
            disabled={readonly}
            onClick={(): void => handleModeSwitch('action')}
            className={`flex-1 px-3 py-2 text-s font-medium transition-colors ${
              mode === 'action'
                ? 'bg-accent fg-emphasis'
                : 'bg-base fg-secondary hover:fg-primary'
            } ${readonly ? 'cursor-not-allowed' : ''}`}
          >
            Action
          </button>
          <button
            type="button"
            disabled={readonly}
            onClick={(): void => handleModeSwitch('script')}
            className={`flex-1 px-3 py-2 text-s font-medium transition-colors ${
              mode === 'script'
                ? 'bg-accent fg-emphasis'
                : 'bg-base fg-secondary hover:fg-primary'
            } ${readonly ? 'cursor-not-allowed' : ''}`}
          >
            Script
          </button>
        </div>
      </FormField>

      {/* Mode-specific fields */}
      <div className="pt-2 border-t space-y-4">
        {mode === 'action' ? (
          <>
            <FormField label="Uses" hint="Action reference">
              <TextField
                value={step.uses || ''}
                onChange={(e): void => handleUsesChange(e.target.value)}
                placeholder="builtin/action-name or project/action-name"
                disabled={readonly}
              />
            </FormField>

            <div>
              <h4 className="text-xs font-medium fg-secondary mb-2">
                Inputs (with)
              </h4>
              <KeyValueEditor
                value={step.with || {}}
                onChange={handleWithChange}
                readonly={readonly}
              />
            </div>

            <FormField
              label="Log format"
              hint="Choose how this action step’s log should be rendered"
            >
              <SelectField
                value={step.log_format_hint || ''}
                onChange={(e): void =>
                  handleFieldChange(
                    'log_format_hint',
                    parseLogFormatHintValue(e.target.value),
                  )
                }
                options={LOG_FORMAT_HINT_OPTIONS}
                disabled={readonly}
              />
            </FormField>

            {isRunPipeline && (
              <div
                className="pt-2 border-t space-y-4"
                data-testid="step-target-editor"
              >
                <h4 className="text-xs font-medium fg-secondary ">Target</h4>

                <FormField
                  label="Scope"
                  hint="Where the child pipeline runs. Inherit reuses this step’s context."
                >
                  <SelectField
                    value={targetForm.scope}
                    onChange={(e): void => {
                      const scope = parseStepTargetScope(e.target.value);
                      if (!scope) return;
                      updateTargetForm({ scope });
                    }}
                    options={TARGET_SCOPE_OPTIONS}
                    disabled={readonly}
                  />
                </FormField>

                {targetForm.scope === 'directory' && (
                  <FormField label="Path">
                    <TextField
                      value={targetForm.path}
                      onChange={(e): void =>
                        updateTargetForm({ path: e.target.value })
                      }
                      placeholder="Path for child pipeline"
                      disabled={readonly}
                    />
                  </FormField>
                )}

                {targetForm.scope === 'worktree' && (
                  <>
                    <FormField label="Project ID">
                      <TextField
                        value={targetForm.workspaceId}
                        onChange={(e): void =>
                          updateTargetForm({ workspaceId: e.target.value })
                        }
                        placeholder="workspace_id"
                        disabled={readonly}
                      />
                    </FormField>

                    <FormField label="Worktree ID">
                      <TextField
                        value={targetForm.worktreeId}
                        onChange={(e): void =>
                          updateTargetForm({ worktreeId: e.target.value })
                        }
                        placeholder="worktree_id"
                        disabled={readonly}
                      />
                    </FormField>
                  </>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <FormField label="Run" hint="Inline script to execute">
              <TextAreaField
                value={step.run || ''}
                onChange={(e): void =>
                  handleFieldChange('run', e.target.value || undefined)
                }
                rows={6}
                placeholder="echo 'hello world'"
                disabled={readonly}
              />
            </FormField>

            <FormField label="Shell">
              <SelectField
                value={step.shell || ''}
                onChange={(e): void =>
                  handleFieldChange(
                    'shell',
                    (e.target.value as Step['shell']) || undefined,
                  )
                }
                options={buildShellOptions()}
                disabled={readonly}
              />
            </FormField>

            <FormField label="Working directory">
              <TextField
                value={step.working_directory || ''}
                onChange={(e): void =>
                  handleFieldChange(
                    'working_directory',
                    e.target.value || undefined,
                  )
                }
                placeholder="e.g. ./packages/core"
                disabled={readonly}
              />
            </FormField>
          </>
        )}
      </div>

      {/* Common fields */}
      <div className="pt-2 border-t space-y-4">
        <h4 className="text-xs font-medium fg-secondary ">Common settings</h4>

        <FormField
          label="Condition (if)"
          hint="Expression that determines if this step runs"
        >
          <TextField
            value={step.if || ''}
            onChange={(e): void =>
              handleFieldChange('if', e.target.value || undefined)
            }
            placeholder="e.g. steps.build.outcome == 'success'"
            disabled={readonly}
          />
        </FormField>

        <div>
          <h4 className="text-xs font-medium fg-secondary mb-2">
            Environment variables
          </h4>
          <KeyValueEditor
            value={step.env || {}}
            onChange={handleEnvChange}
            readonly={readonly}
          />
        </div>

        <FormField label="Timeout (minutes)">
          <TextField
            type="number"
            value={
              step.timeout_minutes !== undefined
                ? String(step.timeout_minutes)
                : ''
            }
            onChange={(e): void => {
              const val = e.target.value;
              if (val === '') {
                handleFieldChange('timeout_minutes', undefined);
              } else {
                const num = Number(val);
                if (!Number.isNaN(num) && num >= 0) {
                  handleFieldChange('timeout_minutes', num);
                }
              }
            }}
            placeholder="No timeout"
            min="0"
            disabled={readonly}
          />
        </FormField>

        <FormField label="Continue on error">
          <ToggleField
            checked={step.continue_on_error || false}
            onChange={(checked): void =>
              handleFieldChange('continue_on_error', checked || undefined)
            }
            disabled={readonly}
          />
        </FormField>

        {step.uses !== undefined && (
          <FormField label="Skip on missing action">
            <ToggleField
              checked={step.skip_on_missing_action || false}
              onChange={(checked): void =>
                handleFieldChange(
                  'skip_on_missing_action',
                  checked || undefined,
                )
              }
              disabled={readonly}
            />
          </FormField>
        )}
      </div>
    </PipelineDetailPanelShell>
  );
}
