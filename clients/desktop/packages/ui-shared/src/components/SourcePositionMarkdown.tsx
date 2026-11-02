import {
  Children,
  cloneElement,
  isValidElement,
  type JSX,
  type ReactElement,
  type ReactNode,
} from 'react';
import { compiler } from 'markdown-to-jsx';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { DeferredMarkdownMath } from './DeferredMarkdownMath';
import {
  prepareMarkdownRender,
  MarkdownTableBlock,
  type MarkdownOptions,
} from './Markdown';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';
import { MarkdownMermaid } from './MarkdownMermaid';
import { useSingleDollarMathEnabled } from './use-single-dollar-math';

export interface SourcePositionMarkdownProps {
  readonly children: string;
  readonly options?: MarkdownOptions;
}

interface SourcePosition {
  readonly startOffset: number;
  readonly endOffset: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly element: string;
}

function isAnnotatableElement(
  child: ReactNode,
): child is ReactElement<Record<string, unknown>> {
  return isValidElement<Record<string, unknown>>(child);
}

function renderedElementMatchesPosition(
  child: ReactElement<Record<string, unknown>>,
  position: SourcePosition,
): boolean {
  return (
    child.type === position.element ||
    (position.element === 'table' && child.type === MarkdownTableBlock) ||
    (position.element === 'pre' &&
      (child.type === MarkdownCodeBlock ||
        child.type === DeferredMarkdownMath ||
        child.type === MarkdownMermaid))
  );
}

function sourcePositions(markdown: string): SourcePosition[] {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

  return tree.children.flatMap((node) => {
    // Definitions are collected by both parsers but do not produce a root DOM
    // element. Footnote definitions are rendered together in a generated
    // footer, so they also cannot map one-to-one to a root element.
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      return [];
    }
    const element =
      node.type === 'heading'
        ? `h${node.depth}`
        : node.type === 'list'
          ? node.ordered
            ? 'ol'
            : 'ul'
          : node.type === 'blockquote'
            ? 'blockquote'
            : node.type === 'code'
              ? 'pre'
              : node.type === 'paragraph'
                ? 'p'
                : node.type === 'table'
                  ? 'table'
                  : node.type === 'thematicBreak'
                    ? 'hr'
                    : null;
    if (!element) return [];

    const startOffset = node.position?.start.offset;
    const endOffset = node.position?.end.offset;
    const startLine = node.position?.start.line;
    const endLine = node.position?.end.line;
    return typeof startOffset === 'number' &&
      typeof endOffset === 'number' &&
      typeof startLine === 'number' &&
      typeof endLine === 'number'
      ? [{ startOffset, endOffset, startLine, endLine, element }]
      : [];
  });
}

/**
 * Markdown renderer for plan-review surfaces that maps each root block back to
 * its exact source range. The review UI uses these attributes to preserve raw
 * formatting when a rendered selection becomes an anchored comment.
 */
export function SourcePositionMarkdown({
  children,
  options,
}: SourcePositionMarkdownProps): JSX.Element {
  // Subscribes so a change to the `$...$` setting re-renders the plan.
  useSingleDollarMathEnabled();
  const positions = sourcePositions(children);
  const prepared = prepareMarkdownRender(children, options);
  const rendered = compiler(prepared.markdown, {
    ...prepared.options,
    wrapper: null,
  });
  const renderedChildren = Children.toArray(rendered);

  // The source parser and renderer intentionally remain independent. If their
  // root structures diverge, fail closed instead of attaching the wrong source
  // range to a rendered block.
  if (
    renderedChildren.length !== positions.length ||
    !renderedChildren.every(isAnnotatableElement) ||
    renderedChildren.some(
      (child, index) =>
        !renderedElementMatchesPosition(child, positions[index]),
    )
  ) {
    return <>{rendered}</>;
  }

  const annotated = renderedChildren.map((child, index): ReactNode => {
    const position = positions[index];
    return cloneElement(child, {
      'data-sourcepos': `${position.startLine}:${position.endLine}`,
      'data-md-start': position.startOffset,
      'data-md-end': position.endOffset,
    });
  });

  return <>{annotated}</>;
}
