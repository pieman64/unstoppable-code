'use client';

import type { ComponentPropsWithoutRef, JSX } from 'react';
import { Markdown } from './MarkdownClient';
import {
  markdownOptions,
  withSoftLineBreaks,
  type MarkdownOptions,
  type MarkdownOverrides,
} from './markdown-render';

export type DescriptionMarkdownSize = 'sm' | 'base';
export type DescriptionMarkdownTone = 'secondary' | 'primary';

export interface DescriptionMarkdownProps {
  /** The author-written description, rendered as sanitized Markdown. */
  readonly children: string;
  /** Placement classes only; the component owns typography. */
  readonly className?: string;
  readonly size?: DescriptionMarkdownSize;
  /** `secondary` under a page title; `primary` as a read-only field value. */
  readonly tone?: DescriptionMarkdownTone;
  readonly dataTestId?: string;
}

const DESCRIPTION_PROSE_BASE_CLASS =
  'prose [--tw-prose-bullets:var(--fg-tertiary)] [--tw-prose-counters:var(--fg-tertiary)] dark:prose-invert max-w-prose break-words prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-pre:my-1.5 prose-pre:overflow-x-auto prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:fg-primary prose-code:before:content-none prose-code:after:content-none prose-blockquote:my-1 prose-a:fg-accent prose-strong:fg-primary [&>:first-child]:mt-0 [&>:last-child]:mb-0';

const DESCRIPTION_PROSE_TONE_CLASS: Record<DescriptionMarkdownTone, string> = {
  secondary: '[--tw-prose-body:var(--fg-secondary)] fg-secondary',
  primary: '[--tw-prose-body:var(--fg-primary)] fg-primary',
};

const DESCRIPTION_PROSE_SIZE_CLASS: Record<DescriptionMarkdownSize, string> = {
  sm: 'prose-sm text-s',
  base: 'prose-base text-m',
};

/**
 * An author's `# Title` must never compete with the page `<h1>`, so every
 * heading level renders as a bold paragraph-size line.
 */
function DescriptionHeading({
  children,
}: ComponentPropsWithoutRef<'h1'>): JSX.Element {
  return (
    <p data-description-heading="" className="font-semibold fg-primary">
      {children}
    </p>
  );
}

/**
 * Images render as their alt text: public share pages must not load remote
 * tracking pixels or let an oversized image blow out the layout.
 */
function DescriptionImage({
  alt,
}: ComponentPropsWithoutRef<'img'>): JSX.Element {
  return <>{alt ?? ''}</>;
}

/**
 * Author links render on indexable public pages, so they are marked as
 * user-generated and pass no link equity (matching the profile header's
 * user links). `markdownOptions` still wraps this in the shared URL sanitizer.
 */
const DESCRIPTION_LINK_REL = 'nofollow ugc noopener noreferrer';

const DESCRIPTION_OVERRIDES: MarkdownOverrides = {
  a: { component: 'a', props: { rel: DESCRIPTION_LINK_REL } },
  h1: DescriptionHeading,
  h2: DescriptionHeading,
  h3: DescriptionHeading,
  h4: DescriptionHeading,
  h5: DescriptionHeading,
  h6: DescriptionHeading,
  img: DescriptionImage,
};

const DESCRIPTION_MARKDOWN_OPTIONS: MarkdownOptions = withSoftLineBreaks(
  markdownOptions(DESCRIPTION_OVERRIDES),
);

/**
 * Renders a share or collection description as sanitized Markdown.
 *
 * Built on the shared {@link Markdown} defaults (raw HTML stays text, unsafe
 * URLs are dropped, anchors open safely), with typed newlines honored as line
 * breaks. Math and Mermaid fences are deliberately supported, matching the
 * skill bodies rendered on the same pages: both load lazily, are capped per
 * document, and fetch nothing remote (unlike images, which render as alt
 * text). Options are built here rather than accepted as props so a Server
 * Component can mount it with string-only props.
 */
export function DescriptionMarkdown({
  children,
  className,
  size = 'sm',
  tone = 'secondary',
  dataTestId,
}: DescriptionMarkdownProps): JSX.Element {
  const classes = [
    DESCRIPTION_PROSE_BASE_CLASS,
    DESCRIPTION_PROSE_SIZE_CLASS[size],
    DESCRIPTION_PROSE_TONE_CLASS[tone],
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} data-testid={dataTestId}>
      <Markdown options={DESCRIPTION_MARKDOWN_OPTIONS}>{children}</Markdown>
    </div>
  );
}
