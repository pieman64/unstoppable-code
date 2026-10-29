import type { CSSProperties, JSX, ReactNode } from 'react';

import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { LoadingSpinner } from './LoadingSpinner';
import { useLoadingIndicatorStyle } from './LoadingIndicatorStyle';
import { Notice, NoticeButton } from './Notice';

// Pure display components for inline error banners, loading placeholders, and
// empty states. `ErrorBanner` is the destructive `Notice`; the other two rely
// on the shared Tailwind utilities and semantic roles used by the desktop
// renderer and the web app.

/** The default label of an {@link ErrorBanner}'s retry action. */
const ERROR_BANNER_RETRY_LABEL = 'Retry';

export function ErrorBanner({
  className = 'mb-4',
  error,
  blockMessageFromReplay = false,
  onRetry,
  retryLabel = ERROR_BANNER_RETRY_LABEL,
}: {
  className?: string;
  error: string | null | undefined;
  /**
   * Block the error text in session replay, for errors that quote command
   * output; the banner itself stays recorded.
   */
  blockMessageFromReplay?: boolean;
  /**
   * Shows a retry action in the notice's actions slot. Pass it only when
   * running the failed step again can fix the failure.
   */
  onRetry?: () => void;
  /** The retry action's label. Defaults to `Retry`. */
  retryLabel?: string;
}): JSX.Element | null {
  if (!error) return null;
  const actions = onRetry ? (
    <NoticeButton onClick={onRetry}>{retryLabel}</NoticeButton>
  ) : undefined;
  // Errors that can quote command output put the block class on the title
  // and message.
  const textClass = blockMessageFromReplay ? REPLAY_BLOCK_CLASS : '';
  // An error string is usually "what failed. what to do." — lead with the
  // first sentence as the title and let the rest follow it in the quieter
  // ink, so every caller gets the title-then-explanation shape for free.
  // The second sentence must open like one (a capital, a digit, or a
  // quote), so an abbreviation such as "e.g. timeouts" does not end the
  // title early.
  const trimmed = error.trim();
  const split = /^(.*?[.!?])\s+((?=[A-Z0-9"'\u2018\u201C])\S[\s\S]*)$/.exec(
    trimmed,
  );
  const title = split?.[1] ?? '';
  const message = split?.[2] ?? '';
  if (!title || !message) {
    return (
      <Notice intent="destructive" className={className} actions={actions}>
        <span className={textClass}>{trimmed}</span>
      </Notice>
    );
  }
  return (
    <Notice
      intent="destructive"
      title={<span className={textClass}>{title}</span>}
      className={className}
      actions={actions}
    >
      <span className={textClass}>{message}</span>
    </Notice>
  );
}

/**
 * Room a loading placeholder holds while its content arrives, named for the
 * space it stands in for. `inline` sits in flow like a line of text; `fill`
 * takes its container's full height and centers the label in it.
 */
export type LoadingPlaceholderSpace =
  | 'inline'
  | 'compact'
  | 'section'
  | 'panel'
  | 'page'
  | 'fill';

const LOADING_PLACEHOLDER_SPACE_CLASS_NAMES: Record<
  LoadingPlaceholderSpace,
  string
> = {
  inline: '',
  compact: 'py-4',
  section: 'py-8',
  panel: 'py-12',
  page: 'py-16',
  fill: 'h-full',
};

/**
 * A region's loading state. Under the `text` loading style it shows `label`
 * ("Loading…" by default). Under `spinner`, a placeholder without a `label`
 * is the spinner alone; a label that says what is loading still shows as
 * text, with the spinner when `showSpinner` is set.
 */
export function LoadingPlaceholder({
  label,
  space = 'panel',
  className = '',
  showSpinner = false,
  style,
}: {
  label?: string;
  space?: LoadingPlaceholderSpace;
  /** Placement only: flex participation, margin, and alignment. */
  className?: string;
  showSpinner?: boolean;
  style?: CSSProperties;
}): JSX.Element {
  const indicatorStyle = useLoadingIndicatorStyle();
  const spinnerStyle = indicatorStyle === 'spinner';
  return (
    <div
      className={`flex items-center justify-center gap-2 ${LOADING_PLACEHOLDER_SPACE_CLASS_NAMES[space]} ${className}`}
      style={style}
    >
      {spinnerStyle && label === undefined ? (
        <LoadingSpinner tone="secondary" sizePx={14} />
      ) : (
        <>
          {showSpinner && (
            <LoadingSpinner
              tone="secondary"
              sizePx={spinnerStyle ? 14 : undefined}
            />
          )}
          <p className="text-s fg-secondary">{label ?? 'Loading…'}</p>
        </>
      )}
    </div>
  );
}

export function EmptyState({
  testId,
  icon,
  title,
  subtitle,
  action,
  tone = 'default',
  titleWeight = 'medium',
  inset = 'default',
  spacing = 'default',
}: {
  testId?: string;
  /**
   * Optional glyph rendered above the title.
   *
   * An empty state is not automatically a failure - "everyone already has
   * access" and "no results for this query" are different outcomes that read
   * identically as bare prose. The icon is what distinguishes them at a
   * glance, so callers own both the glyph and its color (only a genuinely
   * good outcome should be colored `fg-success`; if every state were green
   * the color would stop meaning anything).
   *
   * Optional by design: every existing caller renders exactly as before.
   */
  icon?: ReactNode;
  /** A node, so a caller can block one value in it from session replay. */
  title: ReactNode;
  /** How to fill the empty state. Omit when the title already says enough. */
  subtitle?: string;
  action?: ReactNode;
  /** Quiet placeholders use supporting ink for the title and icon. */
  tone?: 'default' | 'quiet';
  /** Keep explanatory empty-state titles at regular body weight when needed. */
  titleWeight?: 'normal' | 'medium';
  /** `none` drops the page-level vertical inset for a host that centers it. */
  inset?: 'default' | 'none';
  /** `relaxed` gives the icon a wider gap above the title. */
  spacing?: 'default' | 'relaxed';
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col items-center justify-center text-center ${inset === 'none' ? '' : 'py-16'}`}
    >
      {icon && (
        <div
          className={`${spacing === 'relaxed' ? 'mb-3' : 'mb-2'} flex items-center justify-center ${tone === 'quiet' ? 'fg-quaternary' : ''}`}
        >
          {icon}
        </div>
      )}
      <h3
        className={`${subtitle ? 'mb-1' : ''} text-s ${titleWeight === 'normal' ? 'font-normal' : 'font-medium'} ${tone === 'quiet' ? 'fg-quaternary' : 'fg-primary'}`}
      >
        {title}
      </h3>
      {subtitle ? <p className="text-xs fg-secondary">{subtitle}</p> : null}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
