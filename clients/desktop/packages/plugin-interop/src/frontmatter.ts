import * as yaml from 'js-yaml';
import { isRecord } from './file-map';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function parseFrontmatter(
  content: string,
): Record<string, unknown> | null {
  const match = content.match(FRONTMATTER_RE);
  const source = match?.[1];
  if (source === undefined) return null;
  try {
    const parsed: unknown = yaml.load(source);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseFrontmatterAndBody(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  const source = match?.[1];
  if (source === undefined || match === null) {
    return { frontmatter: {}, body: raw };
  }
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed: unknown = yaml.load(source);
    if (isRecord(parsed)) frontmatter = parsed;
  } catch {
    // Preserve the existing body-stripping behavior for malformed metadata.
  }
  return {
    frontmatter,
    body: raw.slice(match[0].length).replace(/^\r?\n/, ''),
  };
}

export function serializeMarkdownWithFrontmatter(
  frontmatter: Readonly<Record<string, unknown>>,
  body: string,
): string {
  const frontmatterText = yaml.dump(frontmatter, {
    lineWidth: -1,
    noRefs: true,
  });
  return `---\n${frontmatterText}---\n${body}`;
}
