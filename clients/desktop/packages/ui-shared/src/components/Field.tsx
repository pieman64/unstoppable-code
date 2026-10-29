'use client';

import {
  forwardRef,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type JSX,
  type TextareaHTMLAttributes,
} from 'react';
import { ChevronDownMediumIcon } from '../icons/AppIcons';
import { FLOATING_MENU_GAP } from './FloatingMenu';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
} from './PickerMenu';

/**
 * Canonical form fields shared by desktop and web: `TextInput`, `TextArea`,
 * and `Select`. One recipe owns the box so every field reads the same:
 *
 * - Edge: `shadow-field`, the UI-Kit 1px inset `line-base` edge. It is a
 *   box-shadow rather than a border so focus can replace it outright.
 * - Focus: `shadow-field-focus`, a neutral grey edge with a soft halo,
 *   swapped in on `:focus-visible` (text fields match it for pointer focus
 *   too). No accent and no outline stacked around the edge.
 * - Inset: 12px across, 8px down, so a single-line field is 36px from its
 *   padding and a textarea's first line sits where single-line text does.
 *   A `compact` text input is the 28px toolbar field (the browser's address
 *   bar): 10px across, with the 8px radius of the 28px controls beside it,
 *   and 13px text like the tab titles above it.
 * - Text: typed values wrap normally, because `text-wrap: pretty` re-breaks
 *   finished lines as the last one grows; placeholders never change and
 *   stay pretty.
 *
 * `className` is for placement only (width, margins, flex). Surface, edge,
 * radius, inset, typography, and states belong here.
 */
const FIELD_SURFACE_CLASS =
  'w-full bg-transparent text-s fg-primary text-wrap placeholder:text-pretty placeholder:fg-tertiary outline-none shadow-field transition-shadow focus-visible:shadow-field-focus disabled:cursor-not-allowed disabled:bg-disabled disabled:fg-disabled';

const FIELD_CLASS = `min-h-9 rounded-lg px-3 py-2 pointer-coarse:min-h-11 ${FIELD_SURFACE_CLASS}`;

/**
 * Field size. `default` is the 36px form field. `compact` is the 28px field
 * that sits in a toolbar row of 28px controls. `settings` uses that height
 * with the capsule shape and 12px insets of Settings actions and dropdowns.
 */
export type TextInputDensity = 'default' | 'compact' | 'settings';

const TEXT_INPUT_CLASS: Record<TextInputDensity, string> = {
  default: FIELD_CLASS,
  settings: `h-7 rounded-full px-3 py-0 pointer-coarse:h-9 ${FIELD_SURFACE_CLASS.replace('text-s ', 'text-xs ').replace('text-wrap placeholder:text-pretty', 'whitespace-nowrap placeholder:whitespace-nowrap')}`,
  // The toolbar field reads at the 13px of the tab titles and controls
  // around it, one step under a form field's 14px.
  compact: `h-7 rounded-md px-2.5 py-0 pointer-coarse:h-9 ${FIELD_SURFACE_CLASS.replace('text-s ', 'text-xs ')}`,
};

function withPlacement(base: string, className: string): string {
  return className ? `${base} ${className}` : base;
}

export interface TextInputProps extends InputHTMLAttributes<HTMLInputElement> {
  readonly density?: TextInputDensity;
  /** Monospace for code, commands, and patterns. */
  readonly mono?: boolean;
  /**
   * `center` centers the value, for a field that shows a short summary of
   * its value at rest (an address bar showing only the host).
   */
  readonly align?: 'start' | 'center';
}

