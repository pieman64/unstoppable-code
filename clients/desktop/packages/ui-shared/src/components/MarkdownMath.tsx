import katex from 'katex';
import { memo, type JSX } from 'react';
import 'katex/dist/katex.min.css';
import './markdown-overflow.css';

export interface MarkdownMathProps {
  readonly source: string;
  readonly display: boolean;
}

export const MarkdownMath = memo(function MarkdownMath({
  source,
  display,
}: MarkdownMathProps): JSX.Element {
  try {
    const html = katex.renderToString(source, {
      displayMode: display,
      output: 'htmlAndMathml',
      throwOnError: true,
      trust: false,
      maxExpand: 1_000,
      maxSize: 50,
      strict: 'ignore',
    });
    return (
      <span
        className={
          display
            ? 'canopy-markdown-math canopy-markdown-scroll'
            : 'canopy-markdown-math'
        }
        role={display ? 'group' : undefined}
        aria-label={display ? 'Formula' : undefined}
        tabIndex={display ? 0 : undefined}
        data-math-display={display ? 'true' : 'false'}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  } catch {
    return (
      <code
        className="canopy-markdown-math-error"
        data-math-display={display ? 'true' : 'false'}
      >
        {source}
      </code>
    );
  }
});
