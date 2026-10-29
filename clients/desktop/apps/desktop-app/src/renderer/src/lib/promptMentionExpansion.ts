/**
 * Prompt-mention expansion — the send-time half of the Prompts feature.
 *
 * An `@`-mentioned prompt is EXPANDED: its markdown body replaces the pill's
 * display token in the outgoing text and the reference is dropped from the
 * outgoing `fileReferences` list, so prompt refs never reach the wire or the
 * persisted transcript. Notes/attachments pass through untouched (they stay
 * file-reference pills). One implementation covers every renderer send path:
 * ChatInput's normal / edit-save / scheduled branches and the Home
 * composer's `homeSend` (cowork sends flow through ChatInput). Portal sends
 * never reach the renderer; desktop main runs the same shared core in
 * `handlePortalChatSend` (see `main/lib/workspace-prompt-mentions.ts`).
 *
 * The expansion algorithm lives in
 * `@canopy/desktop-shared/lib/prompt-mention-expansion`; this wrapper injects
 * the renderer's prompt body reader — the path-validated
 * `workspacePromptsReadByPath` IPC (must resolve inside the workspace's
 * prompts dir). A missing/unreadable prompt leaves the pill intact so the
 * agent still sees the reference.
 */
import type { SerializedFileReference } from '@canopy/ui-rich/types';
import {
  expandPromptMentionsWithReader,
  isPromptMentionReference,
} from '@canopy/desktop-shared/lib/prompt-mention-expansion';

export interface ExpandedPromptMentions {
  text: string;
  fileReferences: SerializedFileReference[];
}

export function mergePromptAwareFileReferences<
  T extends SerializedFileReference,
>(editorFileReferences: readonly T[], extraFileReferences: readonly T[]): T[] {
  const mergedNonPrompt = new Map<string, T>();
  const promptReferences: T[] = [];

  for (const reference of extraFileReferences) {
    if (isPromptMentionReference(reference)) {
      promptReferences.push(reference);
    } else {
      mergedNonPrompt.set(reference.absolutePath, reference);
    }
  }

  for (const reference of editorFileReferences) {
    if (isPromptMentionReference(reference)) {
      // Each prompt pill represents one replacement occurrence, even when
      // multiple pills point at the same prompt file.
      promptReferences.push(reference);
    } else {
      mergedNonPrompt.set(reference.absolutePath, reference);
    }
  }

  const mergedReferences: T[] = Array.from(mergedNonPrompt.values());
  mergedReferences.push(...promptReferences);
  return mergedReferences;
}

export async function expandPromptMentions(
  projectId: string,
  text: string,
  fileReferences: readonly SerializedFileReference[],
): Promise<ExpandedPromptMentions> {
  return expandPromptMentionsWithReader(
    text,
    fileReferences,
    async (absolutePath) => {
      const response = await window.api.workspaceItems.readPromptByPath({
        projectId,
        absolutePath,
      });
      return response.content;
    },
  );
}
