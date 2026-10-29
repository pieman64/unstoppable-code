import type {
  RepoFileIndex,
  WorkspaceAttachmentItem,
  WorkspaceNoteItem,
  WorkspacePromptItem,
} from '@canopy/desktop-shared/types';
import type { FileMentionOption } from '@canopy/ui-rich/types';
import { PROMPT_MENTION_KIND } from '@canopy/desktop-shared/lib/prompt-mention-expansion';
import { searchFiles } from './fuzzySearch';

/**
 * Mention kinds the desktop host tags onto workspace-item pills (carried
 * opaquely through `@canopy/ui-rich` as `FileMentionOption.kind` →
 * `SerializedFileReference.kind`). Prompt mentions are EXPANDED into the
 * outgoing text at send time (`lib/promptMentionExpansion.ts`); note and
 * attachment mentions stay file-reference pills. The prompt kind is owned by
 * the shared expansion module so desktop main (portal sends) and the renderer
 * agree on one value; it is re-exported here for existing importers.
 */
export const NOTE_MENTION_KIND = 'note';
export { PROMPT_MENTION_KIND };
export const ATTACHMENT_MENTION_KIND = 'attachment';

export interface FileReferenceDisplayPathInput {
  relativePath: string;
  absolutePath: string;
  filename?: string;
  repoName?: string;
  rootKind?: RepoFileIndex['rootKind'];
  isAttachment?: boolean;
  kind?: string;
}

/**
 * Match the file-reference display path used by the composer `@` picker.
 * Single-repo files use repo-relative paths; multi-repo files include the repo
 * label when needed so same relative paths in sibling repos stay distinct.
 * Workspace items: notes/attachments use their absolute path (they live
 * outside the checkout, so the pill must carry a path agents can open);
 * prompts use a `Prompt: {title}` label (the body replaces the pill at send).
 */
export function buildFileReferenceDisplayPath(
  file: FileReferenceDisplayPathInput,
  repoCount: number,
): string {
  if (file.kind === PROMPT_MENTION_KIND) {
    return `Prompt: ${file.filename ?? file.relativePath}`;
  }
  if (
    file.kind === NOTE_MENTION_KIND ||
    file.kind === ATTACHMENT_MENTION_KIND ||
    file.isAttachment ||
    file.rootKind === 'attachments'
  ) {
    return file.absolutePath;
  }
  if (
    file.repoName &&
    repoCount > 1 &&
    !file.relativePath.startsWith(`${file.repoName}/`)
  ) {
    return `${file.repoName}/${file.relativePath}`;
  }
  return file.relativePath;
}

/** Candidate set for {@link searchWorkspaceItemMentions}. */
export interface WorkspaceItemMentionSources {
  notes: readonly WorkspaceNoteItem[];
  prompts: readonly WorkspacePromptItem[];
  attachments: readonly WorkspaceAttachmentItem[];
}

/**
 * Stable empty fallbacks for workspace-item mention selectors. Zustand
 * selectors under `useShallow` must return these instead of fresh `[]`
 * literals — an unstable array reference makes the `useSyncExternalStore`
 * snapshot churn forever and trips React's maximum-update-depth guard.
 */
export const EMPTY_NOTE_ITEMS: readonly WorkspaceNoteItem[] = [];
export const EMPTY_PROMPT_ITEMS: readonly WorkspacePromptItem[] = [];
export const EMPTY_ATTACHMENT_ITEMS: readonly WorkspaceAttachmentItem[] = [];

function fuzzyIncludes(query: string, haystack: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const target = haystack.toLowerCase();
  return tokens.every((token) => target.includes(token));
}

/**
 * Workspace-item candidates for the `@` typeahead, grouped as pseudo-repos
 * (`Notes` / `Prompts` / `Attachments`). Concatenated after the repo file
 * hits by the desktop `useFileTypeahead` wrapper and the Home composer.
 */
export function searchWorkspaceItemMentions(
  query: string,
  sources: WorkspaceItemMentionSources,
  limitPerGroup = 5,
): FileMentionOption[] {
  const options: FileMentionOption[] = [];

  for (const note of sources.notes) {
    if (!fuzzyIncludes(query, note.title)) continue;
    options.push({
      repoId: 'canopy:notes',
      repoName: 'Notes',
      relativePath: note.id,
      filename: note.title,
      absolutePath: note.absolutePath,
      kind: NOTE_MENTION_KIND,
    });
    if (options.length >= limitPerGroup) break;
  }

  const promptStart = options.length;
  for (const prompt of sources.prompts) {
    if (!fuzzyIncludes(query, prompt.title)) continue;
    options.push({
      repoId: 'canopy:prompts',
      repoName: 'Prompts',
      relativePath: prompt.id,
      filename: prompt.title,
      absolutePath: prompt.absolutePath,
      kind: PROMPT_MENTION_KIND,
    });
    if (options.length - promptStart >= limitPerGroup) break;
  }

  const attachmentStart = options.length;
  for (const attachment of sources.attachments) {
    if (!fuzzyIncludes(query, attachment.filename)) continue;
    options.push({
      repoId: 'canopy:attachments',
      repoName: 'Attachments',
      relativePath: attachment.filename,
      filename: attachment.filename,
      absolutePath: attachment.absolutePath,
      isAttachment: true,
      kind: ATTACHMENT_MENTION_KIND,
    });
    if (options.length - attachmentStart >= limitPerGroup) break;
  }

  return options;
}

/**
 * Fuzzy-search the worktree's repo file index and map the hits into the shared
 * {@link FileMentionOption} contract consumed by `@canopy/ui-rich`'s
 * `@`-mention typeahead. Shared by the desktop `useFileTypeahead` hook and the
 * shared-ChatPanel preview bridge so both surfaces search identically.
 */
export function searchFileMentions(
  query: string,
  repos: RepoFileIndex[],
  limit = 50,
): FileMentionOption[] {
  return searchFiles(query, repos, limit).map<FileMentionOption>((file) => ({
    repoId: file.repoId,
    repoName: file.repoName,
    relativePath: file.relativePath,
    filename: file.filename,
    absolutePath: file.absolutePath,
    matchedIndices: file.matchedIndices,
    ...(file.rootKind === 'attachments' ? { isAttachment: true } : {}),
  }));
}
