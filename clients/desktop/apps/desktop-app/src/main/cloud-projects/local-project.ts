import {
  cloudProjectDirectoryNames,
  isSameRepository,
  normalizeRepoRemote,
  type CloudProjectManifest,
  type CloudProjectMatchRequest,
  type CloudProjectRepositoryDraft,
  type CloudProjectRepoListSource,
  type RepoFingerprint,
} from '@canopy/protocol/memory-sync';

/*
 * A local workspace as cloud project identity sees it (CAN-5190, contract
 * sections 21.2 to 21.4): its repositories' fingerprints, its root, and who
 * owns its repository list (D10). Pure: the host reads Git remotes and
 * `canopy.json` and passes them in.
 */

export interface LocalRepositoryInput {
  /** The repository's `origin` URL, or null when it has none. */
  remote: string | null;
  /** The repository's name in the workspace, for its checkout directory. */
  name: string;
  /** The `canopy.json` repo `id`, when `canopy.json` lists the repository. */
  sourceKey: string | null;
  /** Whether this device has the repository checked out. */
  cloned: boolean;
}

export interface LocalProjectInput {
  workspaceId: string;
  name: string;
  type: 'single-repo' | 'multi-repo';
  /** A multi-repository workspace's source repository at its root. */
  root: LocalRepositoryInput | null;
  /** Whether the root's `canopy.json` lists the repositories. */
  rootListsRepositories: boolean;
  repositories: readonly LocalRepositoryInput[];
}

export interface LocalRepository {
  fingerprint: RepoFingerprint;
  name: string;
  sourceKey: string | null;
  root: boolean;
  cloned: boolean;
}

export interface LocalProject {
  workspaceId: string;
  name: string;
  topology: 'single_repo' | 'multi_repo';
  repoListSource: CloudProjectRepoListSource;
  root: LocalRepository | null;
  /** Every repository with a remote, the root first when it has one. */
  repositories: LocalRepository[];
}

function fingerprintOf(remote: string | null): RepoFingerprint | null {
  if (remote === null) return null;
  const normalized = normalizeRepoRemote(remote);
  return normalized === null
    ? null
    : {
        remoteKey: normalized.remoteKey,
        provider: normalized.provider,
        providerRepoId: null,
      };
}

function localRepository(
  input: LocalRepositoryInput,
  root: boolean,
): LocalRepository | null {
  const fingerprint = fingerprintOf(input.remote);
  return fingerprint === null
    ? null
    : {
        fingerprint,
        name: input.name,
        sourceKey: input.sourceKey,
        root,
        cloned: input.cloned,
      };
}

export function describeLocalProject(input: LocalProjectInput): LocalProject {
  const root =
    input.type === 'multi-repo' && input.root !== null
      ? localRepository(input.root, true)
      : null;
  const repositories: LocalRepository[] = root === null ? [] : [root];
  for (const repository of input.repositories) {
    const local = localRepository(repository, false);
    if (
      local !== null &&
      !repositories.some((known) =>
        isSameRepository(known.fingerprint, local.fingerprint),
      )
    )
      repositories.push(local);
  }
  // D10: `canopy.json` owns the list when the root has a remote and lists
  // the repositories; otherwise the cloud manifest does.
  const canopyJson =
    root !== null &&
    input.rootListsRepositories &&
    repositories.every((repository) => repository.root || repository.sourceKey);
  return {
    workspaceId: input.workspaceId,
    name: input.name,
    topology: input.type === 'single-repo' ? 'single_repo' : 'multi_repo',
    repoListSource: canopyJson ? 'canopy_json' : 'cloud_manifest',
    root,
    repositories,
  };
}

/** Whether a workspace binds without asking: one repository with a remote. */
export function bindsAutomatically(local: LocalProject): boolean {
  return local.topology === 'single_repo' && local.repositories.length === 1;
}

export function matchRequestFor(local: LocalProject): CloudProjectMatchRequest {
  return {
    topology: local.topology,
    rootFingerprint: local.root?.fingerprint ?? null,
    repositories: local.repositories
      .filter((repository) => !repository.root)
      .map((repository) => repository.fingerprint),
  };
}

