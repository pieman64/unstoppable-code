import type { JSX } from 'react';
import { CheckIcon } from '../icons/AppIcons';
import { LoadingSpinner } from './LoadingSpinner';

export type SettingsSaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface SettingsSaveStatusProps {
  readonly state: SettingsSaveState;
  /**
   * What the line says at rest. Pages that save every change as it is made
   * say so; a page with a Save action can pass `null` to stay quiet.
   */
  readonly idleLabel?: string | null;
  /** Shown when the last save failed. The page shows the details nearby. */
  readonly errorLabel?: string;
  readonly dataTestId?: string;
}

/**
 * The save line beside a settings page title: "Changes save automatically"
 * at rest, then "Saving…" and "Saved" as a change goes through. Pure display;
 * the page owns the save and the timing.
 */
export function SettingsSaveStatus({
  state,
  idleLabel = 'Changes save automatically',
  errorLabel = 'Couldn’t save',
  dataTestId = 'settings-save-status',
}: SettingsSaveStatusProps): JSX.Element | null {
  if (state === 'idle' && idleLabel === null) return null;
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid={dataTestId}
      data-state={state}
      className={`inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap text-xs transition-colors ${
        state === 'idle'
          ? 'fg-tertiary'
          : state === 'error'
            ? 'fg-destructive'
            : 'fg-secondary'
      }`}
    >
      {state === 'saving' ? (
        <>
          <LoadingSpinner tone="secondary" decorative />
          Saving…
        </>
      ) : state === 'saved' ? (
        <>
          <CheckIcon
            width={13}
            height={13}
            aria-hidden={true}
            className="fg-success"
          />
          Saved
        </>
      ) : state === 'error' ? (
        errorLabel
      ) : (
        idleLabel
      )}
    </span>
  );
}