/** Single-line text, number, date, password, email, or URL field. */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  function TextInput(
    {
      type = 'text',
      density = 'default',
      mono = false,
      align = 'start',
      className = '',
      ...props
    },
    ref,
  ): JSX.Element {
    const base =
      align === 'center'
        ? `${TEXT_INPUT_CLASS[density]} text-center`
        : TEXT_INPUT_CLASS[density];
    const invalid =
      props['aria-invalid'] === true || props['aria-invalid'] === 'true';
    const treatment = `${base} ${mono ? 'font-mono' : ''} ${density === 'settings' && invalid ? 'ring-1 ring-inset ring-line-destructive' : ''}`;
    return (
      <input
        ref={ref}
        type={type}
        className={withPlacement(treatment, className)}
        {...props}
      />
    );
  },
);

TextInput.displayName = 'TextInput';

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/**
 * Multi-line field. Keeps native vertical resizing; `field-resize-grip`
 * repaints Chromium's grip 4px clear of the edge instead of flush in the
 * rounded corner.
 */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
  function TextArea({ rows = 2, className = '', ...props }, ref): JSX.Element {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={withPlacement(
          `${FIELD_CLASS} field-resize-grip resize-y`,
          className,
        )}
        {...props}
      />
    );
  },
);

TextArea.displayName = 'TextArea';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SelectProps {
  readonly options: readonly SelectOption[];
  /** The chosen value, or `null` while nothing is chosen. */
  readonly value: string | null;
  readonly onValueChange: (value: string) => void;
  /** Shown in the tertiary ink while nothing is chosen. */
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly id?: string;
  readonly 'aria-label'?: string;
  readonly 'aria-labelledby'?: string;
  readonly 'data-testid'?: string;
  /** Placement only (width, margins, flex). */
  readonly className?: string;
}

/**
 * Single-choice select drawn by Canopy rather than the operating system. The
 * trigger is a field (same edge, focus, inset, and app chevron as
 * `TextInput`); the menu is the shared picker (`FloatingPickerMenu` with
 * `PickerMenuOption` rows and a checkmark on the chosen one), at least as wide
 * as the field.
 *
 * `FloatingMenu`'s listbox mode owns the keyboard: ArrowUp/ArrowDown on the
 * trigger open the menu on the chosen option, arrows, Home, and End move,
 * typing jumps to a matching label, Enter or Space choose, and Escape, Tab,
 * or an outside press close with focus back on the trigger.
 *
 * For several choices use `Checkbox` rows; there is no multiple mode.
 */
export function Select({
  options,
  value,
  onValueChange,
  placeholder = 'Choose an option',
  disabled = false,
  required,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'data-testid': dataTestId,
  className = '',
}: SelectProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const chosen = options.find((option) => option.value === value);

  return (
    <span className={withPlacement('relative flex w-full', className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-required={required}
        disabled={disabled}
        data-testid={dataTestId}
        onClick={() => setOpen((current) => !current)}
        className={`${FIELD_CLASS} flex cursor-pointer items-center pr-9 text-left disabled:cursor-not-allowed`}
      >
        <span
          className={`min-w-0 flex-1 truncate ${chosen ? '' : 'fg-tertiary'}`}
        >
          {chosen?.label ?? placeholder}
        </span>
      </button>
      <SelectChevron />
      <FloatingPickerMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-left"
        // A field-attached menu sits closer than a free-standing picker.
        gap={FLOATING_MENU_GAP}
        interaction="listbox"
        role="listbox"
        id={listboxId}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        // A field-wide select opens a menu as wide as the field.
        maximumWidth="max(20rem, var(--canopy-picker-trigger-width))"
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <PickerMenuOption
              key={option.value}
              role="option"
              aria-selected={selected}
              selected={selected}
              disabled={option.disabled}
              onClick={() => onValueChange(option.value)}
            >
              <PickerMenuOptionContent>
                <PickerMenuOptionLabel>{option.label}</PickerMenuOptionLabel>
              </PickerMenuOptionContent>
              <PickerMenuOptionCheck selected={selected} />
            </PickerMenuOption>
          );
        })}
      </FloatingPickerMenu>
    </span>
  );
}

function SelectChevron(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 fg-tertiary"
    >
      <ChevronDownMediumIcon size={16} />
    </span>
  );
}
