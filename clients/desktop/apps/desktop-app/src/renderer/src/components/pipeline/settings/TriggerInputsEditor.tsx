import { type JSX, useEffect, useRef, useState } from 'react';
import type {
  PipelineInputDef,
  PipelineInputType,
  PipelineInputValue,
  PipelineTriggerType,
} from '@canopy/desktop-shared/types/pipeline';
import {
  formatPipelineInputDefault,
  formatJsonInputDefault,
  JSON_INPUT_ERROR_TEXT,
  JSON_INPUT_HELPER_TEXT,
  parseJsonInputValue,
} from '@/lib/pipelineTriggerInputs';
import { FormField } from '../shared/FormField';
import { TextField } from '../shared/TextField';
import { TextAreaField } from '../shared/TextAreaField';
import { SelectField } from '../shared/SelectField';
import { ToggleField } from '../shared/ToggleField';
import { Tooltip } from '@canopy/ui-shared';
import { Button, Heading, Surface } from '@canopy/ui-shared/components';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

const TRIGGER_LABELS: Record<PipelineTriggerType, string> = {
  dispatch: 'Dispatch',
  plan_ready: 'Plan ready',
  task_ready: 'Task ready',
};

const INPUT_TYPE_OPTIONS: { value: PipelineInputType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'choice', label: 'Choice' },
  { value: 'json', label: 'JSON' },
];

interface InputDefEditorProps {
  name: string;
  def: PipelineInputDef;
  existingNames: string[];
  onRename: (newName: string) => void;
  onChange: (def: PipelineInputDef) => void;
  onRemove: () => void;
  readonly?: boolean;
}

function coerceDefault(
  raw: string,
  type: PipelineInputType,
): PipelineInputValue | undefined {
  if (raw === '') return undefined;
  if (type === 'number') {
    const num = Number(raw);
    return Number.isNaN(num) ? raw : num;
  }
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return undefined;
  }
  return raw;
}

function defaultToString(value: PipelineInputValue | undefined): string {
  // `PipelineInputDef.default` is widened to `PipelineInputValue` for `json`
  // inputs; the shared formatter renders structured values as JSON rather than
  // `[object Object]` and leaves scalars byte-identical.
  return formatPipelineInputDefault(value);
}

interface JsonDefaultFieldProps {
  name: string;
  def: PipelineInputDef;
  onChange: (def: PipelineInputDef) => void;
  readonly: boolean;
}

function JsonDefaultField({
  name,
  def,
  onChange,
  readonly,
}: JsonDefaultFieldProps): JSX.Element {
  // Keep free-form JSON text local so a valid value such as `[1, 2]` does not
  // snap to its normalized representation while the author is typing. This
  // component unmounts when the input identity or type changes, which resets
  // the draft without synchronizing state during render.
  const [draft, setDraft] = useState(() => formatJsonInputDefault(def.default));
  const [error, setError] = useState<string>();
  const locallyEmittedDefault = useRef<string | undefined>(undefined);
  const formattedDefault = formatJsonInputDefault(def.default);

  useEffect(() => {
    if (locallyEmittedDefault.current === formattedDefault) {
      locallyEmittedDefault.current = undefined;
      return;
    }
    setDraft(formattedDefault);
    setError(undefined);
  }, [formattedDefault]);

  return (
    <>
      <TextAreaField
        data-testid={`trigger-input-def-json-default-${name}`}
        value={draft}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          if (raw === '') {
            setError(undefined);
            locallyEmittedDefault.current = formatJsonInputDefault(undefined);
            onChange({ ...def, default: undefined });
            return;
          }
          const parsed = parseJsonInputValue(raw);
          if (parsed === undefined) {
            setError(JSON_INPUT_ERROR_TEXT);
            return;
          }
          setError(undefined);
          locallyEmittedDefault.current = formatJsonInputDefault(parsed);
          onChange({ ...def, default: parsed });
        }}
        aria-invalid={error ? true : undefined}
        placeholder="(unset)"
        spellCheck={false}
        disabled={readonly}
      />
      {error && (
        <p
          className="text-xs fg-destructive"
          data-testid={`trigger-input-def-json-default-error-${name}`}
        >
          {error}
        </p>
      )}
    </>
  );
}

