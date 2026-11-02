import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type {
  ClipboardAttachmentData,
  StandaloneAttachmentMeta,
  StandaloneNoteMeta,
  StandalonePromptSnippetMeta,
  StandaloneReadNoteResponse,
  StandaloneReadPromptResponse,
} from '@canopy/desktop-shared/types';
import { normalizeCloudAttachmentFilenameStem } from '@canopy/protocol/cloud-attachments';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getAppAdvisorHomeDir, getCoworkWorkspaceRootDir } from './paths';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { resolveCoworkWorkspaceId } from './cowork-migration-map';
import { isPathInside } from './path-safety';
import { parseFrontmatterAndBody } from './frontmatter';
import { replaceSharedContainerScopeItemId } from '../shared-containers/file-scope-store';

/**
 * Resolves the legacy chat-project id (`projectId`) to the migrated cowork
 * workspace's working directory (its managed home, or an attached external
 * folder — see {@link getCoworkWorkspaceRootDir}).
 * Notes/prompts/attachments live under the brand-managed subdir.
 */
function getProjectHomeDir(projectId: string): string {
  if (projectId === APP_ADVISOR_PROJECT_ID) {
    return getAppAdvisorHomeDir();
  }
  return getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(projectId));
}

function inferTitleFromMarkdown(id: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || id.replace(/-/g, ' ');
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

const PORTABLE_FILENAME_MAX_BYTES = 255;

function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function preservedWorkspaceItemTarget(
  dir: string,
  id: string,
): { id: string; absolutePath: string; filename: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error('Invalid preserved workspace item id');
  }
  const filename = `${id}.md`;
  return { id, absolutePath: join(dir, filename), filename };
}

