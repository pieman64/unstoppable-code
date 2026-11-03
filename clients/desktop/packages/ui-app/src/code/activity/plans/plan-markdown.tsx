import type { JSX } from 'react';
import {
  markdownOptions,
  type MarkdownOverrides,
} from '@canopy/ui-shared/components/Markdown';

/**
 * Markdown for a tracked plan's body. Links render as plain text: a plan
 * preview is not a place to navigate from.
 */
export const PLAN_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  a({ children }): JSX.Element {
    return <span>{children}</span>;
  },
};

/** A plan title on one line: no paragraph box, links as plain text. */
export const INLINE_PLAN_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  p({ children }): JSX.Element {
    return <>{children}</>;
  },
  a({ children }): JSX.Element {
    return <span>{children}</span>;
  },
};

export const PLAN_MARKDOWN_OPTIONS = markdownOptions(PLAN_MARKDOWN_COMPONENTS);
export const INLINE_PLAN_MARKDOWN_OPTIONS = markdownOptions(
  INLINE_PLAN_MARKDOWN_COMPONENTS,
);

/**
 * The plan body without its leading markdown heading, which the card or
 * panel already shows as the title. Plans that open with plain prose keep
 * their first line.
 */
export function stripPlanTitleLine(content: string | undefined): string {
  if (!content) return '';
  const lines = content.split('\n');
  const index = lines.findIndex((line) => line.trim().length > 0);
  if (index < 0) return content;
  if (!/^#{1,6}\s/.test(lines[index].trim())) return content;
  return lines
    .slice(index + 1)
    .join('\n')
    .trimStart();
}
