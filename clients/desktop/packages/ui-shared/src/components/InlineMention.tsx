import type {
  ComponentType,
  HTMLAttributes,
  JSX,
  MouseEventHandler,
  ReactNode,
} from 'react';

/** A Central-catalog icon, or any glyph that takes a `className`. */
export type InlineMentionIcon = ComponentType<{ className?: string }>;

export interface InlineMentionProps extends Omit<
  HTMLAttributes<HTMLElement>,
  'className' | 'children' | 'onClick'
> {
  /** The glyph before the label; the pill sizes it to the surrounding text. */
  icon: InlineMentionIcon;
  children: ReactNode;
  /**
   * Makes the pill a button that opens what it mentions, with the hover and
   * focus treatment. Without it the pill is a plain, non-interactive span.
   */
  onClick?: MouseEventHandler<HTMLButtonElement>;
}

// The glyph geometry is written in em on purpose: a mention pill sits inside
// running text at whatever size that text has (a bubble, a heading, a code
// span), so its icon, its gap, and its baseline nudge follow the font rather
// than the spacing scale. eslint.design.mjs allows these values in this file
// alone; every mention renders through this component.
const SHELL_CLASS =
  '-mx-0.5 inline-flex items-center gap-[0.125em] rounded-sm px-0.5 align-[-0.08em] fg-accent';
const INTERACTIVE_CLASS =
  'focus-ring cursor-pointer transition hover:bg-accent-subtle hover:underline';
const GLYPH_SLOT_CLASS =
  'inline-flex h-[1em] w-[1em] shrink-0 items-center justify-center';
const GLYPH_CLASS = 'h-[0.9em] w-[0.9em] shrink-0';

/**
 * The inline pill for an `@` mention inside a message: a file path, a plugin,
 * or any other target with an icon and a label. The desktop's
 * `FilePathMention` and `PluginMention` render through it so the two pills
 * cannot drift apart.
 */
export function InlineMention({
  icon: Icon,
  children,
  onClick,
  ...rest
}: InlineMentionProps): JSX.Element {
  const content = (
    <>
      <span className={GLYPH_SLOT_CLASS}>
        <Icon className={GLYPH_CLASS} />
      </span>
      <span>{children}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={`${SHELL_CLASS} ${INTERACTIVE_CLASS}`}
        onClick={onClick}
        {...rest}
      >
        {content}
      </button>
    );
  }
  return (
    <span className={SHELL_CLASS} {...rest}>
      {content}
    </span>
  );
}
