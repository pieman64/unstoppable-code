import { createHash } from 'node:crypto';
import { load, JSON_SCHEMA } from 'js-yaml';
import type { RepoRuleFlag } from '@canopy/protocol/repo-rules';
import type { ReadRepoRule } from '@canopy/core-runtime/node/workspace/repo-rules';

export type { ReadRepoRule };
export function ruleId(repoId: string, path: string): string {
  return `${repoId}:${path}`;
}
export function ruleScope(path: string): string {
  const at = path.indexOf('.cursor/rules/');
  return at > 0 ? path.slice(0, at) : '';
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function splitGlobs(value: string): string[] {
  let depth = 0;
  let start = 0;
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if ('{[('.includes(value[i] ?? '')) depth++;
    if ('}])'.includes(value[i] ?? '')) depth--;
    if (value[i] === ',' && depth === 0) {
      result.push(value.slice(start, i));
      start = i + 1;
    }
  }
  result.push(value.slice(start));
  return result.map((s) => s.trim()).filter(Boolean);
}
function supportedGlob(value: string): boolean {
  if (
    value.includes('\\') ||
    Array.from(value).some((c) => c.charCodeAt(0) < 32) ||
    value.replace(/^!/, '').startsWith('/') ||
    value.split('/').includes('..') ||
    /\$|[@+?*!]\(/.test(value)
  )
    return false;
  const delimiters: string[] = [];
  for (const character of value) {
    if (character === '{' || character === '[') delimiters.push(character);
    else if (character === '}' || character === ']') {
      if (delimiters.pop() !== (character === '}' ? '{' : '[')) return false;
    }
  }
  return delimiters.length === 0;
}
export function parseRepoRule(
  repoId: string,
  path: string,
  text: string,
  originalBytes: Uint8Array = Buffer.from(text, 'utf8'),
): ReadRepoRule {
  const source = text.replace(/^\ufeff/, '');
  let body = source;
  let description = '';
  let globs: string[] = [];
  let always = false;
  const flags: RepoRuleFlag[] = [];
  if (path !== '.cursorrules' && /^---(?:\r?\n|$)/.test(source)) {
    const header = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(source);
    try {
      if (!header || header.index !== 0) throw new Error('delimiter');
      const metadata: unknown = load(header[1] ?? '', {
        schema: JSON_SCHEMA,
        json: false,
      });
      const emptyHeader = (header[1] ?? '')
        .split(/\r?\n/)
        .every((line) => /^\s*(?:#.*)?$/.test(line));
      if (
        metadata !== undefined &&
        !(metadata === null && emptyHeader) &&
        !record(metadata)
      )
        throw new Error('mapping');
      const fields = record(metadata) ? metadata : {};
      if (
        (fields.alwaysApply !== undefined &&
          typeof fields.alwaysApply !== 'boolean') ||
        (fields.description !== undefined &&
          typeof fields.description !== 'string') ||
        (fields.globs !== undefined &&
          typeof fields.globs !== 'string' &&
          !(
            Array.isArray(fields.globs) &&
            fields.globs.length <= 64 &&
            fields.globs.every((g) => typeof g === 'string')
          ))
      )
        throw new Error('types');
      always = fields.alwaysApply === true;
      description =
        typeof fields.description === 'string' ? fields.description.trim() : '';
      if (typeof fields.globs === 'string') globs = splitGlobs(fields.globs);
      else if (Array.isArray(fields.globs))
        globs = fields.globs
          .filter((g): g is string => typeof g === 'string')
          .map((g) => g.trim())
          .filter(Boolean);
      if (
        description.length > 2048 ||
        globs.length > 64 ||
        globs.some((g) => g.length > 512)
      )
        throw new Error('metadata limit');
      if (
        Object.keys(fields).some(
          (key) => !['alwaysApply', 'description', 'globs'].includes(key),
        )
      )
        flags.push('unsupported-frontmatter');
      if (globs.some((g) => !supportedGlob(g))) flags.push('unsupported-glob');
      body = source.slice(header[0].length);
    } catch {
      flags.push('malformed-frontmatter');
      always = false;
      globs = [];
      description = '';
    }
  }
  return {
    id: ruleId(repoId, path),
    repoId,
    path,
    scope: ruleScope(path),
    kind:
      path === '.cursorrules'
        ? 'legacy-cursorrules'
        : always
          ? 'always'
          : globs.length
            ? 'auto'
            : description
              ? 'agent-requested'
              : 'manual',
    description,
    globs,
    body,
    flags,
    bytes: originalBytes.byteLength,
    hash: createHash('sha256').update(originalBytes).digest('hex'),
    selected: !flags.includes('malformed-frontmatter'),
  };
}
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}
export function isDuplicate(body: string, instructions: string[]): boolean {
  const parts = paragraphs(body);
  if (!parts.length) return false;
  const covered = new Set(instructions.flatMap(paragraphs));
  return parts.filter((p) => covered.has(p)).length / parts.length >= 0.8;
}
