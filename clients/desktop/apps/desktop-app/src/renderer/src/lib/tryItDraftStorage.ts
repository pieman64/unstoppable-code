import { Element, Text } from 'slate';
import type { Descendant } from 'slate';
import { richDraftHasContent } from '@canopy/ui-rich/editor/append-draft-text';

const PREFIX = 'canopy:try-it-draft:v1:';
interface StagedDraft {
  content: Descendant[];
  stagingIds: string[];
}

/** Interface-local composer state; never a canonical chat/transcript write. */
export function readTryItDraft(chatId: string): StagedDraft | null {
  try {
    const raw = localStorage.getItem(PREFIX + chatId);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('content' in value) ||
      !Array.isArray(value.content) ||
      !value.content.every(
        (node: unknown) => Element.isElement(node) || Text.isText(node),
      ) ||
      !('stagingIds' in value) ||
      !Array.isArray(value.stagingIds) ||
      !value.stagingIds.every((id: unknown) => typeof id === 'string')
    )
      return null;
    return { content: value.content, stagingIds: value.stagingIds };
  } catch {
    return null;
  }
}

/** Content and insertion receipts are accepted in a single storage write. */
export function saveTryItDraft(
  chatId: string,
  content: Descendant[],
  stagingId?: string,
): void {
  const prior = readTryItDraft(chatId);
  if (!prior && !stagingId) return;
  localStorage.setItem(
    PREFIX + chatId,
    JSON.stringify({
      content,
      stagingIds: richDraftHasContent(content)
        ? Array.from(
            new Set([
              ...(prior?.stagingIds ?? []),
              ...(stagingId ? [stagingId] : []),
            ]),
          )
        : [],
    }),
  );
}

export function clearTryItDraft(chatId: string): void {
  try {
    localStorage.removeItem(PREFIX + chatId);
  } catch {
    /* Clearing must not block an explicit Send. */
  }
}
