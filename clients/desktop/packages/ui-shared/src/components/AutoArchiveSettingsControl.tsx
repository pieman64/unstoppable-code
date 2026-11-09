import { Stack } from './Stack';
import { useId, type JSX, type ReactNode } from 'react';
import { TextInput } from './Field';
import { SettingsRowsRow, SettingsRowsSubRow } from './settings/SettingsRows';
import { ToggleSwitch } from './ToggleSwitch';

export interface AutoArchiveSettingsControlProps {
  readonly enabled: boolean;
  readonly days: number;
  readonly maxDays: number;
  readonly fallbackDays: number;
  readonly description: string;
  readonly toggleTestId: string;
  readonly daysTestId: string;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onDaysChange: (days: number) => void;
  readonly daysLabel?: string;
  /**
   * @deprecated The control now uses the Settings row text sizes; kept so
   * existing callers compile.
   */
  readonly textSize?: 's' | 'sm';
  readonly children?: ReactNode;
}

/**
 * Callback-driven Auto Delete settings shared by desktop and portal hosts:
 * a Settings row with the on/off switch, and, while it is on, the inactivity
 * period as a dependent sub-row followed by the host's own options.
 */
export function AutoArchiveSettingsControl({
  enabled,
  days,
  maxDays,
  fallbackDays,
  description,
  toggleTestId,
  daysTestId,
  onEnabledChange,
  onDaysChange,
  daysLabel = 'days of inactivity',
  children,
}: AutoArchiveSettingsControlProps): JSX.Element {
  const switchId = useId();
  const daysId = useId();
  return (
    <div className="mt-4">
      <SettingsRowsRow
        label="Auto delete"
        htmlFor={switchId}
        description={description}
        control={
          <ToggleSwitch
            id={switchId}
            checked={enabled}
            label="Auto delete"
            onChange={onEnabledChange}
            dataTestId={toggleTestId}
          />
        }
      >
        {enabled ? (
          <Stack gap="item">
            <SettingsRowsSubRow
              label="After"
              htmlFor={daysId}
              control={
                <>
                  <div className="w-20">
                    <TextInput
                      id={daysId}
                      density="settings"
                      type="number"
                      value={days}
                      onChange={(event) =>
                        onDaysChange(
                          Math.max(
                            1,
                            Math.min(
                              maxDays,
                              Number.parseInt(event.target.value, 10) ||
                                fallbackDays,
                            ),
                          ),
                        )
                      }
                      min={1}
                      max={maxDays}
                      data-testid={daysTestId}
                    />
                  </div>
                  <span className="text-s fg-secondary">{daysLabel}</span>
                </>
              }
            />
            {children}
          </Stack>
        ) : null}
      </SettingsRowsRow>
    </div>
  );
}
