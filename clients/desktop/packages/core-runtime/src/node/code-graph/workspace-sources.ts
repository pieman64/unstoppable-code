import { readFile as readFileText } from 'node:fs/promises';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/protocol/ui-labels';
import {
  readWorkspaceManifest,
  type WorkspaceFileRead,
} from '../workspace/read-formats';

const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]*$/;
const MAX_WORKSPACE_ID_LENGTH = 512;

/**
 * Each repository's configured source checkout, by repository id, from the
 * workspace's trusted manifest, as Electron main seeds first graphs from
 * (desktop `canonicalSourceByRepoId`): a single-repo `repoPath`, or a
 * multi-repo `sourceRepoPath` and each `repos[].repoPath`. Only absolute
 * paths without NUL are kept. An absent, unreadable or malformed manifest
 * gives an empty map: the first graph builds cold.
 */
export async function readCodeGraphWorkspaceSources(input: {
  readonly dataRoot: string;
  readonly workspaceId: string;
  readonly paths: {
    join(this: void, ...parts: string[]): string;
    isAbsolute(this: void, value: string): boolean;
  };
  readonly readFile?: (
    this: void,
    absolutePath: string,
  ) => Promise<WorkspaceFileRead>;
}): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>();
  if (
    input.workspaceId.length > MAX_WORKSPACE_ID_LENGTH ||
    !WORKSPACE_ID.test(input.workspaceId)
  ) {
    return sources;
  }
  const read = input.readFile ?? readManifestFile;
  let file: WorkspaceFileRead;
  try {
    file = await read(
      input.paths.join(
        input.dataRoot,
        'workspaces',
        input.workspaceId,
        'workspace.json',
      ),
    );
  } catch {
    return sources;
  }
  const manifest = readWorkspaceManifest(file);
  if (manifest.authority !== 'ok') return sources;
  const config = manifest.document;
  const type =
    config.type === undefined
      ? typeof config.repoPath === 'string'
        ? 'single-repo'
        : 'multi-repo'
      : config.type;
  const keep = (repoId: string, value: unknown): void => {
    if (
      typeof value === 'string' &&
      !value.includes('\0') &&
      input.paths.isAbsolute(value)
    ) {
      sources.set(repoId, value);
    }
  };
  if (type === 'single-repo') {
    keep(WORKSPACE_ROOT_REPO_ID, config.repoPath);
  }
  if (type === 'multi-repo') {
    keep(WORKSPACE_ROOT_REPO_ID, config.sourceRepoPath);
    if (Array.isArray(config.repos)) {
      for (const repository of config.repos) {
        if (typeof repository !== 'object' || repository === null) continue;
        const id: unknown = Reflect.get(repository, 'id');
        if (typeof id === 'string') {
          keep(id, Reflect.get(repository, 'repoPath'));
        }
      }
    }
  }
  return sources;
}

async function readManifestFile(
  absolutePath: string,
): Promise<WorkspaceFileRead> {
  try {
    return { state: 'present', raw: await readFileText(absolutePath, 'utf8') };
  } catch (error) {
    return {
      state:
        typeof error === 'object' &&
        error !== null &&
        Reflect.get(error, 'code') === 'ENOENT'
          ? 'absent'
          : 'unreadable',
    };
  }
}
