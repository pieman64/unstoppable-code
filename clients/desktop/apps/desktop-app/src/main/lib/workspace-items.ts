/**
 * Machine-local Notes/Prompts storage for CODE workspaces.
 *
 * Layout (per workspace):
 *   {dataDir}/workspaces/{workspaceId}/notes/{id}.md    + notes/index.json
 *   {dataDir}/workspaces/{workspaceId}/prompts/{id}.md  + prompts/index.json
 *
 * The index (`WorkspaceNotesIndexFile` / `WorkspacePromptsIndexFile`,
 * version 1) carries per-item origin metadata: `originWorktreeId` (stable)
 * plus an `originBranchName` snapshot. Listing is self-healing — the
 * directory scan is reconciled against the index, so hand-dropped `.md`
 * files appear (without origin) and index entries whose file vanished are
 * dropped. Branch origins resolve live from the workspace's worktree records
 * while the origin worktree exists; the stored snapshot is refreshed lazily
 * (write-behind during list) so it stays accurate for the day the worktree
 * is deleted.
 *
 * Cowork workspaces do NOT use this module — their notes/prompts stay in the
 * brand-managed subdir of the cowork working folder (see
 * `standalone-workspace-files.ts`); `main/ipc/workspace-items.ts` dispatches
 * per workspace type.
 */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  WorkspaceItemIndexEntry,
  WorkspaceItemOrigin,
  WorkspaceNoteItem,
  WorkspacePromptItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { getWorkspaceNotesDir, getWorkspacePromptsDir } from './paths';
import { readWorkspaceWorktrees } from './workspace-persistence';
import { resolveUniquePath } from './standalone-workspace-files';
import { parseFrontmatterAndBody } from './frontmatter';
import { isPathInside } from './path-safety';
import { isRecord } from './type-guards';

const INDEX_FILENAME = 'index.json';

type WorkspaceItemKind = 'note' | 'prompt';

interface WorkspaceItemsIndexFileShape {
  version: 1;
  items: Record<string, WorkspaceItemIndexEntry>;
}

function itemsDir(workspaceId: string, kind: WorkspaceItemKind): string {
  return kind === 'note'
    ? getWorkspaceNotesDir(workspaceId)
    : getWorkspacePromptsDir(workspaceId);
}

function parseIndexEntry(value: unknown): WorkspaceItemIndexEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, filename, title, createdAt, updatedAt } = value;
  if (
    typeof id !== 'string' ||
    typeof filename !== 'string' ||
    typeof title !== 'string' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return null;
  }
  const entry: WorkspaceItemIndexEntry = {
    id,
    filename,
    title,
    createdAt,
    updatedAt,
  };
  if (typeof value.originWorktreeId === 'string' && value.originWorktreeId) {
    entry.originWorktreeId = value.originWorktreeId;
  }
  if (typeof value.originBranchName === 'string' && value.originBranchName) {
    entry.originBranchName = value.originBranchName;
  }
  return entry;
}

async function readIndex(
  dir: string,
): Promise<Record<string, WorkspaceItemIndexEntry>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(dir, INDEX_FILENAME), 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(parsed) || !isRecord(parsed.items)) {
    return {};
  }
  const items: Record<string, WorkspaceItemIndexEntry> = {};
  for (const value of Object.values(parsed.items)) {
    const entry = parseIndexEntry(value);
    if (entry !== null) {
      items[entry.id] = entry;
    }
  }
  return items;
}

async function writeIndex(
  dir: string,
  items: Record<string, WorkspaceItemIndexEntry>,
): Promise<void> {
  const file: WorkspaceItemsIndexFileShape = { version: 1, items };
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, INDEX_FILENAME),
    JSON.stringify(file, null, 2),
    'utf8',
  );
}

function titleFromContent(
  kind: WorkspaceItemKind,
  id: string,
  raw: string,
): string {
  if (kind === 'prompt') {
    const { frontmatter } = parseFrontmatterAndBody(raw);
    if (typeof frontmatter.title === 'string' && frontmatter.title.trim()) {
      return frontmatter.title.trim();
    }
    return id.replace(/-/g, ' ');
  }
  const heading = raw.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || id.replace(/-/g, ' ');
}

function resolveOrigin(
  entry: WorkspaceItemIndexEntry,
  worktreesById: Map<string, WorktreeData>,
): { origin?: WorkspaceItemOrigin; liveBranchName?: string } {
  if (entry.originWorktreeId === undefined) {
    return {};
  }
  const live = worktreesById.get(entry.originWorktreeId);
  if (live !== undefined) {
    return {
      origin: {
        worktreeId: entry.originWorktreeId,
        branchName: live.branchName,
        worktreeExists: true,
      },
      liveBranchName: live.branchName,
    };
  }
  if (entry.originBranchName === undefined) {
    // Origin worktree is gone and no snapshot was ever captured — the origin
    // is unrecoverable, so omit it rather than invent a branch name.
    return {};
  }
  return {
    origin: {
      worktreeId: entry.originWorktreeId,
      branchName: entry.originBranchName,
      worktreeExists: false,
    },
  };
}

