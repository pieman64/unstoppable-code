import type { JSX } from 'react';
import {
  ChatComposerToolbarChip,
  buildCodexSpeedChip,
  type CodexSpeedSelection,
} from '@canopy/ui-shared';

/**
 * Legacy pipeline hook control. Pipeline inputs keep their boolean meaning
 * (`true` Fast, `false` Regular, unset inherits the run's configuration), so
 * this offers Use default, Fast, and Regular and never Ultra fast.
 */
function cycleFastMode(current: boolean | undefined): boolean | undefined {
  if (current === undefined) return true;
  if (current === true) return false;
  return undefined;
}

function toSelection(value: boolean | undefined): CodexSpeedSelection {
  if (value === undefined) return 'default';
  return value ? 'fast' : 'standard';
}

export function FastModeButton({
  value,
  onChange,
}: {
  value: boolean | undefined;
  onChange: (value: boolean | undefined) => void;
}): JSX.Element {
  const selection = toSelection(value);
  const next = cycleFastMode(value);
  return (
    <ChatComposerToolbarChip
      {...buildCodexSpeedChip({
        selection,
        ...(selection === 'default' ? {} : { effectiveSpeed: selection }),
        next: toSelection(next),
        onClick: (): void => onChange(next),
        variant: 'chip',
      })}
    />
  );
}
