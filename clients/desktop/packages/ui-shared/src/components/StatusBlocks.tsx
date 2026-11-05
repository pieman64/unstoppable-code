import type { CSSProperties, JSX, ReactNode } from 'react';

import { WarningIcon, type AppIcon } from '../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { CopyDetailsButton } from './CopyDetailsButton';
import { LoadingButton } from './LoadingButton';
import { LoadingSpinner } from './LoadingSpinner';
import { useLoadingIndicatorStyle } from './LoadingIndicatorStyle';
import { Notice, NoticeButton } from './Notice';
import { TRY_AGAIN_LABEL, TRYING_AGAIN_LABEL } from './useRetry';

// Pure display components for inline error banners, failed places, loading
// placeholders, and empty states. `ErrorBanner` is the destructive `Notice`;
// the others rely on the shared Tailwind utilities and semantic roles used by
// the desktop renderer and the web app.

/**
 * A message's closing `Try again.`, which the banner's own Try again button
 * already says.
 */
const TRAILING_TRY_AGAIN = /\s*Try again\.$/;

/**
 * The copy beside a Try again button: without a closing `Try again.`, which
 * the button already says (`Couldn't load this. Try again.` reads
 * `Couldn't load this.`). A message that is only that sentence stays.
 */
function besideTryAgain(message: string): string {
  const trimmed = message.trim();
  return trimmed.replace(TRAILING_TRY_AGAIN, '') || trimmed;
}

