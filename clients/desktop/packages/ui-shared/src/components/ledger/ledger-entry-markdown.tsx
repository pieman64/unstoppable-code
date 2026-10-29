'use client';

import type { ComponentPropsWithoutRef, JSX } from 'react';
import type { MarkdownOptions } from '../markdown-render';
import {
  TRANSCRIPT_MARKDOWN_OPTIONS,
  markdownOptions,
} from '../markdown-render';
import { Markdown } from '../MarkdownClient';
import type { LedgerDensity } from './ledger-entry-slots';

/** Images in entry content stay text; a remote image is never fetched. */
function ImageAltText({ alt }: ComponentPropsWithoutRef<'img'>): JSX.Element {
  return <span className="fg-tertiary">{alt ? alt : 'Image'}</span>;
}

/** Safe options for entry content: raw HTML stays text and images stay local. */
export const LEDGER_ENTRY_MARKDOWN_OPTIONS: MarkdownOptions = markdownOptions(
  { img: ImageAltText },
  TRANSCRIPT_MARKDOWN_OPTIONS,
);

/** Renders an entry's content as safe Markdown at the chosen Ledger density. */
export function LedgerEntryMarkdown({
  content,
  density,
  'data-testid': testId,
}: {
  readonly content: string;
  readonly density: LedgerDensity;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      className={`prose prose-sm dark:prose-invert max-w-none break-words ${density === 'page' ? 'text-s' : 'text-xs'} leading-5`}
    >
      <Markdown options={LEDGER_ENTRY_MARKDOWN_OPTIONS}>{content}</Markdown>
    </div>
  );
}
