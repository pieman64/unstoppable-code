import type { JSX, ReactNode } from 'react';
import type { AppIcon } from '../icons/AppIcons';
import {
  BADGE_ICON_CLASS,
  badgeClassName,
  dotClassName,
  formatBadgeCount,
  iconCountClassName,
  LABEL_COUNT_CLASS,
  type BadgeTone,
  type CountTone,
  type DotTone,
} from '../lib/badge';

export type { BadgeTone, CountTone, DotTone } from '../lib/badge';

export interface BadgeProps {
  children: ReactNode;
  /** Defaults to `neutral`. Roles, plans and kinds stay neutral. */
  tone?: BadgeTone;
  /** Optional leading glyph, drawn at 12px with a 1.5px stroke. */
  icon?: AppIcon;
  /** Quieter fill and ink for a completed or de-emphasised row. */
  muted?: boolean;
  /** Placement classes appended after the shared geometry and tone. */
  className?: string;
  title?: string;
  'data-testid'?: string;
}

/**
 * A state or label word: one 18px capsule with six tones. Use it for states
 * (Connected, Failed, Merged), roles and plans; leave routine values such as
 * a trigger, a source or a pull request number as plain text.
 */
export function Badge({
  children,
  tone = 'neutral',
  icon: Icon,
  muted = false,
  className,
  title,
  'data-testid': testId,
}: BadgeProps): JSX.Element {
  const base = badgeClassName(tone, { muted });
  return (
    <span
      data-testid={testId}
      data-badge-tone={tone}
      title={title}
      className={className ? `${base} ${className}` : base}
    >
      {Icon ? (
        <Icon
          className={BADGE_ICON_CLASS}
          size={12}
          exactSize
          drawnStrokeWidth={1.5}
          aria-hidden
        />
      ) : null}
      {children}
    </span>
  );
}

export interface CountProps {
  value: number;
  /**
   * `label` (default) sits next to a label as plain tabular text and shows
   * the real number. `icon` sits on an icon as a capsule and caps at 99+.
   */
  placement?: 'label' | 'icon';
  /** Capsule tone for `placement="icon"`: neutral, unread (blue), attention (orange). */
  tone?: CountTone;
  className?: string;
  'aria-hidden'?: boolean;
  'data-testid'?: string;
}

/** A number next to a label or on an icon. */
export function Count({
  value,
  placement = 'label',
  tone = 'neutral',
  className,
  'aria-hidden': ariaHidden,
  'data-testid': testId,
}: CountProps): JSX.Element {
  const base =
    placement === 'icon' ? iconCountClassName(tone) : LABEL_COUNT_CLASS;
  const text =
    placement === 'icon'
      ? formatBadgeCount(value)
      : String(Math.max(0, Math.floor(value)));
  return (
    <span
      data-testid={testId}
      data-count-tone={placement === 'icon' ? tone : undefined}
      aria-hidden={ariaHidden}
      className={className ? `${base} ${className}` : base}
    >
      {text}
    </span>
  );
}

export interface DotProps {
  tone: DotTone;
  /**
   * Accessible name when the dot is the only thing that carries its meaning
   * (an unread group). Without it the dot is decorative and the caller says
   * the meaning in text.
   */
  label?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * A 6px marker: unread (blue), waiting on you (orange) or filter on (grey).
 */
export function Dot({
  tone,
  label,
  className,
  'data-testid': testId,
}: DotProps): JSX.Element {
  const base = dotClassName(tone);
  const cls = className ? `${base} ${className}` : base;
  if (label !== undefined) {
    return (
      <span
        role="img"
        aria-label={label}
        data-testid={testId}
        data-dot-tone={tone}
        className={cls}
      />
    );
  }
  return (
    <span
      aria-hidden
      data-testid={testId}
      data-dot-tone={tone}
      className={cls}
    />
  );
}
