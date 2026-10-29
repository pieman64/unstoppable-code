import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatProjectData } from '@canopy/desktop-shared/types';
import {
  getChatProjectProjectFilePath,
  getCoworkWorkspaceRootDir,
  getWorkspaceChatHistoryRootDir,
  getWorkspaceDerivedDir,
  getWorkspaceHomeDir,
} from './paths';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { BRAND } from '@canopy/brand/current';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import {
  ensureAgentsMdSymlink,
  ensureAgentsMdSymlinkOrCopy,
} from './instruction-files';
import { getWorkspaceExternalPath } from './workspace-registry';
import {
  buildDefaultStandaloneProjectFile,
  readStandaloneProjectFile,
  saveStandaloneProjectFile,
} from './standalone-project-state';

// Describes the current cowork on-disk layout: the agent works directly in
// this folder's root (where durable generated outputs are written), the
// `.{brand}/` managed subfolder holds durable notes/prompts/
// user-provided attachments (see `getCoworkManagedSubdir`), and archived
// chat history lives entirely outside this folder in app-level storage. Keep
// this in sync with `buildCoworkSystemPromptAppend` (`cowork-chat-system-
// prompt.ts`), which describes the same layout to the agent at turn time.
const COWORK_MANAGED_DIR_NAME = BRAND.storage.projectConfigDirNames[0];
export const STANDALONE_CHAT_CLAUDE_MD_CONTENT = [
  'This project is intended for general purpose chats.',
  "Generated outputs (files you create) go directly in this folder's root unless the user names a different location.",
  `Durable notes, reusable prompt snippets, and user-provided attachments live under ${COWORK_MANAGED_DIR_NAME}/notes, ${COWORK_MANAGED_DIR_NAME}/prompts, and ${COWORK_MANAGED_DIR_NAME}/attachments.`,
  'Archived chat history lives outside this folder and is not browsable here.',
].join(' ');

/**
 * Scaffolds a cowork workspace so it is ready for chat use.
 *
 * - **Managed** (no attached `externalPath`): scaffolds the managed `home/`
 *   directory — the `notes`, `attachments`, and `prompts` managed subfolders,
 *   a default `CLAUDE.md` (only if one doesn't already exist), and the
 *   `AGENTS.md` compatibility link (a relative symlink on POSIX, or a hard
 *   link/copy on Windows). This is the scaffolder cowork workspace CREATE
 *   paths (`cowork-workspace-crud.ts`) use — it never
 *   touches the legacy `standalone-chat/{project}/project.json` file, since a
 *   newly created cowork workspace has no legacy on-disk counterpart to seed.
 * - **External** (`externalPath` registered via {@link getWorkspaceExternalPath}):
 *   only ensures the user's chosen directory exists. It deliberately does NOT
 *   seed `CLAUDE.md`/`AGENTS.md` or proactively create the `.{brand}/`
 *   managed subfolder there — the user's folder stays untouched until a
 *   managed feature (notes/prompts/attachments) actually writes to it, and
 *   CLAUDE.md seeding stays managed-home-only.
 *
 * The `chat-history`/`derived` sibling dirs always live under
 * `workspaces/{id}/` (Canopy's own metadata root), never inside the folder
 * itself, so both branches scaffold them the same way.
 */
export async function ensureCoworkHomeScaffold(
  workspaceId: string,
): Promise<void> {
  await Promise.all([
    mkdir(getWorkspaceChatHistoryRootDir(workspaceId), { recursive: true }),
    mkdir(getWorkspaceDerivedDir(workspaceId), { recursive: true }),
  ]);

  const externalPath = getWorkspaceExternalPath(workspaceId);
  if (externalPath !== null) {
    await mkdir(externalPath, { recursive: true });
    return;
  }

  const home = getWorkspaceHomeDir(workspaceId);

  await Promise.all([
    mkdir(getCoworkManagedSubdir(home, 'notes'), { recursive: true }),
    mkdir(getCoworkManagedSubdir(home, 'attachments'), { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(getCoworkManagedSubdir(home, 'prompts'), { recursive: true }),
  ]);

  const claudeMdPath = join(home, 'CLAUDE.md');
  try {
    await readFile(claudeMdPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await writeFile(claudeMdPath, STANDALONE_CHAT_CLAUDE_MD_CONTENT, 'utf8');
    } else {
      throw error;
    }
  }

  try {
    await lstat(join(home, 'AGENTS.md'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await ensureAgentsMdSymlink(home);
    } else {
      throw error;
    }
  }
}

/**
 * Legacy standalone-chat scaffolder: does everything
 * {@link ensureCoworkHomeScaffold} does (via `resolveCoworkWorkspaceId`) and
 * additionally seeds the legacy `standalone-chat/{project}/project.json`
 * file. Only the not-yet-reshaped standalone export/import-project flows in
 * `ipc/standalone-chat.ts` still call this — they read/write the legacy
 * on-disk shape directly (see that file's `exportProject`/`importProject`
 * comment). Cowork workspace CREATE paths must use
 * {@link ensureCoworkHomeScaffold} instead so no legacy `project.json`
 * artifact is created for workspaces that never had one.
 */
export async function ensureChatProjectDir(
  projectId: string,
  seedProject?: Partial<ChatProjectData>,
): Promise<void> {
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  await ensureCoworkHomeScaffold(workspaceId);

  // `project.json` is the legacy pre-migration settings file; the migrated
  // cowork layout has no equivalent (settings now live on the workspace's
  // `CoworkSidebarItem`/`workspace.json`). This legacy read/seed is kept only
  // so `readStandaloneProjectFile`/`saveStandaloneProjectFile` — still used
  // by the standalone export/import-project CRUD flows in
  // `ipc/standalone-chat.ts` — keep working until that surface is reshaped
  // to bundle from the new workspace layout.
  const projectFilePath = getChatProjectProjectFilePath(projectId);
  try {
    await readFile(projectFilePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const existing = await readStandaloneProjectFile(projectId);
      await saveStandaloneProjectFile(
        projectId,
        existing ??
          buildDefaultStandaloneProjectFile({
            id: projectId,
            name: seedProject?.name ?? 'Untitled Project',
            createdAt: seedProject?.createdAt ?? new Date().toISOString(),
          }),
      );
    } else {
      throw error;
    }
  }

  await syncChatProjectAgentsMd(projectId);
}

export async function syncChatProjectAgentsMd(
  projectId: string,
): Promise<void> {
  const workspaceId = resolveCoworkWorkspaceId(projectId);
  await ensureAgentsMdSymlinkOrCopy(getCoworkWorkspaceRootDir(workspaceId));
}