async function listMarkdownIds(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

export const ATTACHMENT_EXTENSION_TOO_LONG_MESSAGE =
  'Attachment filename extension is too long';

function uniquePathCandidate(
  dir: string,
  normalizedBase: string,
  counter: number,
  extension: string,
  maxFilenameBytes?: number,
): { id: string; absolutePath: string; filename: string } {
  const suffix = counter === 1 ? '' : `-${counter}`;
  const baseByteBudget =
    maxFilenameBytes === undefined
      ? Number.POSITIVE_INFINITY
      : maxFilenameBytes -
        Buffer.byteLength(extension, 'utf8') -
        Buffer.byteLength(suffix, 'utf8');
  if (baseByteBudget < 1) {
    throw new Error(ATTACHMENT_EXTENSION_TOO_LONG_MESSAGE);
  }
  const boundedBase = Number.isFinite(baseByteBudget)
    ? truncateToUtf8Bytes(normalizedBase, baseByteBudget)
    : normalizedBase;
  const attempt = `${boundedBase}${suffix}`;
  const filename = `${attempt}${extension}`;
  return { id: attempt, absolutePath: join(dir, filename), filename };
}

export async function resolveUniquePath(
  dir: string,
  baseName: string,
  extension: string,
  existingAbsolutePath?: string,
  maxFilenameBytes?: number,
): Promise<{ id: string; absolutePath: string; filename: string }> {
  const normalizedBase =
    normalizeCloudAttachmentFilenameStem(baseName) || 'item';
  let counter = 1;

  while (true) {
    const candidate = uniquePathCandidate(
      dir,
      normalizedBase,
      counter,
      extension,
      maxFilenameBytes,
    );
    if (
      existingAbsolutePath &&
      candidate.absolutePath === existingAbsolutePath
    ) {
      return candidate;
    }
    try {
      await stat(candidate.absolutePath);
      counter += 1;
    } catch {
      return candidate;
    }
  }
}

function errnoCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

/**
 * {@link resolveUniquePath} for attachments, creating the file exclusively:
 * a concurrent import that claims the free name first moves this one to the
 * next suffix instead of being overwritten (CAN-4105).
 */
async function createUniqueAttachment(
  dir: string,
  baseName: string,
  extension: string,
  create: (absolutePath: string) => Promise<void>,
): Promise<{ absolutePath: string; filename: string }> {
  const normalizedBase =
    normalizeCloudAttachmentFilenameStem(baseName) || 'item';
  for (let counter = 1; ; counter += 1) {
    const candidate = uniquePathCandidate(
      dir,
      normalizedBase,
      counter,
      extension,
      PORTABLE_FILENAME_MAX_BYTES,
    );
    try {
      await stat(candidate.absolutePath);
      continue;
    } catch {
      // Free as far as the listing shows; the exclusive create decides.
    }
    try {
      await create(candidate.absolutePath);
      return candidate;
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') throw error;
    }
  }
}

export interface CopiedAttachmentFile {
  filename: string;
  absolutePath: string;
  sizeBytes: number;
  createdAt: string;
}

export async function copyAttachmentFileToDir(
  dir: string,
  sourcePath: string,
): Promise<CopiedAttachmentFile> {
  await ensureDir(dir);
  const sourceInfo = await stat(sourcePath);
  const sourceName = basename(sourcePath);
  const extension = extname(sourceName);
  const target = await createUniqueAttachment(
    dir,
    sourceName.slice(0, sourceName.length - extension.length) || 'attachment',
    extension,
    (absolutePath) =>
      copyFile(sourcePath, absolutePath, fsConstants.COPYFILE_EXCL),
  );
  const info = await stat(target.absolutePath);
  return {
    filename: target.filename,
    absolutePath: target.absolutePath,
    sizeBytes: info.size || sourceInfo.size,
    createdAt: info.birthtime.toISOString(),
  };
}

export async function writeClipboardAttachmentToDir(
  dir: string,
  item: ClipboardAttachmentData,
): Promise<CopiedAttachmentFile> {
  await ensureDir(dir);
  const extension = extname(item.filename);
  const stem =
    item.filename.slice(0, item.filename.length - extension.length) ||
    'clipboard';
  const target = await createUniqueAttachment(
    dir,
    stem,
    extension,
    async (absolutePath) => {
      try {
        await writeFile(absolutePath, item.data, { flag: 'wx' });
      } catch (error) {
        // EEXIST means another writer owns the file; never remove it.
        if (errnoCode(error) !== 'EEXIST')
          await rm(absolutePath, { force: true }).catch(() => undefined);
        throw error;
      }
    },
  );
  let info;
  try {
    info = await stat(target.absolutePath);
  } catch (error) {
    await rm(target.absolutePath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    filename: target.filename,
    absolutePath: target.absolutePath,
    sizeBytes: info.size,
    createdAt: info.birthtime.toISOString(),
  };
}

function resolveWorkspacePath(baseDir: string, relativePath: string): string {
  const absolutePath = resolve(baseDir, relativePath);
  if (!isPathInside(baseDir, absolutePath)) {
    throw new Error('Invalid project path');
  }
  return absolutePath;
}

export async function listNotes(
  projectId: string,
): Promise<StandaloneNoteMeta[]> {
  const dir = getCoworkManagedSubdir(getProjectHomeDir(projectId), 'notes');
  const ids = await listMarkdownIds(dir);

  return Promise.all(
    ids.map(async (id) => {
      const absolutePath = join(dir, `${id}.md`);
      const [raw, info] = await Promise.all([
        readFile(absolutePath, 'utf8'),
        stat(absolutePath),
      ]);
      return {
        id,
        title: inferTitleFromMarkdown(id, raw),
        createdAt: info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
      };
    }),
  );
}

export async function readNote(
  projectId: string,
  noteId: string,
): Promise<StandaloneReadNoteResponse> {
  const absolutePath = resolveWorkspacePath(
    getCoworkManagedSubdir(getProjectHomeDir(projectId), 'notes'),
    `${noteId}.md`,
  );
  const [content, info] = await Promise.all([
    readFile(absolutePath, 'utf8'),
    stat(absolutePath),
  ]);
  return {
    meta: {
      id: noteId,
      title: inferTitleFromMarkdown(noteId, content),
      createdAt: info.birthtime.toISOString(),
      updatedAt: info.mtime.toISOString(),
    },
    content,
  };
}

export async function saveNote(
  projectId: string,
  title: string,
  content: string,
  noteId?: string,
  options?: { preserveId?: boolean },
): Promise<StandaloneNoteMeta> {
  const dir = getCoworkManagedSubdir(getProjectHomeDir(projectId), 'notes');
  await ensureDir(dir);

  const existingAbsolutePath = noteId ? join(dir, `${noteId}.md`) : undefined;
  const target =
    options?.preserveId && noteId
      ? preservedWorkspaceItemTarget(dir, noteId)
      : await resolveUniquePath(
          dir,
          title || noteId || 'note',
          '.md',
          existingAbsolutePath,
        );

  await writeFile(target.absolutePath, content, 'utf8');
  if (
    noteId &&
    existingAbsolutePath &&
    target.absolutePath !== existingAbsolutePath &&
    isPathInside(dir, existingAbsolutePath)
  ) {
    await replaceSharedContainerScopeItemId(
      projectId,
      'note',
      noteId,
      target.id,
    );
    await rm(existingAbsolutePath, { force: true });
  }
  const info = await stat(target.absolutePath);
  void import('../shared-containers/publish/scheduler')
    .then(({ getSharedContainerPublishScheduler }) =>
      getSharedContainerPublishScheduler().scheduleWorkspace(projectId),
    )
    .catch(() => undefined);
  return {
    id: target.id,
    title: title.trim() || inferTitleFromMarkdown(target.id, content),
    createdAt: info.birthtime.toISOString(),
    updatedAt: info.mtime.toISOString(),
  };
}

export async function listPrompts(
  projectId: string,
): Promise<StandalonePromptSnippetMeta[]> {
  const dir = getCoworkManagedSubdir(getProjectHomeDir(projectId), 'prompts');
  const ids = await listMarkdownIds(dir);

  return Promise.all(
    ids.map(async (id) => {
      const absolutePath = join(dir, `${id}.md`);
      const [raw, info] = await Promise.all([
        readFile(absolutePath, 'utf8'),
        stat(absolutePath),
      ]);
      const { frontmatter } = parseFrontmatterAndBody(raw);
      return {
        id,
        title:
          typeof frontmatter.title === 'string' && frontmatter.title.trim()
            ? frontmatter.title.trim()
            : id.replace(/-/g, ' '),
        createdAt: info.birthtime.toISOString(),
        updatedAt: info.mtime.toISOString(),
      };
    }),
  );
}

export async function readPrompt(
  projectId: string,
  promptId: string,
): Promise<StandaloneReadPromptResponse> {
  const absolutePath = resolveWorkspacePath(
    getCoworkManagedSubdir(getProjectHomeDir(projectId), 'prompts'),
    `${promptId}.md`,
  );
  const [raw, info] = await Promise.all([
    readFile(absolutePath, 'utf8'),
    stat(absolutePath),
  ]);
  const { frontmatter, body } = parseFrontmatterAndBody(raw);
  return {
    meta: {
      id: promptId,
      title:
        typeof frontmatter.title === 'string' && frontmatter.title.trim()
          ? frontmatter.title.trim()
          : promptId.replace(/-/g, ' '),
      createdAt: info.birthtime.toISOString(),
      updatedAt: info.mtime.toISOString(),
    },
    content: body,
  };
}

export async function savePrompt(
  projectId: string,
  title: string,
  content: string,
  promptId?: string,
  options?: { preserveId?: boolean },
): Promise<StandalonePromptSnippetMeta> {
  const dir = getCoworkManagedSubdir(getProjectHomeDir(projectId), 'prompts');
  await ensureDir(dir);
  const existingAbsolutePath = promptId
    ? join(dir, `${promptId}.md`)
    : undefined;
  const target =
    options?.preserveId && promptId
      ? preservedWorkspaceItemTarget(dir, promptId)
      : await resolveUniquePath(
          dir,
          title || promptId || 'prompt',
          '.md',
          existingAbsolutePath,
        );

  const raw = `---\ntitle: ${JSON.stringify(title.trim() || target.id)}\ntags: []\n---\n${content}`;
  await writeFile(target.absolutePath, raw, 'utf8');
  if (
    promptId &&
    existingAbsolutePath &&
    target.absolutePath !== existingAbsolutePath &&
    isPathInside(dir, existingAbsolutePath)
  ) {
    await replaceSharedContainerScopeItemId(
      projectId,
      'prompt',
      promptId,
      target.id,
    );
    await rm(existingAbsolutePath, { force: true });
  }
  const info = await stat(target.absolutePath);
  void import('../shared-containers/publish/scheduler')
    .then(({ getSharedContainerPublishScheduler }) =>
      getSharedContainerPublishScheduler().scheduleWorkspace(projectId),
    )
    .catch(() => undefined);
  return {
    id: target.id,
    title: title.trim() || target.id,
    createdAt: info.birthtime.toISOString(),
    updatedAt: info.mtime.toISOString(),
  };
}

export async function listAttachments(
  projectId: string,
): Promise<StandaloneAttachmentMeta[]> {
  const dir = getCoworkManagedSubdir(
    getProjectHomeDir(projectId),
    'attachments',
  );
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      );
    return Promise.all(
      files.map(async (entry) => {
        const filePath = join(dir, entry.name);
        const info = await stat(filePath);
        return {
          id: entry.name,
          filename: entry.name,
          absolutePath: filePath,
          sizeBytes: info.size,
          createdAt: info.birthtime.toISOString(),
        };
      }),
    );
  } catch {
    return [];
  }
}

