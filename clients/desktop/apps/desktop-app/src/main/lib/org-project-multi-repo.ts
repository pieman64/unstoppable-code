import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { OrgProjectRepository } from '@canopy/protocol/org-projects';
import {
  writeCanopyJson,
  readCanopyJson,
  hasManifestRepos,
} from './canopy-json';
import { buildOrgProjectCloneUrl } from './org-project-clone-url';
import type {
  SetupJournalV2,
  MultiRepoSetupRepository,
} from './org-project-setup-journal';

/** Prefix guarantees uniqueness across case/Unicode collisions and DOS names. */
export function multiRepoSetupRepositories(
  repositories: readonly OrgProjectRepository[],
): MultiRepoSetupRepository[] {
  return repositories.map((repository, index) => ({
    repository,
    relativePath: `repos/r${String(index + 1).padStart(2, '0')}-${
      repository.name
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '-')
        .slice(0, 64) || 'repository'
    }`,
    validated: false,
  }));
}
function marker(journal: SetupJournalV2): object {
  return {
    version: 1,
    journalId: journal.journalId,
    projectId: journal.projectId,
    localWorkspaceId: journal.localWorkspaceId,
    definitionRevision: journal.definitionRevision,
    repositories: journal.repositories.map((entry) => ({
      relativePath: entry.relativePath,
      repository: entry.repository,
    })),
  };
}
/** Generated infrastructure only; never read source configuration or instructions. */
export function multiRepoSetupManifest(
  repositories: readonly MultiRepoSetupRepository[],
): Parameters<typeof writeCanopyJson>[1] {
  return {
    version: 1,
    repos: repositories.map((entry) => ({
      id: entry.relativePath.slice('repos/'.length),
      name: entry.repository.name,
      url: buildOrgProjectCloneUrl(entry.repository, 'https'),
    })),
  };
}
export async function writeMultiRepoSetupManifest(
  path: string,
  journal: SetupJournalV2,
): Promise<void> {
  await writeCanopyJson(path, multiRepoSetupManifest(journal.repositories));
  await writeFile(
    join(path, '.git', 'canopy-shared-setup.json'),
    JSON.stringify(marker(journal)),
    { flag: 'wx', mode: 0o600 },
  );
}
/** Ownership is independent of phase labels and clone checkpoint flags. */
export async function ownsMultiRepoSetup(
  path: string,
  journal: SetupJournalV2,
): Promise<boolean> {
  try {
    if (
      (await realpath(path)) !== path ||
      !(await lstat(join(path, '.git'))).isDirectory()
    )
      return false;
    const ownershipPath = join(path, '.git', 'canopy-shared-setup.json');
    if (!(await lstat(ownershipPath)).isFile()) return false;
    const raw: unknown = JSON.parse(await readFile(ownershipPath, 'utf8'));
    if (JSON.stringify(raw) !== JSON.stringify(marker(journal))) return false;
    const manifest = await readCanopyJson(path);
    return (
      hasManifestRepos(manifest) &&
      manifest.repos.length === journal.repositories.length &&
      journal.repositories.every(
        (entry, index) =>
          manifest.repos[index]?.id ===
            entry.relativePath.slice('repos/'.length) &&
          manifest.repos[index]?.url ===
            buildOrgProjectCloneUrl(entry.repository, 'https'),
      )
    );
  } catch {
    return false;
  }
}
export async function validateMultiRepoSetupRepository(
  path: string,
  entry: MultiRepoSetupRepository,
): Promise<boolean> {
  try {
    const child = join(path, entry.relativePath);
    if (
      (await realpath(child)) !== child ||
      !(await lstat(join(child, '.git'))).isDirectory()
    )
      return false;
    const gitDir = join(child, '.git');
    if (
      (await lstat(join(gitDir, 'objects', 'info', 'alternates')).catch(
        () => null,
      )) !== null
    )
      return false;
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref: ')) return false;
    const ref = head.slice(5);
    if (
      !ref.startsWith('refs/heads/') ||
      ref.includes('..') ||
      ref.includes('\\') ||
      ref.includes('\0') ||
      (entry.repository.defaultBranch !== null &&
        ref !== `refs/heads/${entry.repository.defaultBranch}`)
    )
      return false;
    const loose = await readFile(join(gitDir, ref), 'utf8').catch(() => '');
    const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8').catch(
      () => '',
    );
    return (
      /^[a-f0-9]{40,64}\s*$/.test(loose) ||
      packed
        .split('\n')
        .some(
          (line) => /^[a-f0-9]{40,64} /.test(line) && line.endsWith(` ${ref}`),
        )
    );
  } catch {
    return false;
  }
}
export async function validateMultiRepoSetup(
  path: string,
  journal: SetupJournalV2,
): Promise<boolean> {
  if (!(await ownsMultiRepoSetup(path, journal))) return false;
  for (const entry of journal.repositories)
    if (
      !entry.validated ||
      !(await validateMultiRepoSetupRepository(path, entry))
    )
      return false;
  return true;
}
export async function createMultiRepoSetupChildParent(
  path: string,
): Promise<void> {
  await mkdir(join(path, 'repos'));
}