/**
 * The repository list a device publishes. With `canopy.json` owning it, the
 * local list replaces the manifest's. With the cloud manifest owning it, the
 * manifest keeps its order and every repository it lists (one this device
 * does not have is a selection, never a removal); this device's repositories
 * take their own entries' places and new ones are appended, so devices with
 * different repositories converge. Existing repositories keep their IDs and
 * directories. Only a checkout with a root sets root flags; one without
 * keeps the manifest's, even for the root repository it lists as a member.
 */
export function publishedRepositories(
  local: LocalProject,
  manifest: CloudProjectManifest | null,
): CloudProjectRepositoryDraft[] {
  type ManifestRepository = CloudProjectManifest['repositories'][number];
  type Entry =
    | { kind: 'local'; repository: LocalRepository; known?: ManifestRepository }
    | { kind: 'kept'; known: ManifestRepository };
  const existing = manifest?.repositories ?? [];
  const knownFor = (
    repository: LocalRepository,
  ): ManifestRepository | undefined =>
    existing.find((candidate) =>
      isSameRepository(candidate.fingerprint, repository.fingerprint),
    );
  const localEntry = (repository: LocalRepository): Entry => {
    const known = knownFor(repository);
    return known === undefined
      ? { kind: 'local', repository }
      : { kind: 'local', repository, known };
  };
  const canopyJson = local.repoListSource === 'canopy_json';
  const entries: Entry[] =
    canopyJson || local.topology === 'single_repo'
      ? [
          ...local.repositories.filter((repository) => repository.root),
          ...local.repositories.filter((repository) => !repository.root),
        ].map(localEntry)
      : [
          ...existing.map((known): Entry => {
            const repository = local.repositories.find((candidate) =>
              isSameRepository(candidate.fingerprint, known.fingerprint),
            );
            return repository === undefined
              ? { kind: 'kept', known }
              : { kind: 'local', repository, known };
          }),
          ...local.repositories
            .filter((repository) => knownFor(repository) === undefined)
            .map(localEntry),
        ];
  const directories = cloudProjectDirectoryNames(
    entries.map((entry) => ({
      preferred: entry.known?.directoryName ?? null,
      fallback:
        entry.kind === 'local'
          ? entry.repository.name
          : entry.known.directoryName,
      key:
        entry.kind === 'local'
          ? entry.repository.fingerprint.remoteKey
          : entry.known.fingerprint.remoteKey,
    })),
  );
  const root = (entry: Entry): boolean =>
    local.root === null
      ? isManifestRoot(manifest, entry.known)
      : entry.kind === 'local' && entry.repository.root;
  return entries.map((entry, index): CloudProjectRepositoryDraft => {
    const directoryName = directories[index] ?? 'repository';
    if (entry.kind === 'kept')
      return {
        repositoryId: entry.known.repositoryId,
        sourceKey: null,
        fingerprint: entry.known.fingerprint,
        defaultBranch: entry.known.defaultBranch,
        directoryName,
        root: root(entry),
      };
    return {
      repositoryId: entry.known?.repositoryId ?? null,
      sourceKey: canopyJson ? entry.repository.sourceKey : null,
      fingerprint: entry.repository.fingerprint,
      defaultBranch: entry.known?.defaultBranch ?? null,
      directoryName,
      root: root(entry),
    };
  });
}

function isManifestRoot(
  manifest: CloudProjectManifest | null,
  repository: { repositoryId: string } | undefined,
): boolean {
  return (
    manifest !== null &&
    repository !== undefined &&
    manifest.rootRepositoryId === repository.repositoryId
  );
}

/**
 * Only a project of the workspace's topology takes its list or its device's
 * selection: the server keeps a project's topology, so a multi-repository
 * list never fits a single-repository project, and a single repository's
 * list would replace a multi-repository project's.
 */
export function fitsTopology(
  local: LocalProject,
  manifest: CloudProjectManifest,
): boolean {
  return manifest.topology === local.topology;
}

