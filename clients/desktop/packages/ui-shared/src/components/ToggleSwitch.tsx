import type { JSX } from 'react';

export type ToggleSwitchSize = 'md' | 'sm';

export interface ToggleSwitchProps {
  readonly id?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /** Accessible name. Required: the track renders no text of its own. */
  readonly label: string;
  /** Id of an element that describes the switch, such as a note beside it. */
  readonly describedBy?: string;
  readonly onChange: (next: boolean) => void;
  readonly dataTestId?: string;
  /**
   * `md` (32x18) is every switch in Settings and the default elsewhere. `sm`
   * (28x16) is the Home composer's Pipeline toggle size.
   */
  readonly size?: ToggleSwitchSize;
}

/**
 * `lg` (36x20) is the switch of a settings row inside a composer panel (the
 * effort panel's fast mode); only `CompactToggleIndicator` draws it.
 */
type SwitchTrackSize = ToggleSwitchSize | 'lg';

// One switch drawing at three sizes: a 2px inset knob on a rounded track. The
// knob stretches toward the middle while the enclosing `group` is hovered,
// so the switch reads as pressable without a color change.
const TRACK_SIZE_CLASS_NAMES: Record<SwitchTrackSize, string> = {
  lg: 'h-5 w-9',
  md: 'h-4.5 w-8',
  sm: 'h-4 w-7',
};

const KNOB_SIZE_CLASS_NAMES: Record<SwitchTrackSize, string> = {
  lg: 'h-4 w-4 group-hover:w-4.5',
  md: 'h-3.5 w-3.5 group-hover:w-4',
  sm: 'h-3 w-3 group-hover:w-3.5',
};

const KNOB_ON_CLASS_NAMES: Record<SwitchTrackSize, string> = {
  lg: 'translate-x-4 group-hover:translate-x-3.5',
  md: 'translate-x-3.5 group-hover:translate-x-3',
  sm: 'translate-x-3 group-hover:translate-x-2.5',
};

const TRACK_STYLE = { transition: 'background-color 100ms ease-out' };
const KNOB_STYLE = {
  transition: 'width 100ms ease-out, translate 100ms ease-out',
};

function SwitchTrack({
  checked,
  size,
}: {
  readonly checked: boolean;
  readonly size: SwitchTrackSize;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      style={TRACK_STYLE}
      className={`relative inline-flex ${TRACK_SIZE_CLASS_NAMES[size]} shrink-0 items-center rounded-full ${
        checked ? 'bg-accent' : 'bg-fg-quaternary group-hover:bg-fg-tertiary'
      }`}
    >
      <span
        style={KNOB_STYLE}
        className={`absolute left-0.5 top-0.5 block ${KNOB_SIZE_CLASS_NAMES[size]} rounded-full bg-fg-emphasis ${
          checked ? KNOB_ON_CLASS_NAMES[size] : 'translate-x-0'
        }`}
      />
    </span>
  );
}

/**
 * The app's on/off switch. Pure display: it renders the track and knob and
 * reports the requested next value, so the caller owns the async work and the
 * `disabled` window around it.
 *
 * `role="switch"` + `aria-checked` rather than a styled checkbox, matching the
 * pattern the account, team, and digest surfaces already ship. The drawing is
 * the Home composer's Pipeline toggle (`CompactToggleIndicator`), so every
 * switch in the app is the same control.
 */
export function ToggleSwitch({
  id,
  checked,
  disabled,
  label,
  describedBy,
  onChange,
  dataTestId,
  size = 'md',
}: ToggleSwitchProps): JSX.Element {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      data-testid={dataTestId}
      onClick={() => onChange(!checked)}
      // `pointer-events-none` while disabled also stops the hover stretch.
      className="group focus-ring inline-flex shrink-0 rounded-full disabled:pointer-events-none disabled:opacity-60"
    >
      <SwitchTrack checked={checked} size={size} />
    </button>
  );
}

/**
 * Visual toggle for an existing switch or menu checkbox. The parent owns
 * interaction (and the `group` class that drives the hover stretch). `sm`
 * sits inline in a toolbar pill (New task's Pipeline); `lg` is a settings row
 * inside a composer panel.
 */
export function CompactToggleIndicator({
  checked,
  size = 'sm',
}: {
  readonly checked: boolean;
  readonly size?: 'sm' | 'lg';
}): JSX.Element {
  return <SwitchTrack checked={checked} size={size} />;
}
