import type { JSX, ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { BackIcon as AppCatalogBackIcon } from '../icons/AppIcons';

const CONTENT_CLASS = 'flex-1 overflow-y-auto px-5 pb-5';

/**
 * Full-screen scrim + centered dialog card with a back button, used by the
 * plugins-surface detail overlays. Ported from the desktop `components/pages`
 * original — class names and markup match it exactly so tests/selectors and
 * visual diffs are unchanged.
 */
export function BackDetailOverlayShell({
  title,
  titleId,
  onBack,
  badge,
  children,
  blockContentFromReplay = false,
}: {
  title: string;
  titleId: string;
  onBack: () => void;
  badge?: ReactNode;
  children: ReactNode;
  /**
   * Mark only the scrolling content area with the session-replay block class,
   * for a body that is file content (such as a SKILL.md file). The header,
   * back button, and title stay recorded.
   */
  blockContentFromReplay?: boolean;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4"
      onClick={onBack}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-5 pt-5 pb-3">
          <button
            type="button"
            onClick={onBack}
            className="focus-ring rounded-md p-1 fg-secondary hover:bg-secondary hover:fg-primary"
            aria-label="Back"
          >
            <AppCatalogBackIcon width="16" height="16" />
          </button>
          <h2
            id={titleId}
            className="text-lg font-semibold fg-primary truncate"
          >
            {title}
          </h2>
          {badge}
        </div>

        <div
          className={
            blockContentFromReplay
              ? `${REPLAY_BLOCK_CLASS} ${CONTENT_CLASS}`
              : CONTENT_CLASS
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}
