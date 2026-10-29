'use client';

import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type JSX,
} from 'react';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { mermaidSourceIssue } from './markdown-mermaid-policy';

export interface MarkdownMermaidProps extends HTMLAttributes<HTMLElement> {
  readonly source: string;
  readonly streaming?: boolean;
}

interface DiagramResult {
  readonly source: string;
  readonly svg?: string;
  readonly error?: string;
}

function getAccessibilityMetadata(svg: string | undefined): {
  title?: string;
  description?: string;
} {
  if (!svg) return {};
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return {};
  const root = parsed.documentElement;
  const directText = (name: 'title' | 'desc'): string | undefined => {
    const value = Array.from(root.children)
      .find((child) => child.localName === name)
      ?.textContent?.trim();
    return value || undefined;
  };
  return { title: directText('title'), description: directText('desc') };
}

function MarkdownMermaidComponent({
  source,
  streaming = false,
  ...props
}: MarkdownMermaidProps): JSX.Element {
  const container = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [themeRevision, setThemeRevision] = useState(0);
  const completed = useRef<{
    source: string;
    themeRevision: number;
    svg: string;
  } | null>(null);
  const [result, setResult] = useState<DiagramResult | null>(null);
  const [showSource, setShowSource] = useState(false);
  const descriptionId = useId();
  const issue = mermaidSourceIssue(source);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: '300px' },
    );
    observer.observe(element);
    return (): void => observer.disconnect();
  }, []);

  useEffect(() => {
    if (streaming || issue) return;
    const observer = new MutationObserver(() =>
      setThemeRevision((value) => value + 1),
    );
    // Root inline styles can carry semantic token overrides. Body inline styles
    // are interaction state (cursor/user-select), not theme state.
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme', 'data-brand'],
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'data-theme', 'data-brand'],
    });
    return (): void => observer.disconnect();
  }, [streaming, issue]);

  useEffect(() => {
    const element = container.current;
    if (!element || streaming || issue) {
      setResult(null);
      return;
    }
    if (!visible) return;
    if (
      completed.current?.source === source &&
      completed.current.themeRevision === themeRevision
    ) {
      setResult(completed.current);
      return;
    }
    let current = true;
    void import('./markdown-mermaid-renderer')
      .then(async ({ renderMermaid }) => {
        if (!current) return;
        const svg = await renderMermaid(source, element, () => current);
        if (current) {
          completed.current = { source, svg, themeRevision };
          setResult({ source, svg });
        }
      })
      .catch(() => {
        if (current)
          setResult({
            source,
            error: 'Diagram could not be rendered. Its source is shown below.',
          });
      });
    return (): void => {
      current = false;
    };
  }, [source, visible, streaming, issue, themeRevision]);

  const currentResult = !streaming && result?.source === source ? result : null;
  const svg = currentResult?.svg;
  const accessibility = useMemo(() => getAccessibilityMetadata(svg), [svg]);
  const error = streaming ? undefined : (issue ?? currentResult?.error);
  return (
    <figure
      {...props}
      ref={container}
      data-testid="markdown-mermaid"
      className="not-prose my-3 min-w-0 text-s fg-primary"
    >
      <div
        className="flex select-none flex-wrap items-center justify-end gap-1"
        data-markdown-generated
      >
        {svg && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showSource}
            onClick={() => setShowSource((value) => !value)}
          >
            {showSource ? 'Show diagram' : 'Show source'}
          </Button>
        )}
        <CopyButton
          value={source}
          ariaLabel="Copy source"
          title="Copy source"
          dataTestId="mermaid-copy-source"
        />
      </div>
      {error && (
        <p
          className="my-2 text-s fg-secondary"
          role="status"
          data-markdown-generated
        >
          {error}
        </p>
      )}
      {svg && !showSource ? (
        <div
          className="max-h-128 overflow-auto"
          tabIndex={0}
          aria-label="Diagram scroll area"
        >
          <div
            role="img"
            aria-label={accessibility.title ?? 'Mermaid diagram'}
            aria-describedby={
              accessibility.description ? descriptionId : undefined
            }
            className="select-none [&_svg]:h-auto [&_svg]:max-w-none"
            data-markdown-generated
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          {accessibility.description && (
            <span
              id={descriptionId}
              className="sr-only"
              data-markdown-generated
            >
              {accessibility.description}
            </span>
          )}
        </div>
      ) : (
        <pre className="my-2 max-h-128 overflow-auto rounded-md bg-secondary p-3 font-mono text-s">
          <code>{source}</code>
        </pre>
      )}
    </figure>
  );
}

export const MarkdownMermaid = memo(MarkdownMermaidComponent);
