'use client';

import { useId, type JSX } from 'react';
import { ChoiceField } from './Choice';
import { TextInput } from './Field';
import { FormField } from './FormField';
import { Button } from './Button';
import { GitHubIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';

export interface MultiRepoProjectOption {
  readonly id: string;
  readonly name: string;
  readonly selected: boolean;
  readonly description?: string;
  readonly repositoryUrl?: string;
  readonly locked?: boolean;
}
export interface MultiRepoProjectSetupFieldsProps {
  readonly name: string;
  readonly onNameChange: (name: string) => void;
  readonly options: readonly MultiRepoProjectOption[];
  readonly onToggle: (id: string) => void;
  readonly optionsLabel?: string;
  readonly onOpenRepository?: (url: string) => void;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly error?: string | null;
}

/** Controlled fields: eligibility, expansion, persistence and cloning stay outside. */
export function MultiRepoProjectSetupFields({
  name,
  onNameChange,
  options,
  onToggle,
  optionsLabel = 'Source projects',
  onOpenRepository,
  disabled,
  loading,
  error,
}: MultiRepoProjectSetupFieldsProps): JSX.Element {
  const id = useId();
  return (
    <div className="space-y-3" aria-busy={loading}>
      <FormField id={`${id}-name`} label="Project name">
        {(control) => (
          <TextInput
            {...control}
            value={name}
            maxLength={256}
            onChange={(event) => onNameChange(event.target.value)}
            disabled={disabled}
            // The setup error is about the whole form, not this field.
            aria-describedby={error ? `${id}-error` : undefined}
          />
        )}
      </FormField>
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="mb-2 text-s fg-primary">{optionsLabel}</legend>
        {options.map((option) => (
          <div key={option.id} className="flex min-w-0 items-center gap-2">
            <ChoiceField
              className="min-w-0 flex-1"
              aria-label={option.description ? option.name : undefined}
              checked={option.selected}
              disabled={option.locked}
              onChange={() => onToggle(option.id)}
              label={
                <span className="flex min-w-0 items-center gap-2 fg-primary">
                  <span className={`min-w-0 break-words ${REPLAY_MASK_CLASS}`}>
                    {option.name}
                  </span>
                  {option.description && (
                    <span
                      className={`min-w-0 truncate fg-tertiary ${REPLAY_MASK_CLASS}`}
                    >
                      {option.description}
                    </span>
                  )}
                  {option.locked && (
                    <span className="shrink-0 text-xs fg-secondary">
                      Included
                    </span>
                  )}
                </span>
              }
            />
            {option.repositoryUrl && onOpenRepository && (
              <Button
                type="button"
                iconOnly
                size="compact"
                variant="ghost-quiet"
                aria-label="Open on GitHub"
                title="Open on GitHub"
                onClick={(event) => {
                  event.stopPropagation();
                  if (option.repositoryUrl)
                    onOpenRepository(option.repositoryUrl);
                }}
              >
                <GitHubIcon />
              </Button>
            )}
          </div>
        ))}
      </fieldset>
      {loading && (
        <p role="status" className="text-s fg-secondary">
          Checking repositories…
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-s fg-secondary">
          {error}
        </p>
      )}
    </div>
  );
}
