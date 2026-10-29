import type {
  PersistedChatBlock,
  PersistedChatMessage,
  PersistedToolOutputReference,
  PersistedVisualReference,
} from '../types';

export const VISUAL_HTML_MAX_BYTES = 512_000;
export const VISUAL_PREPARED_MAX_BYTES = 4 * 1024 * 1024;
export const VISUAL_MIN_HEIGHT = 80;
export const VISUAL_MAX_HEIGHT = 2000;
export const VISUAL_TITLE_MAX_LENGTH = 120;
/** Most measured `[width, height]` pairs a visual reference may carry. */
export const VISUAL_HEIGHTS_MAX_ENTRIES = 32;

const VISUAL_ID_LENGTH = 40;
const VISUAL_ID_PATTERN =
  /^vis_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isVisualId(value: string): boolean {
  return value.length === VISUAL_ID_LENGTH && VISUAL_ID_PATTERN.test(value);
}

/**
 * Every complete visual id in `output`, in first-seen order without repeats.
 *
 * Nothing is required before a token: JSON-stringified tool output puts an
 * escape letter there (`\\nvis_...`). A token directly followed by another hex
 * digit is an over-long run, not an id.
 */
export function findVisualTokens(output: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const tokenPattern =
    /vis_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(output)) !== null) {
    const token = match[0];
    const nextCodeUnit = output.charCodeAt(match.index + token.length);
    const nextIsHex =
      (nextCodeUnit >= 0x30 && nextCodeUnit <= 0x39) ||
      (nextCodeUnit >= 0x61 && nextCodeUnit <= 0x66);
    if (!nextIsHex && !seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }

  return tokens;
}

/**
 * Measured `[width, height]` hints a visual reference may carry: at most
 * {@link VISUAL_HEIGHTS_MAX_ENTRIES} pairs of finite, positive numbers. Staging
 * rejects anything else, so a caller checks before it stages.
 */
export function isValidVisualHeights(
  value: unknown,
): value is ReadonlyArray<readonly [number, number]> {
  if (!Array.isArray(value) || value.length > VISUAL_HEIGHTS_MAX_ENTRIES)
    return false;
  const pairs: readonly unknown[] = value;
  return pairs.every((pair: unknown): boolean => {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    const tuple: readonly unknown[] = pair;
    return tuple.every(
      (item: unknown): boolean =>
        typeof item === 'number' && Number.isFinite(item) && item > 0,
    );
  });
}

export function clampVisualHeight(value: number): number {
  if (!Number.isFinite(value)) {
    return VISUAL_MAX_HEIGHT;
  }
  return Math.min(
    Math.max(Math.round(value), VISUAL_MIN_HEIGHT),
    VISUAL_MAX_HEIGHT,
  );
}

export type PersistedArtifactReference =
  | { family: 'tool-output'; reference: PersistedToolOutputReference }
  | { family: 'visual'; reference: PersistedVisualReference };

/** Artifact references a block carries, tool output first. */
export function artifactRefsOf(
  block: PersistedChatBlock,
): PersistedArtifactReference[] {
  if (block.type !== 'tool_result') {
    return [];
  }

  const references: PersistedArtifactReference[] = [];
  if (block.fullOutputRef) {
    references.push({ family: 'tool-output', reference: block.fullOutputRef });
  }
  if (block.visualRef) {
    references.push({ family: 'visual', reference: block.visualRef });
  }
  return references;
}

export function messageHasVisual(message: PersistedChatMessage): boolean {
  return message.blocks.some(
    (block) => block.type === 'tool_result' && block.visualRef !== undefined,
  );
}
