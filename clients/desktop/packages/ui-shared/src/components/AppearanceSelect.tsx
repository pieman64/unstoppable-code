'use client';

import { useId, useRef, useState, type JSX, type ReactNode } from 'react';
import { ChevronDownIcon } from '../icons/AppIcons';
import { Button } from './Button';
import {
  FloatingPickerMenu,
  PickerMenuOption,
  PickerMenuOptionCheck,
  PickerMenuOptionContent,
  PickerMenuOptionLabel,
} from './PickerMenu';

export interface AppearanceOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
  readonly preview?: ReactNode;
  readonly testId?: string;
}

/** Compact appearance dropdown; the host supplies theme previews and persistence. */
export function AppearanceSelect<Value extends string>({
  label,
  value,
  options,
  onChange,
  testId,
  disabled = false,
  busy = false,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly AppearanceOption<Value>[];
  readonly onChange: (value: Value) => void;
  readonly testId: string;
  readonly disabled?: boolean;
  readonly busy?: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const chosen = options.find((option) => option.value === value);
  return (
    <>
      <Button
        ref={anchorRef}
        size="compact"
        variant="secondary"
        className="w-36 shrink-0"
        style={{
          paddingLeft: chosen?.preview ? 11 : 12,
          columnGap: chosen?.preview ? 10 : undefined,
        }}
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open && !disabled}
        aria-busy={busy || undefined}
        disabled={disabled}
        aria-controls={open && !disabled ? listId : undefined}
        data-testid={testId}
        onClick={() => setOpen((current) => !current)}
      >
        {chosen?.preview}
        <span className="min-w-0 flex-1 truncate text-left">
          {chosen?.label}
        </span>
        <ChevronDownIcon size={12} aria-hidden="true" className="fg-tertiary" />
      </Button>
      <FloatingPickerMenu
        open={open && !disabled}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement="bottom-right"
        interaction="listbox"
        heightLimit={208}
        role="listbox"
        id={listId}
        aria-label={label}
      >
        {options.map((option) => (
          <PickerMenuOption
            key={option.value}
            role="option"
            aria-selected={option.value === value}
            selected={option.value === value}
            disabled={disabled}
            data-testid={option.testId}
            style={{ columnGap: option.preview ? 10 : undefined }}
            onClick={() => onChange(option.value)}
          >
            {option.preview}
            <PickerMenuOptionContent>
              <PickerMenuOptionLabel>{option.label}</PickerMenuOptionLabel>
            </PickerMenuOptionContent>
            <PickerMenuOptionCheck selected={option.value === value} />
          </PickerMenuOption>
        ))}
      </FloatingPickerMenu>
    </>
  );
}
