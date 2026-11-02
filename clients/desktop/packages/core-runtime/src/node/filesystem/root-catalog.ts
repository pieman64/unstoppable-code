import { readdir } from 'node:fs/promises';

// Host-private root catalog. Trusted absolute paths stay on the host and must
// never be copied into protocol responses.

export type FilesystemRootKind =
  | 'git-repo'
  | 'workspace-root'
  | 'standalone'
  | 'attachments';

export interface FilesystemRoot {
  id: string;
  name: string;
  kind: FilesystemRootKind;
  absolutePath: string;
  gitAware: boolean;
  excludedDescendantRoots: string[];
}

export interface FilesystemRootCatalog {
  roots: readonly FilesystemRoot[];
  byId: ReadonlyMap<string, FilesystemRoot>;
}

export interface FilesystemRootInput {
  id: string;
  name: string;
  kind: FilesystemRootKind;
  absolutePath: string;
  gitAware?: boolean;
  excludedDescendantRoots?: readonly string[];
}

export interface NamedRootPath {
  id: string;
  name: string;
  absolutePath: string;
}

/** The attachments directory and whether it currently has visible entries. */
export interface AttachmentsRootSource {
  absolutePath: string;
  visible: boolean;
}

export const ATTACHMENTS_ROOT_ID = 'attachments';

export function createFilesystemRoot(
  input: FilesystemRootInput,
): FilesystemRoot {
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    absolutePath: input.absolutePath,
    gitAware: input.gitAware ?? false,
    excludedDescendantRoots: [...(input.excludedDescendantRoots ?? [])],
  };
}

/** `attachments`, then `canopy-attachments`, then `canopy-attachments-<n>`. */
export function allocateAttachmentsRootId(
  reservedIds: ReadonlySet<string>,
): string {
  let id = ATTACHMENTS_ROOT_ID;
  for (let suffix = 2; reservedIds.has(id); suffix += 1) {
    id = suffix === 2 ? 'canopy-attachments' : `canopy-attachments-${suffix}`;
  }
  return id;
}

/** Keeps root order; a duplicate id resolves to its last root. */
export function createFilesystemRootCatalog(
  roots: readonly FilesystemRoot[],
): FilesystemRootCatalog {
  return {
    roots,
    byId: new Map(roots.map((root) => [root.id, root])),
  };
}

export function findFilesystemRoot(
  catalog: FilesystemRootCatalog,
  id: string,
): FilesystemRoot | undefined {
  return catalog.byId.get(id);
}

/** A directory holding only `.git` is not worth surfacing as a root. */
export function hasVisibleRootEntries(entryNames: readonly string[]): boolean {
  return entryNames.some((name) => name !== '.git');
}

/** Missing or unreadable directories are not visible. */
export async function readRootVisibility(
  absolutePath: string,
): Promise<boolean> {
  try {
    return hasVisibleRootEntries(await readdir(absolutePath));
  } catch {
    return false;
  }
}

function withAttachments(
  roots: FilesystemRoot[],
  attachments: AttachmentsRootSource,
): FilesystemRootCatalog {
  if (attachments.visible) {
    roots.push(
      createFilesystemRoot({
        id: allocateAttachmentsRootId(new Set(roots.map((root) => root.id))),
        name: 'attachments',
        kind: 'attachments',
        absolutePath: attachments.absolutePath,
      }),
    );
  }
  return createFilesystemRootCatalog(roots);
}

export function buildSingleRepoRootCatalog(input: {
  repo: NamedRootPath;
  attachments: AttachmentsRootSource;
}): FilesystemRootCatalog {
  const repo = createFilesystemRoot({
    ...input.repo,
    kind: 'git-repo',
    gitAware: true,
  });
  return withAttachments([repo], input.attachments);
}

export function buildMultiRepoRootCatalog(input: {
  workspaceRoot: NamedRootPath & { gitAware: boolean };
  /** Parent of every child repo checkout; excluded from the workspace root. */
  reposDir: string;
  repos: readonly NamedRootPath[];
  attachments: AttachmentsRootSource;
}): FilesystemRootCatalog {
  const repos = input.repos.map((repo) =>
    createFilesystemRoot({ ...repo, kind: 'git-repo', gitAware: true }),
  );
  const workspaceRoot = createFilesystemRoot({
    ...input.workspaceRoot,
    kind: 'workspace-root',
    excludedDescendantRoots: [
      input.reposDir,
      ...repos.map((repo) => repo.absolutePath),
    ],
  });
  return withAttachments([workspaceRoot, ...repos], input.attachments);
}

export function buildCoworkRootCatalog(input: {
  workspace: NamedRootPath;
  notesPath: string;
  promptsPath: string;
  attachments: AttachmentsRootSource;
}): FilesystemRootCatalog {
  const standalone = (id: string, absolutePath: string): FilesystemRoot =>
    createFilesystemRoot({ id, name: id, kind: 'standalone', absolutePath });
  // Managed dirs live inside the workspace folder but are surfaced as their
  // own roots, so the workspace scan skips them even while attachments is
  // hidden.
  const workspace = createFilesystemRoot({
    ...input.workspace,
    kind: 'standalone',
    excludedDescendantRoots: [
      input.notesPath,
      input.promptsPath,
      input.attachments.absolutePath,
    ],
  });
  return withAttachments(
    [
      workspace,
      standalone('notes', input.notesPath),
      standalone('prompts', input.promptsPath),
    ],
    input.attachments,
  );
}

/** Display metadata only; the host supplies a basename or its nonempty platform root path. */
export function resolveCoworkWorkspaceRootName(
  indexName: string | undefined,
  folderBasename: string,
): string {
  return indexName?.trim() || folderBasename;
}
