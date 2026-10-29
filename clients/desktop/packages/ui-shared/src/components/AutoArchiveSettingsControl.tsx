import type { JSX, ReactNode } from 'react';

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
  readonly textSize?: 's' | 'sm';
  readonly children?: ReactNode;
}

/** Callback-driven Auto Delete settings shared by desktop and portal hosts. */
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
  textSize = 'sm',
  children,
}: AutoArchiveSettingsControlProps): JSX.Element {
  const textClass = textSize === 's' ? 'text-s' : 'text-sm';
  return (
    <div className="mt-4">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          data-testid={toggleTestId}
          className="rounded"
        />
        <span className={`${textClass} font-medium fg-primary`}>
          Auto delete
        </span>
      </label>
      <p className="mt-1 text-xs fg-secondary">{description}</p>
      {enabled && (
        <div className="mt-3 space-y-3">
          <div className="flex items-center gap-2">
            <span className={`${textClass} fg-secondary`}>After</span>
            <input
              type="number"
              value={days}
              onChange={(event) =>
                onDaysChange(
                  Math.max(
                    1,
                    Math.min(
                      maxDays,
                      Number.parseInt(event.target.value, 10) || fallbackDays,
                    ),
                  ),
                )
              }
              min={1}
              max={maxDays}
              data-testid={daysTestId}
              className={`w-20 rounded-lg bg-secondary/30 px-3 py-2 ${textClass} fg-primary outline-none ring-1 ring-inset ring-line-base`}
            />
            <span className={`${textClass} fg-secondary`}>{daysLabel}</span>
          </div>
          {children}
        </div>
      )}
    </div>
  );
}
