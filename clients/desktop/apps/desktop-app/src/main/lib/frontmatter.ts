import * as yaml from 'js-yaml';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

function isFrontmatterRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns `null` if no frontmatter block is found or parsing fails.
 */
export function parseFrontmatter<T = Record<string, unknown>>(
  content: string,
): T | null {
  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;
  try {
    return yaml.load(match[1]) as T;
  } catch {
    return null;
  }
}

/**
 * Split a markdown string into its frontmatter and body parts.
 */
export function parseFrontmatterAndBody(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  let frontmatter: Record<string, unknown> = {};
  let body = raw;

  if (match) {
    try {
      const parsed = yaml.load(match[1]);
      frontmatter = isFrontmatterRecord(parsed) ? parsed : {};
    } catch {
      // Keep the body-stripping behavior, but ignore malformed metadata.
    }
    body = raw.slice(match[0].length).replace(/^\r?\n/, '');
  }

  return { frontmatter, body };
}
