import type { AriaAttributes, JSX, MouseEventHandler } from 'react';
import {
  GitForkIcon as AppCatalogGitForkIcon,
  ForkSplitIcon,
} from '../icons/AppIcons';
import { Button } from './Button';
import { CLEAN_ICON_BUTTON_VARIANT, useCleanChatLook } from './chat-look';
import { Tooltip } from './Tooltip';

export interface ForkChatButtonProps extends Pick<
  AriaAttributes,
  'aria-controls' | 'aria-describedby' | 'aria-expanded'
> {
  readonly ariaLabel: string;
  readonly className?: string;
  /** Grow to the 44px touch floor on a coarse pointer (the web chat header). */
  readonly coarsePointerTarget?: boolean;
  readonly dataTestId?: string;
  readonly disabled?: boolean;
  readonly onClick: MouseEventHandler<HTMLButtonElement>;
  readonly title?: string;
}

export function ForkChatButton({
  ariaLabel,
  className,
  coarsePointerTarget = false,
  dataTestId,
  disabled = false,
  onClick,
  title,
  ...ariaAttributes
}: ForkChatButtonProps): JSX.Element {
  const clean = useCleanChatLook();
  if (clean) {
    // Clean chat look: the reply row's one tooltip style, a single line in
    // sentence case, like Copy and "•••" beside it. The shared Button owns
    // its size, touch target and shrink, so no host classes apply here.
    return (
      <Tooltip label={title ?? ariaLabel}>
        <Button
          variant={CLEAN_ICON_BUTTON_VARIANT}
          size="sm"
          iconOnly
          aria-label={ariaLabel}
          data-testid={dataTestId}
          disabled={disabled}
          onClick={onClick}
          {...ariaAttributes}
        >
          {/* Split, turned a quarter right, reads as one line forking into
              two (ChatGPT's "Fork from here"). */}
          <span className="inline-flex rotate-90" aria-hidden="true">
            <ForkSplitIcon width="14" height="14" />
          </span>
        </Button>
      </Tooltip>
    );
  }
  // A host that wraps the button in its own tooltip (desktop's
  // ActionTooltip) passes no title, so this one stays out of its way.
  return (
    <Tooltip label={title} disabled={title === undefined}>
      <button
        type="button"
        aria-label={ariaLabel}
        className={`${'focus-ring flex h-6 w-6 items-center justify-center rounded-md bg-fg-primary/[0.04] fg-primary/80 ring-1 ring-line-base transition-colors hover:bg-fg-primary/[0.08] hover:fg-primary disabled:cursor-not-allowed disabled:opacity-50'}${
          coarsePointerTarget ? ' pointer-coarse:h-11 pointer-coarse:w-11' : ''
        }${className ? ` ${className}` : ''}`}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={onClick}
        {...ariaAttributes}
      >
        <AppCatalogGitForkIcon width="14" height="14" aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
