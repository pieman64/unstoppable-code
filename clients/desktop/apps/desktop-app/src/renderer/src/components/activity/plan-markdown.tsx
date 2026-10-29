import type { JSX } from 'react';
import {
  markdownOptions,
  type MarkdownOverrides,
} from '@canopy/ui-shared/components';

export const PLAN_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  a({ children }): JSX.Element {
    return <span>{children}</span>;
  },
};

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

export function stripPlanTitleLine(content: string): string {
  const lines = content.split('\n');
  const index = lines.findIndex((line) => line.trim().length > 0);
  if (index < 0) return content;
  if (!/^#{1,6}\s/.test(lines[index].trim())) return content;
  return lines
    .slice(index + 1)
    .join('\n')
    .trimStart();
}
