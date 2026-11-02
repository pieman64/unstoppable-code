import { type JSX, useEffect, useState } from 'react';
import { SettingsRow, SettingsTextField } from './SettingsLayout';

const MIN_IDLE_TIMEOUT_MINUTES = 1;
const MAX_IDLE_TIMEOUT_MINUTES = 120;

function clampIdleTimeoutMinutes(value: number): number {
  return Math.min(
    MAX_IDLE_TIMEOUT_MINUTES,
    Math.max(MIN_IDLE_TIMEOUT_MINUTES, Math.trunc(value)),
  );
}

interface IdleTimeoutMinutesRowProps {
  /** Input id and test id. */
  id: string;
  description: string;
  /** The persisted minutes; the field follows it after every save. */
  minutes: number;
  onCommit: (minutes: number) => void;
}

/** The provider idle-timeout row shared by the Codex and Claude settings. */
export function IdleTimeoutMinutesRow({
  id,
  description,
  minutes,
  onCommit,
}: IdleTimeoutMinutesRowProps): JSX.Element {
  const [inputValue, setInputValue] = useState(String(minutes));
  useEffect(() => {
    setInputValue(String(minutes));
  }, [minutes]);

  return (
    <SettingsRow
      label="Idle timeout"
      htmlFor={id}
      description={description}
      control={
        <>
          <SettingsTextField
            id={id}
            type="number"
            width="xs"
            min={MIN_IDLE_TIMEOUT_MINUTES}
            max={MAX_IDLE_TIMEOUT_MINUTES}
            step={1}
            value={inputValue}
            data-testid={id}
            onChange={(e: React.ChangeEvent<HTMLInputElement>): void => {
              setInputValue(e.target.value);
            }}
            onBlur={(e: React.FocusEvent<HTMLInputElement>): void => {
              const raw = parseInt(e.target.value, 10);
              if (!Number.isFinite(raw)) {
                // Restore the last persisted value if the user left garbage
                // in the field.
                setInputValue(String(minutes));
                return;
              }
              const clamped = clampIdleTimeoutMinutes(raw);
              setInputValue(String(clamped));
              onCommit(clamped);
            }}
            onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>): void => {
              if (e.key === 'Enter') {
                e.currentTarget.blur();
              }
            }}
          />
          <span className="text-xs fg-secondary">minutes</span>
        </>
      }
    />
  );
}