function InputDefEditor({
  name,
  def,
  existingNames,
  onRename,
  onChange,
  onRemove,
  readonly = false,
}: InputDefEditorProps): JSX.Element {
  const [nameDraft, setNameDraft] = useState(name);
  const type: PipelineInputType = def.type ?? 'string';
  const duplicate = nameDraft !== name && existingNames.includes(nameDraft);
  const nameError =
    nameDraft.trim() === ''
      ? 'Name is required'
      : duplicate
        ? 'Name must be unique'
        : undefined;

  function commitName(): void {
    if (nameError) {
      setNameDraft(name);
      return;
    }
    if (nameDraft !== name) {
      onRename(nameDraft);
    }
  }

  function updateType(nextType: PipelineInputType): void {
    const next: PipelineInputDef = { ...def, type: nextType };
    if (nextType !== 'choice') {
      delete next.options;
    } else if (!next.options) {
      next.options = [];
    }
    if (nextType !== 'number') {
      delete next.min;
      delete next.max;
    }
    // Reset default when switching to a type the current value can't represent.
    if (next.default !== undefined) {
      const coerced = coerceDefault(defaultToString(next.default), nextType);
      next.default = coerced;
    }
    onChange(next);
  }

  return (
    <Surface variant="group" size="small" padding="compact">
      <div className="space-y-3">
        <div className="flex gap-2 items-start">
          <div className="flex-1">
            <FormField label="Name" error={nameError}>
              <TextField
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                placeholder="input_name"
                disabled={readonly}
              />
            </FormField>
          </div>
          {!readonly && (
            <Tooltip label="Remove input">
              <Button
                variant="ghost"
                size="compact"
                iconOnly
                onClick={onRemove}
                aria-label="Remove input"
                className="mt-6"
              >
                <AppCatalogCloseIcon size="sm" />
              </Button>
            </Tooltip>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <FormField label="Type">
            <SelectField
              value={type}
              onChange={(e) => updateType(e.target.value as PipelineInputType)}
              options={INPUT_TYPE_OPTIONS}
              disabled={readonly}
            />
          </FormField>
          <FormField label="Required">
            <div className="pt-1">
              <ToggleField
                checked={def.required ?? false}
                onChange={(checked) =>
                  onChange({
                    ...def,
                    required: checked ? true : undefined,
                  })
                }
                disabled={readonly}
                label="Required"
              />
            </div>
          </FormField>
        </div>

        <FormField label="Description">
          <TextAreaField
            value={def.description ?? ''}
            onChange={(e) =>
              onChange({
                ...def,
                description: e.target.value || undefined,
              })
            }
            rows={2}
            placeholder="Shown to users in the run dialog"
            disabled={readonly}
          />
        </FormField>

        {type === 'choice' && (
          <FormField
            label="Options"
            hint="One per line. Shown in a dropdown at run time."
          >
            <TextAreaField
              value={(def.options ?? []).join('\n')}
              onChange={(e) => {
                const options = e.target.value
                  .split('\n')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0);
                onChange({
                  ...def,
                  options: options.length > 0 ? options : [],
                });
              }}
              rows={3}
              disabled={readonly}
            />
          </FormField>
        )}

        {type === 'number' && (
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Min">
              <TextField
                type="number"
                value={def.min ?? ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  const parsed = raw === '' ? undefined : Number(raw);
                  onChange({
                    ...def,
                    min:
                      parsed === undefined || Number.isNaN(parsed)
                        ? undefined
                        : parsed,
                  });
                }}
                disabled={readonly}
              />
            </FormField>
            <FormField label="Max">
              <TextField
                type="number"
                value={def.max ?? ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  const parsed = raw === '' ? undefined : Number(raw);
                  onChange({
                    ...def,
                    max:
                      parsed === undefined || Number.isNaN(parsed)
                        ? undefined
                        : parsed,
                  });
                }}
                disabled={readonly}
              />
            </FormField>
          </div>
        )}

        <FormField
          label="Default"
          hint={type === 'json' ? JSON_INPUT_HELPER_TEXT : undefined}
        >
          {type === 'json' ? (
            <JsonDefaultField
              name={name}
              def={def}
              onChange={onChange}
              readonly={readonly}
            />
          ) : type === 'boolean' ? (
            <SelectField
              value={defaultToString(def.default)}
              onChange={(e) =>
                onChange({
                  ...def,
                  default: coerceDefault(e.target.value, 'boolean'),
                })
              }
              options={[
                { value: 'true', label: 'True' },
                { value: 'false', label: 'False' },
              ]}
              placeholder="(unset)"
              disabled={readonly}
            />
          ) : type === 'choice' && def.options && def.options.length > 0 ? (
            <SelectField
              value={defaultToString(def.default)}
              onChange={(e) =>
                onChange({
                  ...def,
                  default: coerceDefault(e.target.value, 'choice'),
                })
              }
              options={def.options.map((opt) => ({ value: opt, label: opt }))}
              placeholder="(unset)"
              disabled={readonly}
            />
          ) : (
            <TextField
              type={type === 'number' ? 'number' : 'text'}
              value={defaultToString(def.default)}
              onChange={(e) =>
                onChange({
                  ...def,
                  default: coerceDefault(e.target.value, type),
                })
              }
              placeholder="(unset)"
              disabled={readonly}
            />
          )}
        </FormField>
      </div>
    </Surface>
  );
}

