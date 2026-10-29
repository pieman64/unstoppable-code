import * as yaml from 'js-yaml';
import { parseFrontmatterAndBody } from './frontmatter';

export interface ParsedSkillSource {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseSkillSource(raw: string): ParsedSkillSource {
  return parseFrontmatterAndBody(raw);
}

export interface SerializeSkillSourceInput {
  name: string;
  description: string;
  body: string;
  extraMetadata?: Record<string, string>;
}

export function serializeSkillSource(input: SerializeSkillSourceInput): string {
  const frontmatterObj: Record<string, string> = {
    name: input.name,
    description: input.description,
  };
  if (input.extraMetadata) {
    for (const [rawKey, rawValue] of Object.entries(input.extraMetadata)) {
      const key = rawKey.trim();
      if (!key || /\s/.test(key)) continue;
      if (key === 'name' || key === 'description') continue;
      const value = (rawValue ?? '').trim();
      if (!value) continue;
      frontmatterObj[key] = value;
    }
  }
  const frontmatter = yaml.dump(frontmatterObj, { lineWidth: -1 }).trimEnd();
  const body = input.body || '';
  const trailingNewline = body.endsWith('\n') ? '' : '\n';
  return `---\n${frontmatter}\n---\n\n${body}${trailingNewline}`;
}
