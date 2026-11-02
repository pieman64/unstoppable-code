'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type JSX,
  type ReactNode,
} from 'react';

/**
 * Ink and hover surface. `default` rests in the secondary ink with a subtle
 * hover; `strong` rests in the primary ink, for a control that sits beside
 * the composer's primary-ink + (the microphone). `warning` and `destructive`
 * carry an intent; a destructive control
 * rests at 70% and comes to full strength under the pointer. `pending` is a
 * control mid-transition (a microphone starting): the secondary ink with no
 * hover feedback, since the click will interrupt rather than act.
 */
export type ComposerIconButtonTone =
  | 'default'
  | 'strong'
  | 'pending'
  | 'warning'
  | 'destructive';

const REST_TONE_CLASS_NAMES: Record<ComposerIconButtonTone, string> = {
  default:
    'fg-secondary hover:bg-subtle hover:fg-primary disabled:hover:bg-transparent disabled:hover:fg-secondary',
  strong: 'fg-primary hover:bg-subtle disabled:hover:bg-transparent',
  pending: 'fg-secondary',
  warning: 'fg-warning hover:bg-warning-subtle disabled:hover:bg-transparent',
  destructive:
    'fg-destructive/70 hover:bg-destructive-subtle hover:fg-destructive disabled:hover:bg-transparent disabled:hover:fg-destructive/70',
};

/**
 * The pressed state of a tone: the wash stays on and the ink at full
 * strength. The + menu holding an attention item is an active `warning`; the
 * microphone listening is an active `destructive`.
 */
const ACTIVE_TONE_CLASS_NAMES: Record<ComposerIconButtonTone, string> = {
  default: 'bg-subtle fg-primary',
  strong: 'bg-subtle fg-primary',
  pending: 'fg-secondary',
  warning: 'bg-warning-subtle fg-warning hover:bg-warning-subtle',
  destructive:
    'bg-destructive-subtle fg-destructive hover:bg-destructive-subtle/80 disabled:hover:bg-destructive-subtle',
};

interface ComposerIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** Uses the 32px circular geometry from the Home composer toolbar. */
  capsule?: boolean;
  /**
   * Gives room for a primary icon and a trailing disclosure icon, with 2px
   * between them.
   */
  wide?: boolean;
  /**
   * A labeled capsule: intrinsic width above the wide minimum, the 12px label
   * type, and 4px between icon, label, and disclosure.
   */
  autoWidth?: boolean;
  tone?: ComposerIconButtonTone;
  active?: boolean;
}

/** Canonical icon-only action used by composer-adjacent controls. */
export const ComposerIconButton = forwardRef<
  HTMLButtonElement,
  ComposerIconButtonProps
>(function ComposerIconButton(
  {
    children,
    capsule = false,
    wide = false,
    autoWidth = false,
    tone = 'default',
    active = false,
    type = 'button',
    className = '',
    ...props
  },
  ref,
): JSX.Element {
  const toneClassName = active
    ? ACTIVE_TONE_CLASS_NAMES[tone]
    : REST_TONE_CLASS_NAMES[tone];
  const geometryClassName = capsule
    ? `h-8 rounded-full ${
        autoWidth
          ? 'min-w-10 gap-1 px-2 text-xs'
          : wide
            ? 'w-10 gap-0.5'
            : 'w-8'
      }`
    : `h-7 rounded-lg ${wide ? 'w-9 gap-0.5' : 'w-7'}`;

  return (
    <button
      ref={ref}
      type={type}
      data-composer-icon-button="true"
      className={`focus-ring flex items-center justify-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 ${toneClassName} ${geometryClassName} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
});

ComposerIconButton.displayName = 'ComposerIconButton';
