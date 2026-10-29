import type { JSX } from 'react';
import {
  Markdown,
  markdownOptions,
  type MarkdownOverrides,
} from '@canopy/ui-shared/components';

const ADVISOR_MARKDOWN_COMPONENTS: MarkdownOverrides = {
  p({ children }): JSX.Element {
    return <>{children}</>;
  },
  a({ children, href }): JSX.Element {
    const isSafe = typeof href === 'string' && /^(https?:|mailto:)/.test(href);
    if (!isSafe) {
      return <span>{children}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="fg-accent underline decoration-accent/40 underline-offset-2"
      >
        {children}
      </a>
    );
  },
  code({ children, className }): JSX.Element {
    if (className) {
      return (
        <code className={`${className} whitespace-pre-wrap`}>{children}</code>
      );
    }
    return (
      <code className="rounded bg-fg-primary/[0.08] px-1 py-0.5 font-mono text-xs fg-info">
        {children}
      </code>
    );
  },
  pre({ children }): JSX.Element {
    return (
      <span className="my-1 block overflow-x-auto rounded bg-fg-primary/[0.06] p-2 font-mono text-xs fg-primary/85">
        {children}
      </span>
    );
  },
  ul({ children }): JSX.Element {
    return <span className="mt-1 block space-y-0.5">{children}</span>;
  },
  ol({ children }): JSX.Element {
    return <span className="mt-1 block space-y-0.5">{children}</span>;
  },
  li({ children }): JSX.Element {
    return <span className="block">{children}</span>;
  },
};
const ADVISOR_MARKDOWN_OPTIONS = markdownOptions(ADVISOR_MARKDOWN_COMPONENTS);

export function PipelineAdvisorMarkdownText({
  children,
  className,
}: {
  children: string;
  className?: string;
}): JSX.Element {
  return (
    <span className={className}>
      <Markdown options={ADVISOR_MARKDOWN_OPTIONS}>{children}</Markdown>
    </span>
  );
}