export function ErrorBanner({
  className = 'mb-4',
  error,
  blockMessageFromReplay = false,
  onRetry,
  retryLabel = TRY_AGAIN_LABEL,
  retrying = false,
  testId,
  details,
}: {
  className?: string;
  error: string | null | undefined;
  /**
   * The raw failure reason (a server's text). Never rendered: it adds a
   * `Copy details` action that copies it for support. Settings pass the
   * server reason here and our own sentence as `error`.
   */
  details?: string;
  /**
   * `data-testid` on the notice. The alert role sits on its copy inside it,
   * so pressing an action (`Copied`, `Trying again…`) is not announced again.
   */
  testId?: string;
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
  /**
   * The retry action's label. Defaults to `Try again`, the one retry verb;
   * name a different action only when it does something else (`Rescan`).
   */
  retryLabel?: string;
  /**
   * The retry is running: its capsule keeps its resting width and shows only
   * a spinner. `Trying again…` is the accessible label for a `Try again`
   * action; the banner stays, so nothing blanks.
   */
  retrying?: boolean;
}): JSX.Element | null {
  if (!error) return null;
  const retry = onRetry ? (
    <NoticeButton
      onClick={onRetry}
      busy={retrying}
      busyLabel={
        retryLabel === TRY_AGAIN_LABEL ? TRYING_AGAIN_LABEL : undefined
      }
    >
      {retryLabel}
    </NoticeButton>
  ) : null;
  const copyDetails = details ? <CopyDetailsButton details={details} /> : null;
  const actions =
    retry || copyDetails ? (
      <>
        {copyDetails}
        {retry}
      </>
    ) : undefined;
  // Errors that can quote command output put the block class on the title
  // and message.
  const textClass = blockMessageFromReplay ? REPLAY_BLOCK_CLASS : '';
  // With its own Try again button, the message does not also say it.
  const trimmed =
    onRetry && retryLabel === TRY_AGAIN_LABEL
      ? besideTryAgain(error)
      : error.trim();
  // An error string is usually "what failed. what to do." — lead with the
  // first sentence as the title and let the rest follow it in the quieter
  // ink, so every caller gets the title-then-explanation shape for free.
  // The second sentence must open like one (a capital, a digit, or a
  // quote), so an abbreviation such as "e.g. timeouts" does not end the
  // title early.
  const split = /^(.*?[.!?])\s+((?=[A-Z0-9"'\u2018\u201C])\S[\s\S]*)$/.exec(
    trimmed,
  );
  const title = split?.[1] ?? '';
  const message = split?.[2] ?? '';
  if (!title || !message) {
    return (
      <Notice
        intent="destructive"
        liveRegionScope="content"
        className={className}
        actions={actions}
        data-testid={testId}
      >
        <span className={textClass}>{trimmed}</span>
      </Notice>
    );
  }
  return (
    <Notice
      intent="destructive"
      liveRegionScope="content"
      title={<span className={textClass}>{title}</span>}
      className={className}
      actions={actions}
      data-testid={testId}
    >
      <span className={textClass}>{message}</span>
    </Notice>
  );
}

/** Room a failed place holds: a page's list, or a side panel's body. */
export type ErrorStateSpace = 'page' | 'panel';

const ERROR_STATE_SPACE_CLASS_NAMES: Record<ErrorStateSpace, string> = {
  page: 'py-16',
  panel: 'py-12',
};

/**
 * A whole place that couldn't load: a page's list or a side panel's body.
 * It takes the place of the content only; the page title, tabs, and toolbar
 * around it stay.
 *
 * The shared {@link EmptyState} with the warning glyph: the glyph alone in
 * the quiet ink with no tile behind it, one sentence that opens with
 * `Couldn't…`, and at most one `Try again` capsule, so a failed place reads
 * like an empty one (`SearchEmptyState`) apart from its glyph. While
 * `retrying`, the capsule spins in place (`Trying again…`) and the state
 * stays on screen, so the place never blanks between tries. A failure
 * retrying cannot fix passes no `onRetry`.
 *
 * Part of a page failing is not this: use one `ErrorBanner` above what did
 * load. A failed action is a toast with a `Try again` action.
 */
export function ErrorState({
  message,
  onRetry,
  retrying = false,
  space = 'page',
  testId,
  retryTestId,
  details,
}: {
  /** One sentence: `Couldn't load workflows.` */
  message: ReactNode;
  /**
   * The raw failure reason (a server's text). Never rendered: it adds a
   * `Copy details` action beside `Try again` that copies it for support.
   */
  details?: string;
  /** Shows `Try again`. Omit when trying again can't fix it. */
  onRetry?: () => void;
  retrying?: boolean;
  space?: ErrorStateSpace;
  testId?: string;
  retryTestId?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      data-error-state={space}
      className={`px-4 ${ERROR_STATE_SPACE_CLASS_NAMES[space]}`}
    >
      <EmptyState
        inset="none"
        spacing="relaxed"
        titleWeight="normal"
        icon={
          <WarningIcon size={24} aria-hidden="true" className="fg-tertiary" />
        }
        title={
          <span role="alert" className="text-pretty">
            {onRetry && typeof message === 'string'
              ? besideTryAgain(message)
              : message}
          </span>
        }
        action={
          onRetry || details ? (
            <div className="flex items-center justify-center gap-2">
              {details ? <CopyDetailsButton details={details} /> : null}
              {onRetry ? (
                <LoadingButton
                  variant="secondary"
                  size="sm"
                  loading={retrying}
                  loadingLabel={TRYING_AGAIN_LABEL}
                  onClick={onRetry}
                  data-testid={retryTestId}
                >
                  {TRY_AGAIN_LABEL}
                </LoadingButton>
              ) : null}
            </div>
          ) : undefined
        }
      />
    </div>
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

/**
 * Empty-state and hero art sizes. They are not icon sizes: only `EmptyState`
 * draws art this large (docs/design/icons.md#sizes).
 */
export type EmptyStateArtSize = 32 | 40;

/**
 * An empty list inside a card, popover or nav list: one quiet line at the
 * row's height, sitting at the host's row inset, with no frame, glyph or
 * heading. A page or panel body that is empty uses {@link EmptyState}.
 */
export function EmptyStateRow({
  title,
  testId,
}: {
  /** One short sentence: `No teams yet`. A node, to block a value from replay. */
  title: ReactNode;
  testId?: string;
}): JSX.Element {
  return (
    <p
      data-testid={testId}
      className="flex min-h-10 items-center py-3 text-s text-pretty fg-tertiary"
    >
      {title}
    </p>
  );
}

export function EmptyState({
  testId,
  icon,
  art: Art,
  artSize = 32,
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
  /**
   * Art drawn above the title at `artSize`, in place of `icon`. Empty-state
   * art is sized here, never at the call site.
   */
  art?: AppIcon;
  /** 32px (default) or 40px for a page-level hero. */
  artSize?: EmptyStateArtSize;
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
      {(icon || Art) && (
        <div
          className={`${spacing === 'relaxed' ? 'mb-3' : 'mb-2'} flex items-center justify-center ${tone === 'quiet' ? 'fg-quaternary' : ''}`}
        >
          {Art ? <Art size={artSize} exactSize aria-hidden /> : icon}
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