export async function importAttachment(
  projectId: string,
  sourcePath: string,
): Promise<StandaloneAttachmentMeta> {
  const dir = getCoworkManagedSubdir(
    getProjectHomeDir(projectId),
    'attachments',
  );
  const copied = await copyAttachmentFileToDir(dir, sourcePath);
  return {
    id: copied.filename,
    filename: copied.filename,
    absolutePath: copied.absolutePath,
    sizeBytes: copied.sizeBytes,
    createdAt: copied.createdAt,
  };
}

export async function importClipboardAttachment(
  projectId: string,
  item: ClipboardAttachmentData,
): Promise<StandaloneAttachmentMeta> {
  const dir = getCoworkManagedSubdir(
    getProjectHomeDir(projectId),
    'attachments',
  );
  const copied = await writeClipboardAttachmentToDir(dir, item);
  return {
    id: copied.filename,
    filename: copied.filename,
    absolutePath: copied.absolutePath,
    sizeBytes: copied.sizeBytes,
    createdAt: copied.createdAt,
  };
}

export async function deleteAttachment(
  projectId: string,
  relativePath: string,
): Promise<void> {
  const attachmentsDir = getCoworkManagedSubdir(
    getProjectHomeDir(projectId),
    'attachments',
  );
  if (relativePath.trim().length === 0) {
    throw new Error('Invalid attachment filename');
  }
  const absolutePath = resolveWorkspacePath(attachmentsDir, relativePath);
  if (absolutePath === resolve(attachmentsDir)) {
    throw new Error('Invalid attachment filename');
  }
  await rm(absolutePath, { force: true });
}
