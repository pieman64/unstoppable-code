import type { JSX } from 'react';
import { DiffToggle } from './DiffToggle';

const OPTIONS = [
  { value: 'all', label: 'All changes' },
  { value: 'turn', label: 'Turn changes' },
] as const;

/** Parent retains the historical turn references and owns source selection. */
export interface DiffComparisonToggleProps {
  value: 'all' | 'turn';
  onChange: (next: 'all' | 'turn') => void;
  dataTestId?: string;
}

export function DiffComparisonToggle(
  props: DiffComparisonToggleProps,
): JSX.Element {
  return <DiffToggle {...props} options={OPTIONS} />;
}
