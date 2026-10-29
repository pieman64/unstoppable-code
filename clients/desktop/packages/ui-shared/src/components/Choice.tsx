import {
  forwardRef,
  type ForwardedRef,
  type InputHTMLAttributes,
  type JSX,
} from 'react';
import { CheckIcon } from '../icons/AppIcons';

/**
 * Canonical choice marks shared by desktop and web: `Checkbox`, `Radio`, and
 * the display-only `ChoiceMark` for rows that are buttons.
 *
 * - Box: 16px; a checkbox takes a 4px radius, a radio is round.
 * - Unchecked: a 1px inset `fg-quaternary` edge, the common checkbox weight.
 * - Checked: a neutral fill, `fg-primary` (black in light, white in dark),
 *   with the app checkmark in the page ink. Selection is not the primary
 *   action, so it takes no accent.
 * - Checkmark: the app's 12px check glyph.
 * - Focus: the neutral `shadow-field-focus` halo, like the text fields.
 *
 * `Checkbox` and `Radio` draw the native input itself as the mark, so the real
 * control stays visible and clickable (and reachable by `.check()` in UI
 * automation). `className` places the mark; its look belongs here.
 */

const CHECK_SIZE = 12;

const MARK_BOX = 'h-4 w-4 shrink-0';
const MARK_OFF = 'ring-1 ring-inset ring-fg-quaternary';
const MARK_ON = 'bg-fg-primary';
// The page ink reads on the neutral fill in both modes.
const CHECK_INK = '[color:var(--bg-base)]';

type ChoiceKind = 'checkbox' | 'radio';

function shapeClass(kind: ChoiceKind): string {
  return kind === 'checkbox' ? 'rounded' : 'rounded-full';
}

function Check(): JSX.Element {
  return <CheckIcon size={CHECK_SIZE} />;
}

export interface ChoiceMarkProps {
  kind: ChoiceKind;
  checked: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * The mark alone, for a row that is itself the control (a `<button>` with
 * `aria-pressed`). Hidden from assistive technology; the row carries the
 * state.
 */
export function ChoiceMark({
  kind,
  checked,
  disabled = false,
  className = '',
}: ChoiceMarkProps): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={`flex ${MARK_BOX} items-center justify-center ${shapeClass(kind)} ${checked ? `${MARK_ON} ${CHECK_INK}` : MARK_OFF} ${disabled ? 'opacity-50' : ''} ${className}`}
    >
      {checked && <Check />}
    </span>
  );
}

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

function ChoiceInput(
  kind: ChoiceKind,
  { checked, className = '', ...props }: CheckboxProps,
  ref: ForwardedRef<HTMLInputElement>,
): JSX.Element {
  return (
    <span className={`relative flex ${MARK_BOX} ${className}`}>
      <input
        ref={ref}
        type={kind}
        checked={checked}
        className={`peer ${MARK_BOX} cursor-pointer appearance-none outline-none transition-shadow focus-visible:shadow-field-focus disabled:cursor-not-allowed disabled:opacity-50 ${shapeClass(kind)} ${checked ? MARK_ON : MARK_OFF}`}
        {...props}
      />
      {checked && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 flex items-center justify-center peer-disabled:opacity-50 ${CHECK_INK}`}
        >
          <Check />
        </span>
      )}
    </span>
  );
}

/** A checkbox whose native input is drawn as the shared mark. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  function Checkbox(props, ref): JSX.Element {
    return ChoiceInput('checkbox', props, ref);
  },
);

Checkbox.displayName = 'Checkbox';

export type RadioProps = CheckboxProps;

/** A radio whose native input is drawn as the shared mark. */
export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  function Radio(props, ref): JSX.Element {
    return ChoiceInput('radio', props, ref);
  },
);

Radio.displayName = 'Radio';