/**
 * The checkout as `manifest`'s project sees it (D10). The manifest's root
 * repository is the project's root; a checkout of another root is, for this
 * project, a checkout with no root, whose own root repository and
 * `canopy.json` list are not the project's. A project with no root yet takes
 * this checkout's.
 */
function asCheckoutOf(
  local: LocalProject,
  manifest: CloudProjectManifest,
): LocalProject {
  const projectRoot = manifest.repositories.find(
    (repository) => repository.repositoryId === manifest.rootRepositoryId,
  );
  if (
    local.root === null ||
    projectRoot === undefined ||
    isSameRepository(projectRoot.fingerprint, local.root.fingerprint)
  )
    return local;
  return {
    ...local,
    repoListSource: 'cloud_manifest',
    root: null,
    repositories: local.repositories.filter((repository) => !repository.root),
  };
}

export interface PublishedList {
  repoListSource: CloudProjectRepoListSource;
  repositories: CloudProjectRepositoryDraft[];
}

/**
 * D10, the one rule for every repository list a checkout writes: the list it
 * creates a project with (`manifest` null), or the list it replaces
 * `manifest`'s with, null when it writes none.
 *
 * - A project of the other topology takes nothing.
 * - A list `canopy.json` owns is written only by a checkout of the project's
 *   root repository, whose `canopy.json` decides: from that list, or handed
 *   back to the cloud manifest once it stops listing repositories. Any other
 *   checkout, with no root or another root, only reads it, even when its own
 *   `canopy.json` lists repositories.
 * - A list the cloud manifest owns takes every checkout's repositories, and
 *   becomes `canopy.json`'s only from the project's root (or the first root a
 *   project without one gets). A checkout of another root never moves the
 *   root, so two roots never take turns rewriting it.
 */
export function listToPublish(
  local: LocalProject,
  manifest: null,
): PublishedList;
export function listToPublish(
  local: LocalProject,
  manifest: CloudProjectManifest,
): PublishedList | null;
export function listToPublish(
  local: LocalProject,
  manifest: CloudProjectManifest | null,
): PublishedList | null {
  if (manifest === null)
    return {
      repoListSource: local.repoListSource,
      repositories: publishedRepositories(local, null),
    };
  if (!fitsTopology(local, manifest)) return null;
  const checkout = asCheckoutOf(local, manifest);
  if (manifest.repoListSource === 'canopy_json' && checkout.root === null)
    return null;
  const repositories = publishedRepositories(checkout, manifest);
  return repositoriesDiffer(manifest, repositories, checkout)
    ? { repoListSource: checkout.repoListSource, repositories }
    : null;
}

/**
 * Whether `checkout` publishing `drafts` would change the manifest's
 * repository list. `canopy.json` orders its list, so order counts there; a
 * cloud manifest's order is its own, so only its entries count. Root flags
 * count only from a checkout with a root, the only one that sets them.
 */
export function repositoriesDiffer(
  manifest: CloudProjectManifest,
  drafts: readonly CloudProjectRepositoryDraft[],
  checkout: Pick<LocalProject, 'repoListSource' | 'root'>,
): boolean {
  const { repoListSource } = checkout;
  if (manifest.repoListSource !== repoListSource) return true;
  if (manifest.repositories.length !== drafts.length) return true;
  const same = (
    current: CloudProjectManifest['repositories'][number] | undefined,
    draft: CloudProjectRepositoryDraft,
  ): boolean =>
    current !== undefined &&
    current.repositoryId === draft.repositoryId &&
    current.fingerprint.remoteKey === draft.fingerprint.remoteKey &&
    current.sourceKey === draft.sourceKey &&
    current.directoryName === draft.directoryName &&
    (checkout.root === null ||
      isManifestRoot(manifest, current) === draft.root);
  if (repoListSource === 'canopy_json')
    return drafts.some(
      (draft, index) => !same(manifest.repositories[index], draft),
    );
  return drafts.some(
    (draft) =>
      !same(
        manifest.repositories.find(
          (current) => current.repositoryId === draft.repositoryId,
        ),
        draft,
      ),
  );
}