interface TriggerInputsEditorProps {
  triggerType: PipelineTriggerType;
  inputs: Record<string, PipelineInputDef>;
  onChange: (inputs: Record<string, PipelineInputDef>) => void;
  readonly?: boolean;
}

export function TriggerInputsEditor({
  triggerType,
  inputs,
  onChange,
  readonly = false,
}: TriggerInputsEditorProps): JSX.Element {
  const entries = Object.entries(inputs);
  const existingNames = entries.map(([name]) => name);

  function addInput(): void {
    const base = 'new_input';
    let candidate = base;
    let n = 1;
    while (candidate in inputs) {
      n += 1;
      candidate = `${base}_${n}`;
    }
    onChange({ ...inputs, [candidate]: { type: 'string' } });
  }

  function renameInput(oldName: string, newName: string): void {
    if (newName === oldName) return;
    if (newName in inputs) return;
    const next: Record<string, PipelineInputDef> = {};
    for (const [k, v] of Object.entries(inputs)) {
      next[k === oldName ? newName : k] = v;
    }
    onChange(next);
  }

  function updateInput(name: string, def: PipelineInputDef): void {
    onChange({ ...inputs, [name]: def });
  }

  function removeInput(name: string): void {
    const next = { ...inputs };
    delete next[name];
    onChange(next);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Heading level={4} variant="label">
          {TRIGGER_LABELS[triggerType]}
        </Heading>
        {!readonly && (
          <Button size="compact" onClick={addInput}>
            Add input
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="text-xs fg-secondary italic">
          No inputs defined for this trigger.
        </p>
      ) : (
        <div className="space-y-2">
          {entries.map(([name, def]) => (
            <InputDefEditor
              key={name}
              name={name}
              def={def}
              existingNames={existingNames}
              onRename={(newName) => renameInput(name, newName)}
              onChange={(next) => updateInput(name, next)}
              onRemove={() => removeInput(name)}
              readonly={readonly}
            />
          ))}
        </div>
      )}
    </div>
  );
}
