import type { JSX } from 'react';
import { SPINNER_TONE_CLASS_NAMES, type SpinnerTone } from './spinner-tone';
import { RefreshIcon as AppCatalogRefreshIcon } from '../icons/AppIcons';

interface RefreshSpinnerProps {
  spinning?: boolean;
  size?: number;
  /** Ink. `inherit` (the default) takes the surrounding text color. */
  tone?: SpinnerTone;
  className?: string;
}

export function RefreshSpinner({
  spinning = false,
  size = 14,
  tone = 'inherit',
  className = '',
}: RefreshSpinnerProps): JSX.Element {
  return (
    <AppCatalogRefreshIcon
      aria-hidden="true"
      width={size}
      height={size}
      className={`${spinning ? 'animate-spin' : ''} ${SPINNER_TONE_CLASS_NAMES[tone]} ${className}`}
    />
  );
}
