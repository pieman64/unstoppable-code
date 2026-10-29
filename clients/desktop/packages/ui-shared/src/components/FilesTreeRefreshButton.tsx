import type { JSX } from 'react';
import { RefreshIcon as CentralRefreshIcon } from '../icons/AppIcons';
import { useIconStyle } from './icon-style';
import { RefreshSpinner } from './RefreshSpinner';
import { Tooltip } from './Tooltip';

/**
 * Toolbar density the Files tab draws the control at. `compact` matches the
 * desktop Files header's 12px glyph row; `comfortable` matches the Portal and
 * cloud Files toolbar's 16px glyph row.
 */
export type FilesTreeRefreshButtonDensity = 'compact' | 'comfortable';

export interface FilesTreeRefreshButtonProps {
  readonly onClick: () => void;
  /** Disables the button. */
  readonly disabled?: boolean;
  /** Spins the glyph while a refresh is in flight. */
  readonly spinning?: boolean;
  readonly density?: FilesTreeRefreshButtonDensity;
  /**
   * Wraps the button in the shared hover tooltip. Defaults to true.
   * The desktop Files header has never shown one for this control.
   */
  readonly showTooltip?: boolean;
}

const LABEL = 'Refresh files';

const BUTTON_CLASS_NAMES: Record<FilesTreeRefreshButtonDensity, string> = {
  compact:
    'focus-ring rounded p-1 fg-secondary transition hover:bg-fg-primary/[0.08] hover:fg-primary disabled:cursor-not-allowed disabled:opacity-50',
  comfortable:
    'focus-ring rounded p-1 fg-secondary hover:bg-fg-primary/[0.06] disabled:opacity-50',
};

const CENTRAL_ICON_CLASS_NAMES: Record<FilesTreeRefreshButtonDensity, string> =
  {
    compact: 'h-3 w-3',
    comfortable: 'h-4 w-4',
  };

const CLASSIC_ICON_SIZES: Record<FilesTreeRefreshButtonDensity, number> = {
  compact: 14,
  comfortable: 16,
};

/**
 * The Files tab's refresh control, shared by the desktop Files tree and the
 * Portal and cloud Files tab. The glyph follows the host's icon style:
 * `central` draws the app refresh arrow, `classic` the original spinner.
 */
export function FilesTreeRefreshButton({
  onClick,
  disabled = false,
  spinning = false,
  density = 'comfortable',
  showTooltip = true,
}: FilesTreeRefreshButtonProps): JSX.Element {
  const central = useIconStyle() === 'central';
  const button = (
    <button
      type="button"
      aria-label={LABEL}
      data-testid="files-tree-refresh"
      disabled={disabled}
      className={BUTTON_CLASS_NAMES[density]}
      onClick={onClick}
    >
      {central ? (
        <CentralRefreshIcon
          className={`${CENTRAL_ICON_CLASS_NAMES[density]} ${spinning ? 'animate-spin' : ''}`}
        />
      ) : (
        <RefreshSpinner
          spinning={spinning}
          size={CLASSIC_ICON_SIZES[density]}
        />
      )}
    </button>
  );
  return showTooltip ? <Tooltip label={LABEL}>{button}</Tooltip> : button;
}
