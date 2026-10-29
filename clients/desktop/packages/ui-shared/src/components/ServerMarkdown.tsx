import type { JSX } from 'react';
import { compiler } from 'markdown-to-jsx';
import { prepareMarkdownRender, type MarkdownProps } from './markdown-render';

/** Render function-valued options on the server without crossing a client boundary. */
export function ServerMarkdown({
  children,
  options,
  streaming,
}: MarkdownProps): JSX.Element {
  const prepared = prepareMarkdownRender(children, options, streaming);
  return <>{compiler(prepared.markdown, prepared.options)}</>;
}