async function loadWorktreesById(
  workspaceId: string,
): Promise<Map<string, WorktreeData>> {
  try {
    const worktrees = await readWorkspaceWorktrees(workspaceId);
    return new Map(worktrees.map((worktree) => [worktree.id, worktree]));
  } catch {
    return new Map();
  }
}

/**
 * Directory-scan + index reconciliation. Returns renderer items sorted by
 * `updatedAt` (newest first). Side effects (best-effort, non-fatal):
 * - index entries whose file vanished are dropped;
 * - un-indexed `.md` files are adopted (no origin);
 * - stale `originBranchName` snapshots are rewritten to the live branch name
 *   (lazy write-behind — see module doc).
 */
async function listItems(
  workspaceId: string,
  kind: WorkspaceItemKind,
): Promise<WorkspaceNoteItem[]> {
  const dir = itemsDir(workspaceId, kind);
  const index = await readIndex(dir);
  const worktreesById = await loadWorktreesById(workspaceId);

  let fileNames: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    fileNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name);
  } catch {
    fileNames = [];
  }

  const nextIndex: Record<string, WorkspaceItemIndexEntry> = {};
  let indexDirty = false;
  const items: WorkspaceNoteItem[] = [];

  for (const filename of fileNames) {
    const id = filename.slice(0, -3);
    const absolutePath = join(dir, filename);
    let entry = index[id];

    if (entry === undefined) {
      // Self-heal: adopt a hand-dropped markdown file (no origin).
      let raw: string;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        [raw, info] = await Promise.all([
          readFile(absolutePath, 'utf8'),
          stat(absolutePath),
        ]);
      } catch {
        continue;
      }
      entry = {
        id,
        filename,
        title: titleFromContent(kind, id, raw),
        createdAt: info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
      };
      indexDirty = true;
    }

    const { origin, liveBranchName } = resolveOrigin(entry, worktreesById);
    if (
      liveBranchName !== undefined &&
      entry.originBranchName !== liveBranchName
    ) {
      entry = { ...entry, originBranchName: liveBranchName };
      indexDirty = true;
    }

    nextIndex[id] = entry;
    items.push({
      id,
      title: entry.title,
      absolutePath,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(origin !== undefined ? { origin } : {}),
    });
  }

  if (
    indexDirty ||
    Object.keys(index).length !== Object.keys(nextIndex).length
  ) {
    try {
      await writeIndex(dir, nextIndex);
    } catch {
      // Best-effort write-behind; listing still succeeds.
    }
  }

  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

interface SaveItemParams {
  workspaceId: string;
  kind: WorkspaceItemKind;
  itemId?: string;
  title: string;
  content: string;
  originWorktreeId?: string;
}

