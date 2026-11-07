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
  /**
   * The web chat header's request for the 44px touch floor on a coarse
   * pointer. Both looks render the shared `Button`, whose coarse-pointer hit
   * area already reaches it, so nothing more is drawn.
   */
  readonly coarsePointerTarget?: boolean;
  readonly dataTestId?: string;
  readonly disabled?: boolean;
  readonly onClick: MouseEventHandler<HTMLButtonElement>;
  readonly title?: string;
}

export function ForkChatButton({
  ariaLabel,
  className,
  dataTestId,
  disabled = false,
  onClick,
  title,
  'aria-controls': ariaControls,
  'aria-describedby': ariaDescribedBy,
  'aria-expanded': ariaExpanded,
}: ForkChatButtonProps): JSX.Element {
  const ariaAttributes = {
    'aria-controls': ariaControls,
    'aria-describedby': ariaDescribedBy,
    'aria-expanded': ariaExpanded,
  };
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
            <ForkSplitIcon size="sm" />
          </span>
        </Button>
      </Tooltip>
    );
  }
  // The retired classic look (no host chooses it any more): the plain ghost
  // icon action. A host that wraps the button in its own tooltip (desktop's
  // ActionTooltip) passes no title, so this one stays out of its way.
  return (
    <Tooltip label={title} disabled={title === undefined}>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={ariaLabel}
        className={className}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={onClick}
        {...ariaAttributes}
      >
        <AppCatalogGitForkIcon size="sm" aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}
