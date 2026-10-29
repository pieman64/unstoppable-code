import { parseFrontmatterAndBody } from '../../../lib/frontmatter';

export interface RoutedMemoryContent {
  scope: 'user' | 'workspace';
  modified: string;
  content: string;
}

function frontmatterModified(value: unknown, fallback: Date): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return fallback.toISOString();
}

export function routeClaudeMemoryContent(
  raw: string,
  fileMtime: Date,
): RoutedMemoryContent {
  const parsed = parseFrontmatterAndBody(raw);
  return {
    scope: parsed.frontmatter.type === 'user' ? 'user' : 'workspace',
    modified: frontmatterModified(parsed.frontmatter.modified, fileMtime),
    content: parsed.body,
  };
}

export function routeCodexMemoryContent(
  raw: string,
  fileMtime: Date,
): RoutedMemoryContent {
  return {
    scope: 'user',
    modified: fileMtime.toISOString(),
    content: raw,
  };
}
