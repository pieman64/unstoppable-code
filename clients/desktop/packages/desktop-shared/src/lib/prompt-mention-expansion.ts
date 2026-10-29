/**
 * Prompt-mention expansion — the send-time half of the Prompts feature.
 *
 * An `@`-mentioned prompt is EXPANDED: its markdown body replaces the pill's
 * display token in the outgoing text and the reference is dropped from the
 * outgoing `fileReferences` list, so prompt refs never reach the wire or the
 * persisted transcript. Notes/attachments pass through untouched (they stay
 * file-reference pills). A missing/unreadable prompt leaves the pill intact so
 * the agent still sees the reference.
 *
 * This module is environment-neutral (browser-safe, no Node imports): the
 * prompt body read is injected. The desktop renderer injects the
 * path-validated `workspacePromptsReadByPath` IPC; desktop main injects a
 * direct filesystem read with the same path validation (portal sends bypass
 * the renderer entirely, so main must expand them itself).
 */

/** Mention `kind` marking a workspace prompt pill. */
export const PROMPT_MENTION_KIND = 'prompt';

/**
 * Structural subset of a serialized file reference the expansion needs. Both
 * the renderer's `SerializedFileReference` (`@canopy/ui-rich`) and the wire
 * Host-side `FileReference` shapes satisfy it.
 */
export interface PromptMentionReference {
  displayPath: string;
  absolutePath: string;
  kind?: string;
  textStart?: number;
}

export interface ExpandedPromptMentions<T extends PromptMentionReference> {
  text: string;
  fileReferences: T[];
}

/** Reads a prompt's markdown body; resolve `null` when unreadable/invalid. */
export type PromptBodyReader = (absolutePath: string) => Promise<string | null>;

export function isPromptMentionReference(
  reference: PromptMentionReference,
): boolean {
  return reference.kind === PROMPT_MENTION_KIND;
}

export async function expandPromptMentionsWithReader<
  T extends PromptMentionReference,
>(
  text: string,
  fileReferences: readonly T[],
  readPromptBody: PromptBodyReader,
): Promise<ExpandedPromptMentions<T>> {
  if (!fileReferences.some(isPromptMentionReference)) {
    return { text, fileReferences: [...fileReferences] };
  }

  const passthrough: T[] = [];
  const replacements: Array<{ start: number; length: number; body: string }> =
    [];
  let legacySearchStart = 0;

  for (const ref of fileReferences) {
    if (!isPromptMentionReference(ref)) {
      passthrough.push(ref);
      continue;
    }
    let body: string | null = null;
    try {
      body = await readPromptBody(ref.absolutePath);
    } catch {
      body = null;
    }
    if (body === null) {
      // Unreadable prompt: keep the pill so the reference is not silently
      // dropped from the outgoing message.
      passthrough.push(ref);
      continue;
    }
    // Prefer the exact Slate pill offset. Older persisted drafts do not carry
    // it, so retain the ordered text-search fallback for compatibility.
    const exactIndex =
      ref.textStart !== undefined &&
      text.slice(ref.textStart, ref.textStart + ref.displayPath.length) ===
        ref.displayPath
        ? ref.textStart
        : -1;
    const index =
      exactIndex >= 0
        ? exactIndex
        : text.indexOf(ref.displayPath, legacySearchStart);
    if (index === -1) {
      passthrough.push(ref);
      continue;
    }
    replacements.push({
      start: index,
      length: ref.displayPath.length,
      body: body.trim(),
    });
    if (exactIndex < 0) {
      legacySearchStart = index + ref.displayPath.length;
    }
  }

  let nextText = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    nextText =
      nextText.slice(0, replacement.start) +
      replacement.body +
      nextText.slice(replacement.start + replacement.length);
  }

  return { text: nextText, fileReferences: passthrough };
}
