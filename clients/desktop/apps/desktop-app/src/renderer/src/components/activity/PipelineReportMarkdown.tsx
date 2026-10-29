import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  Markdown,
  markdownOptions,
  type MarkdownOverrides,
} from '@canopy/ui-shared/components';

const REPORT_COMPONENTS: MarkdownOverrides = {
  a({ children }): JSX.Element {
    return <span>{children}</span>;
  },
};
const REPORT_MARKDOWN_OPTIONS = markdownOptions(REPORT_COMPONENTS);

/**
 * Renders pipeline report markdown with GFM support and the shared prose
 * styling used across the report modal and the inline Summary report view.
 */
export function PipelineReportMarkdown({
  content,
}: {
  content: string;
}): JSX.Element {
  return (
    <div
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-p:my-0.5 prose-pre:my-1.5 prose-pre:overflow-x-auto prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:fg-success prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary/80 prose-a:fg-accent prose-strong:fg-primary/80 prose-li:my-0.5`}
    >
      <Markdown options={REPORT_MARKDOWN_OPTIONS}>{content}</Markdown>
    </div>
  );
}
