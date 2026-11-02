'use client';

import type { JSX } from 'react';
import { CheckIcon } from '../icons/AppIcons';

export interface DirectoryPickerOptionRowProps {
  readonly name: string;
  readonly selected: boolean;
  readonly onSelect: () => void;
  readonly 'data-testid'?: string;
}

/** The same working-directory option on desktop and the Portal. */
export function DirectoryPickerOptionRow({
  name,
  selected,
  onSelect,
  'data-testid': testId,
}: DirectoryPickerOptionRowProps): JSX.Element {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-testid={testId}
      onMouseDown={(event): void => event.preventDefault()}
      onClick={onSelect}
      className="outline-none flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-s fg-primary/80 transition-colors hover:bg-subtle focus-visible:bg-subtle"
    >
      <span className="w-4 text-center">
        {selected ? (
          <CheckIcon width={12} height={12} aria-hidden="true" />
        ) : null}
      </span>
      <span className="truncate">{name}</span>
    </button>
  );
}
