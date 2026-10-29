import { type JSX } from 'react';

function formatFrontmatterKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatFrontmatterValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value.toString();
  return '';
}

export function visibleFrontmatterEntries(
  frontmatter: Record<string, unknown>,
): [string, unknown][] {
  return Object.entries(frontmatter).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );
}

export interface FrontmatterBlockProps {
  /** Parsed YAML frontmatter. Empty/null/undefined values are dropped. */
  readonly frontmatter: Record<string, unknown>;
  /** Extra classes appended to the outer card (e.g. spacing). */
  readonly className?: string;
}

/**
 * Renders frontmatter as a bordered `<dl>` of `Key: value` pairs. Returns an
 * empty fragment when there is nothing worth showing, so callers can render it
 * unconditionally. Ported from the desktop `components/shared` original —
 * class names and formatting match it exactly so tests/selectors and visual
 * diffs are unchanged. Shared by the skills/plugins detail views (via
 * {@link import('./MarkdownFrontmatterContent').MarkdownFrontmatterContent})
 * and the file viewer's markdown preview.
 */
export function FrontmatterBlock({
  frontmatter,
  className,
}: FrontmatterBlockProps): JSX.Element {
  const entries = visibleFrontmatterEntries(frontmatter);
  if (entries.length === 0) return <></>;

  return (
    <div
      className={`rounded-lg border bg-secondary/30 px-4 py-3${
        className ? ` ${className}` : ''
      }`}
    >
      <dl className="space-y-1.5 text-s">
        {entries.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="font-medium fg-primary whitespace-nowrap">
              {formatFrontmatterKey(key)}:
            </dt>
            <dd className="fg-secondary break-words min-w-0">
              {formatFrontmatterValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
