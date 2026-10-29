import type { JSX } from 'react';
import { WORKSPACE_COLOR_PALETTE } from './workspace-color-palette';

export interface ColorSwatchOption {
  value: string;
  label: string;
  /** Semantic CSS color, independent of the persisted value. */
  color: string;
}

export interface ColorSwatchPickerProps {
  /** Currently selected color, or `undefined` when nothing is chosen yet. */
  value: string | undefined;
  onChange: (color: string) => void;
  /** Defaults to the app-wide workspace palette. */
  palette?: readonly (string | ColorSwatchOption)[];
  disabled?: boolean;
  /** Applied to the swatch row, for automation. */
  testId?: string;
}

/**
 * The app's one color chooser: a row of fixed palette swatches, the selected
 * one ringed.
 *
 * Every surface that lets a user color something — workspaces, browser
 * profiles — renders this, so a swatch is the same size, the same shape, and
 * ringed the same way wherever it appears. There is deliberately no free-form
 * color input: an arbitrary hue cannot be checked for contrast against the
 * surfaces it lands on, and the palette is what keeps the app's colored marks
 * legible in both color modes.
 *
 * Selection state is the caller's. This component reports a click and nothing
 * else, so a host that tracks dirty state or revisions (the workspace dialog)
 * and one that writes straight through (browser profiles) can share it.
 */
export function ColorSwatchPicker({
  value,
  onChange,
  palette = WORKSPACE_COLOR_PALETTE,
  disabled = false,
  testId,
}: ColorSwatchPickerProps): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {palette.map((option) => {
        const swatch = typeof option === 'string' ? option : option.value;
        const label =
          typeof option === 'string' ? `Color ${option}` : option.label;
        const color = typeof option === 'string' ? option : option.color;
        return (
          <button
            key={swatch}
            type="button"
            aria-label={label}
            aria-pressed={value === swatch}
            disabled={disabled}
            onClick={() => onChange(swatch)}
            className={`focus-ring h-6 w-6 rounded-full transition disabled:opacity-60 ${
              value === swatch
                ? 'ring-2 ring-line-focus ring-offset-2 ring-offset-base'
                : 'hover:opacity-80'
            }`}
            style={{ backgroundColor: color }}
          />
        );
      })}
    </div>
  );
}
