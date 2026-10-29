import type { JSX } from 'react';
import { TitlebarIconButton } from '@canopy/ui-shared';
import { BackIcon, ForwardIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';

interface HistoryArrowButtonProps {
  direction: 'back' | 'forward';
  enabled: boolean;
  onClick: () => void;
}

function HistoryArrowButton({
  direction,
  enabled,
  onClick,
}: HistoryArrowButtonProps): JSX.Element {
  const label = direction === 'back' ? 'Go back' : 'Go forward';
  return (
    <TitlebarIconButton
      onClick={onClick}
      disabled={!enabled}
      icon={direction === 'back' ? BackIcon : ForwardIcon}
      foreground="titlebar"
      aria-label={label}
      tooltipLabel={label}
      data-testid={`nav-history-${direction}`}
    />
  );
}

/**
 * Back/forward navigation-history arrows for the persistent titlebar corner.
 * Rendered in both sidebar states (expanded and collapsed) so the history is
 * always one click away, mirroring browser-style app chrome.
 */
export function NavigationHistoryButtons(): JSX.Element {
  const canGoBack = useNavigationHistoryStore((s) => s.canGoBack);
  const canGoForward = useNavigationHistoryStore((s) => s.canGoForward);
  const goBack = useNavigationHistoryStore((s) => s.goBack);
  const goForward = useNavigationHistoryStore((s) => s.goForward);

  return (
    <span
      className="pointer-events-auto inline-flex"
      data-testid="titlebar-navigation-history"
    >
      <HistoryArrowButton
        direction="back"
        enabled={canGoBack}
        onClick={() => void goBack()}
      />
      <HistoryArrowButton
        direction="forward"
        enabled={canGoForward}
        onClick={() => void goForward()}
      />
    </span>
  );
}
