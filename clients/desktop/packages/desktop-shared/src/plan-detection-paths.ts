import type { PersistedChatBlock } from './types';

const TOOL_PATH_KEYS = [
  'file_path',
  'filePath',
  'path',
  'notebook_path',
  'notebookPath',
] as const;

/** Token must contain a "/" and end in a filename (optionally extensioned). */
const PATH_TOKEN = /[\w./-]*\/[\w.-]+\.[\w]+|[\w./-]*\/[\w.-]+/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanToken(raw: string): string {
  return raw
    .replace(/^[`('"\[]+/, '')
    .replace(/[`)'"\].,;:]+$/, '')
    .trim();
}

/**
 * Extract candidate file path strings from a chat turn's blocks. Pure; the
 * caller matches these against plan-detection rules. Conservative on free text
 * (requires a "/" and a filename tail) — the rule match is the real filter.
 */
export function extractCandidatePaths(blocks: PersistedChatBlock[]): string[] {
  const out = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.input);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) {
        continue;
      }
      for (const key of TOOL_PATH_KEYS) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) {
          out.add(value.trim());
        }
      }
    } else if (block.type === 'file_references') {
      for (const ref of block.references) {
        if (ref.absolutePath.trim()) {
          out.add(ref.absolutePath.trim());
        }
      }
    } else if (block.type === 'text') {
      const matches = block.text.match(PATH_TOKEN);
      if (matches) {
        for (const match of matches) {
          const token = cleanToken(match);
          if (
            token.includes('/') &&
            /[\w.-]+$/.test(token) &&
            /[A-Za-z]/.test(token)
          ) {
            out.add(token);
          }
        }
      }
    }
  }
  return Array.from(out);
}
