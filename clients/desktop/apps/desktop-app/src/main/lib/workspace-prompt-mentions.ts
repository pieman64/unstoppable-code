/**
 * Main-process half of prompt-mention handling.
 *
 * Owns the path-validated workspace prompt read (shared by the renderer's
 * `workspacePromptsReadByPath` IPC and the portal send path) and the portal
 * send-time expansion: portal `portal.chat.send` commands enter main directly
 * via `handlePortalChatSend` and never pass through the renderer, so the
 * renderer's `promptMentionExpansion.ts` cannot expand them. Both sides run
 * the same shared algorithm from
 * `@canopy/desktop-shared/lib/prompt-mention-expansion`.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  expandPromptMentionsWithReader,
  type ExpandedPromptMentions,
  type PromptMentionReference,
} from '@canopy/desktop-shared/lib/prompt-mention-expansion';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import {
  getAppAdvisorHomeDir,
  getCoworkWorkspaceRootDir,
  getWorkspacePromptsDir,
} from './paths';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { isWorkEntryWorkspace } from './workspace-registry';
import { isPathInside } from './path-safety';
import { parseFrontmatterAndBody } from './frontmatter';

/** Prompts dir a by-path read is allowed to resolve into, per workspace. */
function promptsDirForProject(projectId: string): string {
  if (!isWorkEntryWorkspace(projectId)) {
    return getWorkspacePromptsDir(projectId);
  }
  const workspaceRoot =
    projectId === APP_ADVISOR_PROJECT_ID
      ? getAppAdvisorHomeDir()
      : getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(projectId));
  return getCoworkManagedSubdir(workspaceRoot, 'prompts');
}

/**
 * Read a workspace prompt's markdown body by absolute path. Throws when the
 * path does not canonically resolve to a Markdown file inside the workspace's
 * prompts directory (and, for cowork workspaces, when the prompts directory
 * itself escapes the workspace root via a symlinked managed dir).
 */
export async function readWorkspacePromptBodyByPath(
  projectId: string,
  requestedPath: string,
): Promise<string> {
  const coworkRoot = isWorkEntryWorkspace(projectId)
    ? projectId === APP_ADVISOR_PROJECT_ID
      ? getAppAdvisorHomeDir()
      : getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(projectId))
    : null;
  const promptsDir = promptsDirForProject(projectId);
  const absolutePath = resolve(requestedPath);
  if (!isPathInside(promptsDir, absolutePath)) {
    throw new Error('Prompt path is outside the project prompts directory');
  }
  const [canonicalPromptsDir, canonicalPath, canonicalCoworkRoot] =
    await Promise.all([
      realpath(promptsDir),
      realpath(absolutePath),
      coworkRoot === null ? Promise.resolve(null) : realpath(coworkRoot),
    ]);
  if (
    canonicalCoworkRoot !== null &&
    !isPathInside(canonicalCoworkRoot, canonicalPromptsDir)
  ) {
    throw new Error('Project prompts directory is outside the project');
  }
  if (!isPathInside(canonicalPromptsDir, canonicalPath)) {
    throw new Error('Prompt path is outside the project prompts directory');
  }
  const fileStat = await stat(canonicalPath);
  if (!fileStat.isFile() || extname(canonicalPath).toLowerCase() !== '.md') {
    throw new Error('Prompt path must reference a Markdown file');
  }
  const raw = await readFile(canonicalPath, 'utf8');
  return parseFrontmatterAndBody(raw).body;
}

/**
 * Expand `@`-mentioned prompt references for a send entering main directly
 * (the portal path). Prompt bodies are read through the same path-validated
 * read the renderer IPC uses; an unreadable/invalid prompt keeps its pill so
 * the reference is never silently dropped.
 */
export async function expandWorkspacePromptMentions<
  T extends PromptMentionReference,
>(
  projectId: string,
  text: string,
  fileReferences: readonly T[],
): Promise<ExpandedPromptMentions<T>> {
  return expandPromptMentionsWithReader(text, fileReferences, (absolutePath) =>
    readWorkspacePromptBodyByPath(projectId, absolutePath),
  );
}