async function saveItem(params: SaveItemParams): Promise<WorkspaceNoteItem> {
  const { workspaceId, kind, itemId, title, content, originWorktreeId } =
    params;
  const dir = itemsDir(workspaceId, kind);
  await mkdir(dir, { recursive: true });

  const index = await readIndex(dir);
  const existing = itemId !== undefined ? index[itemId] : undefined;
  // Fall back to the id-derived filename when the item exists on disk but
  // was never indexed (hand-dropped file edited before any list ran), so an
  // edit replaces the file instead of leaving a duplicate behind.
  const existingAbsolutePath =
    existing !== undefined
      ? join(dir, existing.filename)
      : itemId !== undefined
        ? join(dir, `${itemId}.md`)
        : undefined;

  const target = await resolveUniquePath(
    dir,
    title || itemId || kind,
    '.md',
    existingAbsolutePath,
  );

  const renamedFromPath =
    existingAbsolutePath !== undefined &&
    target.absolutePath !== existingAbsolutePath &&
    isPathInside(dir, existingAbsolutePath)
      ? existingAbsolutePath
      : undefined;

  const trimmedTitle = title.trim() || target.id.replace(/-/g, ' ');
  const raw =
    kind === 'prompt'
      ? `---\ntitle: ${JSON.stringify(trimmedTitle)}\ntags: []\n---\n${content}`
      : content;
  if (renamedFromPath !== undefined) {
    const tempPath = join(dir, `.${target.filename}.${randomUUID()}.write-tmp`);
    try {
      await writeFile(tempPath, raw, 'utf8');
      await rename(tempPath, target.absolutePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  } else {
    await writeFile(target.absolutePath, raw, 'utf8');
  }

  const now = new Date().toISOString();
  let entry: WorkspaceItemIndexEntry = {
    id: target.id,
    filename: target.filename,
    title: trimmedTitle,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  // Origin: preserved from the existing entry on edit; captured (with a live
  // branch snapshot) when a new item is created from a worktree context.
  if (existing?.originWorktreeId !== undefined) {
    entry = {
      ...entry,
      originWorktreeId: existing.originWorktreeId,
      ...(existing.originBranchName !== undefined
        ? { originBranchName: existing.originBranchName }
        : {}),
    };
  } else if (originWorktreeId !== undefined && existing === undefined) {
    const worktreesById = await loadWorktreesById(workspaceId);
    const live = worktreesById.get(originWorktreeId);
    if (live !== undefined) {
      entry = {
        ...entry,
        originWorktreeId,
        originBranchName: live.branchName,
      };
    }
  }

  if (existing !== undefined && existing.id !== entry.id) {
    delete index[existing.id];
  }
  index[entry.id] = entry;
  await writeIndex(dir, index);

  // A renamed item is committed in data-safe order: replacement file first,
  // then its index entry, and only then deletion of the original. Any failure
  // before this point therefore leaves the user's previous copy intact.
  if (renamedFromPath !== undefined) {
    await rm(renamedFromPath, { force: true });
  }

  const worktreesById = await loadWorktreesById(workspaceId);
  const { origin } = resolveOrigin(entry, worktreesById);
  return {
    id: entry.id,
    title: entry.title,
    absolutePath: target.absolutePath,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(origin !== undefined ? { origin } : {}),
  };
}

async function readItem(
  workspaceId: string,
  kind: WorkspaceItemKind,
  itemId: string,
): Promise<{ meta: WorkspaceNoteItem; content: string }> {
  const dir = itemsDir(workspaceId, kind);
  const absolutePath = join(dir, `${itemId}.md`);
  if (!isPathInside(dir, absolutePath)) {
    throw new Error(`Invalid ${kind} id`);
  }
  const raw = await readFile(absolutePath, 'utf8');
  const content = kind === 'prompt' ? parseFrontmatterAndBody(raw).body : raw;

  const index = await readIndex(dir);
  const entry = index[itemId];
  const info = await stat(absolutePath);
  const worktreesById = await loadWorktreesById(workspaceId);
  const origin =
    entry !== undefined
      ? resolveOrigin(entry, worktreesById).origin
      : undefined;
  return {
    meta: {
      id: itemId,
      title: entry?.title ?? titleFromContent(kind, itemId, raw),
      absolutePath,
      createdAt: entry?.createdAt ?? info.birthtime.toISOString(),
      updatedAt: entry?.updatedAt ?? info.mtime.toISOString(),
      ...(origin !== undefined ? { origin } : {}),
    },
    content,
  };
}

async function deleteItem(
  workspaceId: string,
  kind: WorkspaceItemKind,
  itemId: string,
): Promise<void> {
  const dir = itemsDir(workspaceId, kind);
  const absolutePath = join(dir, `${itemId}.md`);
  if (!isPathInside(dir, absolutePath)) {
    throw new Error(`Invalid ${kind} id`);
  }
  await rm(absolutePath, { force: true });
  const index = await readIndex(dir);
  if (index[itemId] !== undefined) {
    delete index[itemId];
    await writeIndex(dir, index);
  }
}

export function listWorkspaceNotes(
  workspaceId: string,
): Promise<WorkspaceNoteItem[]> {
  return listItems(workspaceId, 'note');
}

export function readWorkspaceNote(
  workspaceId: string,
  noteId: string,
): Promise<{ meta: WorkspaceNoteItem; content: string }> {
  return readItem(workspaceId, 'note', noteId);
}

export function saveWorkspaceNote(params: {
  workspaceId: string;
  noteId?: string;
  title: string;
  content: string;
  originWorktreeId?: string;
}): Promise<WorkspaceNoteItem> {
  return saveItem({
    workspaceId: params.workspaceId,
    kind: 'note',
    ...(params.noteId !== undefined ? { itemId: params.noteId } : {}),
    title: params.title,
    content: params.content,
    ...(params.originWorktreeId !== undefined
      ? { originWorktreeId: params.originWorktreeId }
      : {}),
  });
}

export function deleteWorkspaceNote(
  workspaceId: string,
  noteId: string,
): Promise<void> {
  return deleteItem(workspaceId, 'note', noteId);
}

export function listWorkspacePrompts(
  workspaceId: string,
): Promise<WorkspacePromptItem[]> {
  return listItems(workspaceId, 'prompt');
}

export function readWorkspacePrompt(
  workspaceId: string,
  promptId: string,
): Promise<{ meta: WorkspacePromptItem; content: string }> {
  return readItem(workspaceId, 'prompt', promptId);
}

export function saveWorkspacePrompt(params: {
  workspaceId: string;
  promptId?: string;
  title: string;
  content: string;
  originWorktreeId?: string;
}): Promise<WorkspacePromptItem> {
  return saveItem({
    workspaceId: params.workspaceId,
    kind: 'prompt',
    ...(params.promptId !== undefined ? { itemId: params.promptId } : {}),
    title: params.title,
    content: params.content,
    ...(params.originWorktreeId !== undefined
      ? { originWorktreeId: params.originWorktreeId }
      : {}),
  });
}

export function deleteWorkspacePrompt(
  workspaceId: string,
  promptId: string,
): Promise<void> {
  return deleteItem(workspaceId, 'prompt', promptId);
}
