import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  cloudProjectDirectoryNames,
  isSameRepository,
  normalizeRepoRemote,
  type CloudProjectBinding,
  type CloudProjectManifest,
  type CloudProjectRepository,
  type RepoFingerprint,
} from '@canopy/protocol/memory-sync';
import { isCanopyJsonId } from '@canopy/protocol/canopy-json';
import { slugify, uniqueId } from '@canopy/core-runtime/node/identifiers';
import { ORG_PROJECT_CLAIM_CONFLICT_REASONS } from '@canopy/protocol/org-projects';
import type {
  CloudProjectSetupCatalog,
  CloudProjectSetupCatalogEntry,
  CloudProjectSetupErrorCode,
  CloudProjectSetupOptions,
  CloudProjectSetupProgress,
  CloudProjectSetupRequest,
  CloudProjectSetupResult,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type {
  WorkspaceCloudBindingCompare,
  WorkspaceCloudBindingSnapshot,
  WorkspaceOwnershipRecordStatus,
} from '../lib/worktree-record-decisions';
import {
  isConflict,
  isProjectGone,
  isProjectRedirected,
  redirectAfter,
  type BindingAccount,
  type CloudProjectBindingFailure,
  type ProjectRedirect,
} from './cloud-project-binding';
import type {
  CloudProjectClaim,
  CloudProjectClaimRequest,
  CloudProjectClient,
} from './cloud-project-client';
import { foldFeed, type FeedFold } from './cloud-project-feed';
import {
  BindingStop,
  createCloudProjectFence,
  type CloudProjectConsent,
  type CloudProjectFence,
  type CloudProjectSessionAccount,
  type FencedCloudProjectClient,
} from './cloud-project-fence';
import {
  parseProjectSetupJournal,
  repositoryPath,
  RESUMABLE_PHASES,
  type ProjectSetupJournal,
  type ProjectSetupPhase,
  type ProjectSetupRepository,
  type SetupClaim,
} from './project-setup-journal';

/*
 * Set up a cloud project on this device (CAN-5192, design section 23): the
 * user picks which of its repositories to clone, each is cloned with the
 * user's own Git credentials into a staging folder, promoted, indexed with
 * its `cloudBinding`, and this device's setup is completed with its
 * selection. Every step is journaled first (project-setup-journal.ts), so an
 * interrupted setup resumes or retires on the next launch.
 *
 * Nothing here clones on its own: only `start`, a user's choice, clones, and
 * only the repositories it names. A repository the project gains on another
 * device is offered (neither selected nor declined), never cloned.
 *
 * Every request goes through the consent fence (cloud-project-fence.ts),
 * which sends nothing once the setup's account is no longer signed in or the
 * Personal project list is no longer shared; the setup never holds the raw
 * client.
 *
 * No Electron imports: the host injects the client, Git, the filesystem and
 * the workspace writers.
 */

/**
 * Whether a Personal workspace here is bound to a cloud project:
 * `indeterminate` when the workspace index or a manifest could not be read,
 * so neither answer is proven.
 */
export type ProjectBindingLookup =
  | { status: 'bound'; workspaceId: string }
  | { status: 'unbound' }
  | { status: 'indeterminate' };

/**
 * What registering a workspace under its reserved ID came to: the workspace
 * the registration used, which a boundary that de-duplicates by repository
 * identity may answer under another ID than the one asked for, or
 * `identity-in-use` when another workspace holds the ID, with nothing written.
 */
export type WorkspaceRegistration =
  | { status: 'registered'; workspaceId: string }
  | { status: 'identity-in-use' };

/**
 * What releasing this setup's binding came to: `not-ours` when the workspace
 * holds no binding of this setup's to release, and `indeterminate` when the
 * manifest could not be read, so whether one is still live is unproven.
 */
type BindingRelease = 'released' | 'not-ours' | 'indeterminate';

export interface ProjectSetupWorkspaces {
  /**
   * Reserves a local workspace ID for a new project with this name through
   * the workspace creation boundary: no other creation takes it while the
   * hold lasts or while a setup journal names it. Release the hold once the
   * journal holds the ID, or when the setup ends before it.
   */
  reserveWorkspaceId(
    name: string,
  ): Promise<{ workspaceId: string; release(this: void): void }>;
  /** The Personal workspace bound to this cloud project under this account. */
  boundTo(projectId: string, accountId: string): Promise<ProjectBindingLookup>;
  /**
   * Whether the workspace index still has this workspace. An index that
   * cannot be read rejects.
   */
  exists(workspaceId: string): Promise<boolean>;
  /**
   * The workspace's owner and cloud binding as its manifest holds them, or
   * null when it has no manifest. A manifest that cannot be read rejects.
   */
  binding(
    workspaceId: string,
  ): Promise<Pick<
    WorkspaceCloudBindingSnapshot,
    'owner' | 'cloudBinding'
  > | null>;
  /**
   * Registers the single repository's workspace. A boundary that
   * de-duplicates by repository identity answers the workspace that already
   * tracks the checkout, so the registration reports the ID it used rather
   * than the one asked for.
   */
  createSingle(input: {
    path: string;
    localWorkspaceId: string;
    name: string;
  }): Promise<WorkspaceRegistration>;
  createMulti(input: {
    path: string;
    localWorkspaceId: string;
    name: string;
    repositories: WorkspaceConfigFile['repos'];
    suppressedRepoIds: string[];
    idempotencyKey: string;
  }): Promise<WorkspaceRegistration>;
  writeBinding(
    workspaceId: string,
    compare: WorkspaceCloudBindingCompare,
  ): Promise<WorkspaceOwnershipRecordStatus>;
}

export interface ProjectSetupDeps extends CloudProjectConsent {
  /** The raw routes: the setup reaches them only through the consent fence. */
  client: CloudProjectClient;
  account(): Promise<BindingAccount>;
  device(): Promise<{ deviceId: string; installationGeneration: number }>;
  journals: {
    /**
     * Every journal file: its JSON under its file name, or only the name
     * when it could not be read or is not JSON. A folder that cannot be
     * listed rejects.
     */
    list(): Promise<{
      found: { name: string; value: unknown }[];
      unreadable: string[];
    }>;
    write(journal: ProjectSetupJournal): Promise<void>;
    remove(journalId: string): Promise<void>;
  };
  /** Reads reject when the disk cannot answer, never report a missing path. */
  fs: {
    exists(path: string): Promise<boolean>;
    mkdir(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    /** Remove a folder this setup created, and nothing else. */
    removeOwned(path: string): Promise<void>;
    isGitCheckout(path: string): Promise<boolean>;
    /** Keep the nested repositories out of a cloned root's status. */
    excludeNested(rootPath: string): Promise<void>;
    /**
     * Creates `relativePath` under `root` as a new, empty folder, and the
     * missing folders on the way. False, creating nothing more, when
     * something is already there or a folder on the way is a link or
     * resolves outside `root`.
     */
    createInside(root: string, relativePath: string): Promise<boolean>;
    /**
     * Whether `root` and every folder down to `relativePath` are real
     * folders, none of them a link, that resolve inside `root`.
     */
    isInside(root: string, relativePath: string | null): Promise<boolean>;
  };
  git: {
    clone(
      url: string,
      destination: string,
      options: { onProgress: (percent: number) => void },
    ): Promise<void>;
    /** A local root repository for a remote-less project. */
    initRoot(path: string, name: string): Promise<void>;
    /** Null only when Git confirms there is no origin; a failed read rejects. */
    remote(path: string): Promise<string | null>;
  };
  cloneUrl(fingerprint: RepoFingerprint): Promise<string>;
  /** Why a clone failed: the user's Git credentials, or anything else. */
  cloneFailure(
    url: string,
    error: unknown,
  ): 'needs-credentials' | 'clone-failed';
  workspaces: ProjectSetupWorkspaces;
  defaultDestination(): Promise<string | null>;
  progress(event: CloudProjectSetupProgress): void;
  /** CAN-5191: pull the project's memory once its workspace is bound. */
  afterSetup(input: {
    workspaceId: string;
    projectId: string;
    accountId: string;
  }): Promise<void>;
  failure(error: unknown): CloudProjectBindingFailure;
  now(): Date;
  randomUUID(): string;
}

const NESTED_DIRECTORY = 'repos';
/** Redirects one completion may follow before it gives up. */
const REDIRECTS_MAX = 4;

/** Whether a setup's claim was ended, and until then where a redirect leads. */
interface ClaimFate {
  ended: boolean;
  redirect: ProjectRedirect | null;
}

/**
 * The account a setup runs for, and the fenced client that sends every
 * request under that account's credential.
 */
interface SetupSession {
  accountId: string;
  cloud: FencedCloudProjectClient;
}

/**
 * What a setup does with a claim refused `409 conflict`, by the reason its
 * body names (§21.8): a setup limit stops with `setup-limit`, another
 * checkout of this installation holding the project is `busy`, and a
 * released claim or a key used for another request is claimed once more
 * under a fresh key. A missing reason, or one this build does not know,
 * fails closed. Null when the failure is not a claim conflict.
 */
type ClaimConflict = 'limit' | 'held' | 'fresh-key' | 'refused';

function claimConflict(
  failure: CloudProjectBindingFailure,
): ClaimConflict | null {
  if (!isConflict(failure)) return null;
  switch (failure.reason) {
    case ORG_PROJECT_CLAIM_CONFLICT_REASONS.instanceLimit:
    case ORG_PROJECT_CLAIM_CONFLICT_REASONS.projectInstanceLimit:
    case ORG_PROJECT_CLAIM_CONFLICT_REASONS.claimAliasLimit:
      return 'limit';
    case ORG_PROJECT_CLAIM_CONFLICT_REASONS.checkoutConflict:
      return 'held';
    case ORG_PROJECT_CLAIM_CONFLICT_REASONS.claimInvalid:
    case ORG_PROJECT_CLAIM_CONFLICT_REASONS.idempotencyMismatch:
      return 'fresh-key';
    default:
      return 'refused';
  }
}

/** Why a setup can stop and wait for the user. */
type UserStop = 'checkout-changed' | 'workspace-id-in-use';
const USER_STOPS: readonly UserStop[] = [
  'checkout-changed',
  'workspace-id-in-use',
];

/**
 * Why a setup stopped and waits for the user, or null when it does not: its
 * checkouts changed after validation (`checkout-changed`), or another
 * workspace holds its workspace ID (`workspace-id-in-use`). Such a journal is
 * kept, and the project listed as needing attention, until the user sets it
 * up again.
 */
function stoppedFor(journal: ProjectSetupJournal): UserStop | null {
  if (journal.phase !== 'failed') return null;
  return USER_STOPS.find((code) => code === journal.errorCode) ?? null;
}

/** Why a journaled checkout is not the one the setup cloned. */
type CheckoutMismatch = 'outside' | 'not-checkout' | 'other-repository';

class SetupStop extends Error {
  constructor(readonly code: CloudProjectSetupErrorCode) {
    super(code);
    this.name = 'SetupStop';
  }
}

/** What the workspace's `suppressedRepoIds` holds for a declined repository. */
function declinedId(
  repository: Pick<CloudProjectRepository, 'sourceKey' | 'repositoryId'>,
): string {
  return repository.sourceKey ?? repository.repositoryId;
}

/** What the workspace's `suppressedRepoIds` holds for the declined repositories. */
function declinedIds(journal: ProjectSetupJournal): string[] {
  return journal.declined.map(declinedId);
}

function claimOf(journal: ProjectSetupJournal): SetupClaim {
  return {
    projectId: journal.projectId,
    instanceId: journal.instanceId,
    fencingGeneration: journal.fencingGeneration,
  };
}

function sameClaim(left: SetupClaim, right: SetupClaim): boolean {
  return (
    left.projectId === right.projectId &&
    left.instanceId === right.instanceId &&
    left.fencingGeneration === right.fencingGeneration
  );
}

/**
 * Whether the workspace's binding is one this setup wrote: its account, and
 * a claim the journal holds (its own, the one it last bound, or the one a
 * redirect moved it from). A binding from any later claim is not its to
 * change; the setup that held it is over.
 */
function holdsBinding(
  journal: ProjectSetupJournal,
  current: Pick<WorkspaceCloudBindingSnapshot, 'owner' | 'cloudBinding'>,
): boolean {
  const binding = current.cloudBinding;
  if (
    current.owner !== undefined ||
    binding === undefined ||
    binding.accountId !== journal.accountId ||
    binding.ownerType !== 'user'
  )
    return false;
  const named: SetupClaim = {
    projectId: binding.projectId,
    instanceId: binding.instanceId,
    fencingGeneration: binding.bindingGeneration,
  };
  return [claimOf(journal), journal.bound, journal.rebinding].some(
    (claim) => claim !== undefined && sameClaim(claim, named),
  );
}

/**
 * Whether the picked repositories can name local ones. A nested repository's
 * canopy.json id is its local repository ID, which names its folder in every
 * worktree of the project, so it must be one canopy.json accepts, and no two
 * nested repositories may share it.
 */
function namesLocalRepositories(
  picked: readonly CloudProjectRepository[],
  nested: readonly CloudProjectRepository[],
): boolean {
  const ids = nested.flatMap((repository) =>
    repository.sourceKey === null ? [] : [repository.sourceKey],
  );
  return (
    picked.every(
      (repository) =>
        repository.sourceKey === null || isCanopyJsonId(repository.sourceKey),
    ) && new Set(ids).size === ids.length
  );
}

/** The most of a directory name's slug a made repository ID keeps. */
const MADE_ID_BASE_LENGTH = 120;

/**
 * Each nested repository's ID in the workspace, by repository ID: its
 * canopy.json id, else one the ID validator accepts made from its directory
 * name. An ID never repeats, and never takes an ID the project's canopy.json
 * ids or the declined repositories' suppressed IDs name. Its directory name
 * stays its clone folder. A made ID keeps at most {@link MADE_ID_BASE_LENGTH}
 * characters of the name, so with a `-<n>` suffix it still fits the
 * journal's 128.
 */
function localRepoIds(
  manifest: CloudProjectManifest,
  nested: readonly CloudProjectRepository[],
  suppressed: readonly string[],
): Map<string, string> {
  const taken = new Set<string>(suppressed);
  for (const repository of manifest.repositories)
    if (repository.sourceKey !== null) taken.add(repository.sourceKey);
  const ids = new Map<string, string>();
  for (const repository of nested) {
    let id = repository.sourceKey;
    if (id === null) {
      const base = slugify(repository.directoryName)
        .slice(0, MADE_ID_BASE_LENGTH)
        .replace(/-+$/, '');
      id = uniqueId(base || 'repo', taken);
      taken.add(id);
    }
    ids.set(repository.repositoryId, id);
  }
  return ids;
}

function sameFingerprint(
  remote: string | null,
  fingerprint: RepoFingerprint,
): boolean {
  return (
    remote !== null &&
    normalizeRepoRemote(remote)?.remoteKey === fingerprint.remoteKey
  );
}

export class CloudProjectSetup {
  private readonly running = new Set<string>();
  private readonly deps: Omit<ProjectSetupDeps, 'client'>;
  private readonly consent: CloudProjectFence;

  constructor({ client, ...deps }: ProjectSetupDeps) {
    this.deps = deps;
    this.consent = createCloudProjectFence(client, deps);
  }

  private open(account: CloudProjectSessionAccount): SetupSession {
    return { accountId: account.accountId, cloud: this.consent.open(account) };
  }

  /** A failure as the setup reads it; a fence stop is never transient. */
  private failure(error: unknown): CloudProjectBindingFailure {
    return error instanceof BindingStop
      ? { transient: false }
      : this.deps.failure(error);
  }

  /** The account's cloud projects, and which of them this device has. */
  async catalog(): Promise<CloudProjectSetupCatalog> {
    const account = await this.deps.account();
    if (!account.ok) return { status: 'unavailable', reason: account.reason };
    if (!account.sharing)
      return { status: 'unavailable', reason: 'sharing-off' };
    let list;
    try {
      list = await this.open(account).cloud.list(await this.deps.device());
    } catch (error) {
      if (error instanceof BindingStop)
        return { status: 'unavailable', reason: 'sharing-off' };
      if (this.failure(error).transient)
        return { status: 'unavailable', reason: 'offline' };
      throw error;
    }
    const journals = await this.readJournals();
    const pending = new Set(journals.map((journal) => journal.projectId));
    const stopped = new Map(
      journals.flatMap((journal) => {
        const code = stoppedFor(journal);
        return code === null ? [] : [[journal.projectId, code] as const];
      }),
    );
    const projects: CloudProjectSetupCatalogEntry[] = [];
    for (const entry of list.projects) {
      if (entry.kind !== 'code') continue;
      const lookup = await this.deps.workspaces.boundTo(
        entry.projectId,
        account.accountId,
      );
      const workspaceId = lookup.status === 'bound' ? lookup.workspaceId : null;
      const decided =
        (entry.instance?.selectedRepositoryIds.length ?? 0) +
        (entry.instance?.dismissedRepositoryIds.length ?? 0);
      const errorCode = stopped.get(entry.projectId);
      projects.push({
        projectId: entry.projectId,
        name: entry.name,
        topology: entry.topology,
        repositoryCount: entry.repositoryCount,
        state:
          errorCode !== undefined
            ? 'needs-attention'
            : pending.has(entry.projectId)
              ? 'setting-up'
              : workspaceId !== null
                ? 'here'
                : 'available',
        ...(errorCode === undefined ? {} : { errorCode }),
        workspaceId,
        offeredRepositoryCount:
          workspaceId !== null && entry.instance !== null
            ? Math.max(0, entry.repositoryCount - decided)
            : 0,
      });
    }
    return { status: 'ok', projects };
  }

  /** What the repository picker offers for one project. */
  async options(projectId: string): Promise<CloudProjectSetupOptions> {
    const account = await this.deps.account();
    if (!account.ok || !account.sharing)
      return { status: 'unavailable', reason: 'unavailable' };
    let manifest: CloudProjectManifest;
    try {
      manifest = await this.open(account).cloud.manifest(projectId);
    } catch (error) {
      if (error instanceof BindingStop)
        return { status: 'unavailable', reason: 'unavailable' };
      const failure = this.failure(error);
      return {
        status: 'unavailable',
        reason: failure.transient ? 'offline' : 'project-unavailable',
      };
    }
    if (manifest.kind !== 'code' || manifest.repositories.length === 0)
      return { status: 'unavailable', reason: 'project-unavailable' };
    return {
      status: 'ok',
      projectId: manifest.projectId,
      name: manifest.name,
      topology: manifest.topology,
      repositories: manifest.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        name: repository.directoryName,
        remoteKey: repository.fingerprint.remoteKey,
        root: repository.repositoryId === manifest.rootRepositoryId,
      })),
      destinationRoot: await this.deps.defaultDestination(),
    };
  }

  /** Set the project up with the repositories the user picked. */
  async start(
    request: CloudProjectSetupRequest,
  ): Promise<CloudProjectSetupResult> {
    if (this.running.has(request.projectId)) return { ok: false, code: 'busy' };
    this.running.add(request.projectId);
    let journal: ProjectSetupJournal | null = null;
    let session: SetupSession | null = null;
    try {
      const account = await this.deps.account();
      if (!account.ok || !account.sharing) throw new SetupStop('unavailable');
      session = this.open(account);
      if (await this.resumeProject(request.projectId))
        throw new SetupStop('busy');
      journal = await this.prepare(request, session);
      return { ok: true, workspaceId: await this.run(journal, session) };
    } catch (error) {
      const code = this.codeFor(error);
      if (journal !== null && session !== null)
        await this.fail(journal, code, session);
      return { ok: false, code };
    } finally {
      this.running.delete(request.projectId);
    }
  }

  /**
   * The launch sweep: finish every setup that reached its promoted folder,
   * retire the rest. It never clones. Answers the journal files it could not
   * read: nothing in one can be trusted to retire it, so it stays where it
   * is for the host to report.
   */
  async resumeAll(): Promise<{ unreadable: string[] }> {
    const { journals, unreadable } = await this.journalFiles();
    for (const journal of journals) {
      if (this.running.has(journal.projectId)) continue;
      this.running.add(journal.projectId);
      try {
        await this.resume(journal);
      } catch {
        // Kept for the next launch.
      } finally {
        this.running.delete(journal.projectId);
      }
    }
    return { unreadable };
  }

  /** Settles this project's earlier setups; true when one is still open. */
  private async resumeProject(projectId: string): Promise<boolean> {
    for (const journal of await this.readJournals())
      if (journal.projectId === projectId) await this.resume(journal, true);
    return (await this.readJournals()).some(
      (journal) => journal.projectId === projectId,
    );
  }

  private async readJournals(): Promise<ProjectSetupJournal[]> {
    return (await this.journalFiles()).journals;
  }

  /**
   * The journals that parse under their own file name, and the names of the
   * rest. A journal under another name is not trusted: removing it by its
   * id would leave the file behind.
   */
  private async journalFiles(): Promise<{
    journals: ProjectSetupJournal[];
    unreadable: string[];
  }> {
    const { found, unreadable } = await this.deps.journals.list();
    const journals: ProjectSetupJournal[] = [];
    const rejected = [...unreadable];
    for (const { name, value } of found) {
      const journal = parseProjectSetupJournal(value);
      if (journal !== null && name === `${journal.journalId}.json`)
        journals.push(journal);
      else rejected.push(name);
    }
    return { journals, unreadable: rejected.sort() };
  }

  private async prepare(
    request: CloudProjectSetupRequest,
    session: SetupSession,
  ): Promise<ProjectSetupJournal> {
    const { accountId } = session;
    await this.requireUnbound(request.projectId, accountId);
    const device = await this.deps.device();
    const manifest = await session.cloud.manifest(request.projectId);
    if (manifest.kind !== 'code') throw new SetupStop('project-unavailable');
    const picked = new Set(request.repositoryIds);
    const repositories = manifest.repositories.filter((repository) =>
      picked.has(repository.repositoryId),
    );
    const root = manifest.repositories.find(
      (repository) => repository.repositoryId === manifest.rootRepositoryId,
    );
    if (
      repositories.length === 0 ||
      repositories.length !== picked.size ||
      (root !== undefined && !picked.has(root.repositoryId)) ||
      (manifest.topology === 'single_repo' && repositories.length !== 1)
    )
      throw new SetupStop('invalid-selection');
    const single = manifest.topology === 'single_repo';
    if (
      !namesLocalRepositories(
        repositories,
        single ? [] : repositories.filter((repository) => repository !== root),
      )
    )
      throw new SetupStop('project-unavailable');
    const folder =
      cloudProjectDirectoryNames([
        {
          preferred: single ? (repositories[0]?.directoryName ?? null) : null,
          fallback: manifest.name,
        },
      ])[0] ?? 'project';
    const finalPath = join(request.destinationRoot, folder);
    if (await this.deps.fs.exists(finalPath))
      throw new SetupStop('destination-exists');

    // A setup of this installation whose workspace is gone blocks a new one.
    const listed = (await session.cloud.list(device)).projects.find(
      (entry) => entry.projectId === manifest.projectId,
    );
    if (listed?.instance) {
      await this.requireUnbound(manifest.projectId, accountId);
      await session.cloud
        .detach(listed.instance.instanceId, undefined)
        .catch((): void => {});
    }

    const reservation = await this.deps.workspaces.reserveWorkspaceId(
      manifest.name,
    );
    const localWorkspaceId = reservation.workspaceId;
    try {
      const journalId = this.deps.randomUUID();
      const attemptNonce = this.deps.randomUUID();
      const setupKey = (nonce: string): string =>
        createHash('sha256')
          .update(
            `cloud-project-setup:${accountId}:${device.deviceId}:${manifest.projectId}:${nonce}`,
          )
          .digest('hex');
      const { claim, idempotencyKey } = await this.claimOnce(
        session,
        manifest.projectId,
        {
          deviceId: device.deviceId,
          installationGeneration: device.installationGeneration,
          localWorkspaceId,
        },
        setupKey(attemptNonce),
        () => setupKey(this.deps.randomUUID()),
      );
      const layout: ProjectSetupJournal['root'] = single
        ? 'none'
        : root !== undefined
          ? 'cloned'
          : 'generated';
      const ordered = [
        ...(root === undefined ? [] : [root]),
        ...repositories.filter((repository) => repository !== root),
      ];
      const declined = manifest.repositories
        .filter((repository) => !picked.has(repository.repositoryId))
        .map((repository) => ({
          repositoryId: repository.repositoryId,
          sourceKey: repository.sourceKey,
          fingerprint: repository.fingerprint,
        }));
      const repoIds = localRepoIds(
        manifest,
        layout === 'none'
          ? []
          : ordered.filter((repository) => repository !== root),
        declined.map(declinedId),
      );
      const journal: ProjectSetupJournal = {
        version: 1,
        journalId,
        accountId,
        deviceId: device.deviceId,
        installationGeneration: device.installationGeneration,
        projectId: manifest.projectId,
        projectName: manifest.name,
        topology: manifest.topology,
        repoListSource: manifest.repoListSource,
        manifestRevision: manifest.revision,
        instanceId: claim.instanceId,
        operationId: claim.operationId,
        fencingGeneration: claim.fencingGeneration,
        ...(claim.eventsCursor === undefined
          ? {}
          : { eventsCursor: claim.eventsCursor }),
        attemptNonce,
        idempotencyKey,
        localWorkspaceId,
        destinationRoot: request.destinationRoot,
        finalPath,
        stagingPath: join(
          request.destinationRoot,
          `.canopy-setup-${journalId}`,
        ),
        root: layout,
        repositories: ordered.map(
          (repository): ProjectSetupRepository => ({
            repositoryId: repository.repositoryId,
            fingerprint: repository.fingerprint,
            directoryName: repository.directoryName,
            sourceKey: repository.sourceKey,
            localRepoId: repoIds.get(repository.repositoryId) ?? null,
            relativePath:
              layout === 'none' || repository === root
                ? null
                : join(NESTED_DIRECTORY, repository.directoryName),
            cloned: false,
          }),
        ),
        declined,
        phase: 'claimed',
        updatedAt: this.deps.now().toISOString(),
      };
      if (layout !== 'none') journal.suppressed = declinedIds(journal);
      await this.checkpoint(journal, 'claimed');
      return journal;
    } finally {
      // The journal holds the ID from here, or the setup never claimed it.
      reservation.release();
    }
  }

  /**
   * Stops unless the workspaces prove no Personal workspace here is bound to
   * the project: one that is, or a lookup that could not read them, would
   * have this setup release a checkout still in use.
   */
  private async requireUnbound(
    projectId: string,
    accountId: string,
  ): Promise<void> {
    const lookup = await this.deps.workspaces.boundTo(projectId, accountId);
    if (lookup.status === 'bound') throw new SetupStop('already-here');
    if (lookup.status === 'indeterminate') throw new SetupStop('setup-failed');
  }

  private async checkpoint(
    journal: ProjectSetupJournal,
    phase: ProjectSetupPhase,
    errorCode?: CloudProjectSetupErrorCode,
  ): Promise<ProjectSetupJournal> {
    const next: ProjectSetupJournal = {
      ...journal,
      phase,
      ...(errorCode === undefined ? {} : { errorCode }),
      updatedAt: this.deps.now().toISOString(),
    };
    await this.deps.journals.write(next);
    Object.assign(journal, next);
    return journal;
  }

  private report(
    journal: ProjectSetupJournal,
    event: Partial<CloudProjectSetupProgress> = {},
  ): void {
    this.deps.progress({
      projectId: journal.projectId,
      phase: journal.phase,
      state: 'running',
      ...event,
    });
  }

  /**
   * Refuses a workspace or `cloudBinding` write once another account is
   * signed in or the Personal project list is no longer shared: the check
   * every request makes, read again each time.
   */
  private async fence(session: SetupSession): Promise<void> {
    await this.consent.require(session.accountId);
  }

  /** Clone, validate, promote, then finish. */
  private async run(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<string> {
    await this.deps.fs.mkdir(journal.stagingPath);
    await this.checkpoint(journal, 'cloning');
    if (journal.root === 'generated') {
      await this.requireInside(journal.stagingPath, null);
      await this.deps.git.initRoot(journal.stagingPath, journal.projectName);
    }
    const total = journal.repositories.length;
    for (const [index, repository] of journal.repositories.entries()) {
      this.report(journal, {
        repository: { index, count: total, name: repository.directoryName },
      });
      // The root clone is the folder this setup made; a nested one goes into
      // a new folder made here, after the root's own content is on disk.
      if (repository.relativePath === null)
        await this.requireInside(journal.stagingPath, null);
      else if (
        !(await this.deps.fs.createInside(
          journal.stagingPath,
          repository.relativePath,
        ))
      )
        throw new SetupStop('checkout-blocked');
      const url = await this.deps.cloneUrl(repository.fingerprint);
      try {
        await this.deps.git.clone(
          url,
          repositoryPath(journal, repository, 'staging'),
          {
            onProgress: (percent): void =>
              this.report(journal, {
                repository: {
                  index,
                  count: total,
                  name: repository.directoryName,
                },
                percent,
              }),
          },
        );
      } catch (error) {
        throw new SetupStop(this.deps.cloneFailure(url, error));
      }
      await this.requireInside(journal.stagingPath, repository.relativePath);
      repository.cloned = true;
      await this.checkpoint(journal, 'cloning');
    }
    const staged = await this.verifyCheckouts(journal, 'staging');
    if (staged !== null)
      throw new SetupStop(
        staged === 'outside' ? 'checkout-blocked' : 'clone-failed',
      );
    if (journal.root === 'cloned')
      await this.deps.fs.excludeNested(journal.stagingPath);
    await this.checkpoint(journal, 'validated');
    if (await this.deps.fs.exists(journal.finalPath))
      throw new SetupStop('destination-exists');
    await this.checkpoint(journal, 'promoted');
    await this.deps.fs.rename(journal.stagingPath, journal.finalPath);
    return this.finish(journal, session);
  }

  /**
   * From the promoted folder on: index, bind, complete, select. The promoted
   * checkouts are verified first, on the first run and on every resume, so a
   * folder changed since validation is never indexed, bound or published.
   */
  private async finish(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<string> {
    if ((await this.verifyCheckouts(journal, 'final')) !== null)
      await this.stopForUser(journal, session, 'checkout-changed');
    if (journal.phase === 'promoted') {
      await this.checkpoint(journal, 'bound');
      this.report(journal);
    }
    if (journal.phase === 'bound') {
      await this.bind(journal, session);
      await this.checkpoint(journal, 'completing');
      this.report(journal);
    }
    await this.complete(journal, session);
    await this.checkpoint(journal, 'done');
    await this.deps.journals.remove(journal.journalId);
    this.deps.progress({
      projectId: journal.projectId,
      phase: 'done',
      state: 'done',
      workspaceId: journal.localWorkspaceId,
    });
    await this.deps
      .afterSetup({
        workspaceId: journal.localWorkspaceId,
        projectId: journal.projectId,
        accountId: journal.accountId,
      })
      .catch((): void => {});
    return journal.localWorkspaceId;
  }

  private async requireInside(
    root: string,
    relativePath: string | null,
  ): Promise<void> {
    if (!(await this.deps.fs.isInside(root, relativePath)))
      throw new SetupStop('checkout-blocked');
  }

  /**
   * What the first validation and every resume check in the project folder
   * before anything there is indexed, bound or published, or null when it
   * all holds: each journaled checkout is a real folder inside the project
   * folder through real folders only (`outside`), with its own `.git`
   * folder (`not-checkout`), whose origin is the URL this setup cloned or
   * the repository the journal names (`other-repository`). A generated root
   * must still be a checkout too.
   */
  private async verifyCheckouts(
    journal: ProjectSetupJournal,
    stage: 'staging' | 'final',
  ): Promise<CheckoutMismatch | null> {
    const base = stage === 'staging' ? journal.stagingPath : journal.finalPath;
    if (journal.root !== 'none') {
      if (!(await this.deps.fs.isInside(base, null))) return 'outside';
      if (!(await this.deps.fs.isGitCheckout(base))) return 'not-checkout';
    }
    for (const repository of journal.repositories) {
      if (!(await this.deps.fs.isInside(base, repository.relativePath)))
        return 'outside';
      const path = repositoryPath(journal, repository, stage);
      if (!(await this.deps.fs.isGitCheckout(path))) return 'not-checkout';
      const remote = await this.deps.git.remote(path);
      if (
        remote !== (await this.deps.cloneUrl(repository.fingerprint)) &&
        !sameFingerprint(remote, repository.fingerprint)
      )
        return 'other-repository';
    }
    return null;
  }

  /**
   * Stops a setup the user must look at (`UserStop`): nothing more is
   * indexed, bound or published, the binding this setup wrote is released,
   * the claim is released and the disk is left exactly as it is. The journal
   * keeps the failure, so the project shows as needing attention until the
   * user sets it up again, and the released binding lets that next setup
   * start (CAN-5192 round 6). A release that cannot be proven keeps the
   * journal at its phase instead, so a later pass stops it again rather than
   * recording a stop over a binding that may still be live.
   */
  private async stopForUser(
    journal: ProjectSetupJournal,
    session: SetupSession,
    code: UserStop,
  ): Promise<never> {
    if ((await this.detachBinding(journal, session)) === 'indeterminate')
      throw new SetupStop(code);
    await session.cloud
      .detach(journal.instanceId, journal)
      .catch((): void => {});
    await this.checkpoint(journal, 'failed', code);
    this.deps.progress({
      projectId: journal.projectId,
      phase: 'failed',
      state: 'failed',
      errorCode: code,
    });
    throw new SetupStop(code);
  }

  private async bind(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<void> {
    await this.refreshManifest(journal, session);
    await this.fence(session);
    let registration: WorkspaceRegistration;
    if (journal.root === 'none') {
      registration = await this.deps.workspaces.createSingle({
        path: journal.finalPath,
        localWorkspaceId: journal.localWorkspaceId,
        name: journal.projectName,
      });
    } else {
      if (journal.creation === undefined) {
        journal.creation = {
          path: journal.finalPath,
          localWorkspaceId: journal.localWorkspaceId,
          name: journal.projectName,
          repositories: journal.repositories.flatMap((repository) =>
            repository.localRepoId === null
              ? []
              : [
                  {
                    id: repository.localRepoId,
                    name: repository.directoryName,
                    repoPath: repositoryPath(journal, repository, 'final'),
                  },
                ],
          ),
          suppressedRepoIds: declinedIds(journal),
          idempotencyKey: `cloud-project-setup:${journal.instanceId}:${journal.fencingGeneration}`,
        };
        await this.checkpoint(journal, journal.phase);
      }
      registration = await this.deps.workspaces.createMulti(journal.creation);
    }
    // The claim names this ID, so the setup cannot move to another one: a
    // registration that answers another workspace, as a de-duplication by
    // repository identity does, stops the setup here. Binding on would write
    // to an ID no workspace holds, and leave the journal for every later
    // launch to try again (CAN-6060).
    if (
      registration.status === 'identity-in-use' ||
      registration.workspaceId !== journal.localWorkspaceId
    )
      await this.stopForUser(journal, session, 'workspace-id-in-use');
    await this.bindRecord(journal, session);
  }

  /**
   * Reads the manifest again and, when its revision moved since the journal
   * recorded it, takes the project's repositories as they are now: until a
   * device publishes the manifest, a registration from another device can
   * change them with no lifecycle event. A declined repository the project
   * no longer lists is dropped, and one it gained stays offered. Answers the
   * repositories listed now, or null when the manifest cannot be read: the
   * setup keeps its own view and the binding pass reads it again.
   */
  private async refreshManifest(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<ReadonlySet<string> | null> {
    let manifest: CloudProjectManifest;
    try {
      manifest = await session.cloud.manifest(journal.projectId);
    } catch (error) {
      if (error instanceof BindingStop) throw error;
      return null;
    }
    const listed = new Set(
      manifest.repositories.map((repository) => repository.repositoryId),
    );
    if (manifest.revision !== journal.manifestRevision) {
      journal.manifestRevision = manifest.revision;
      journal.repoListSource = manifest.repoListSource;
      journal.declined = journal.declined.filter((repository) =>
        listed.has(repository.repositoryId),
      );
      await this.checkpoint(journal, journal.phase);
    }
    return listed;
  }

  /**
   * Records the binding and, in the same write, the repositories declined
   * here, over no binding or one this setup wrote (`holdsBinding`). A
   * redirect's pending rebind (`rebinding`) names the binding this one takes
   * over; it is cleared only once this write lands. A binding another claim
   * wrote ends the setup: its journal goes, and the workspace stays as that
   * claim left it.
   */
  private async bindRecord(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<void> {
    const declined = journal.root === 'none' ? null : declinedIds(journal);
    const owned = new Set([
      ...(journal.suppressed ?? []),
      ...(journal.creation?.suppressedRepoIds ?? []),
    ]);
    // The binding follows the feed from the claim on, so it never replays
    // what came before, such as the detach of an earlier setup; a server
    // that predates the claim's position gets as far as the setup has read
    // the feed instead, its end unless the feed is longer than one read.
    const eventCursor =
      journal.eventsCursor ?? (await this.claimFate(journal, session)).cursor;
    const binding: CloudProjectBinding & {
      eventCursor?: string;
      name: string;
    } = {
      version: 1,
      projectId: journal.projectId,
      accountId: journal.accountId,
      ownerType: 'user',
      organizationId: null,
      instanceId: journal.instanceId,
      bindingGeneration: journal.fencingGeneration,
      boundAt: this.deps.now().toISOString(),
      manifestRevision: journal.manifestRevision,
      repoListSource: journal.repoListSource,
      name: journal.projectName,
      ...(eventCursor === null ? {} : { eventCursor }),
    };
    await this.fence(session);
    let superseded = false;
    const status = await this.deps.workspaces.writeBinding(
      journal.localWorkspaceId,
      (current) => {
        if (
          current.owner !== undefined ||
          (current.cloudBinding !== undefined &&
            !holdsBinding(journal, current))
        ) {
          superseded = true;
          return null;
        }
        if (declined === null) return { cloudBinding: binding };
        // The ids this setup recorded give way to the declined list as it is
        // now (a merge remaps them); ids the user added stay as they are.
        const kept = current.suppressedRepoIds.filter(
          (id) => !owned.has(id) || declined.includes(id),
        );
        return {
          cloudBinding: binding,
          suppressedRepoIds: [
            ...kept,
            ...declined.filter((id) => !kept.includes(id)),
          ],
        };
      },
    );
    if (superseded) return this.superseded(journal);
    if (status !== 'written') throw new SetupStop('setup-failed');
    delete journal.rebinding;
    journal.bound = claimOf(journal);
    if (declined !== null) journal.suppressed = declined;
    await this.checkpoint(journal, journal.phase);
  }

  /** Another claim holds the workspace's binding now: this setup is over. */
  private async superseded(journal: ProjectSetupJournal): Promise<never> {
    await this.deps.journals.remove(journal.journalId);
    throw new SetupStop('setup-failed');
  }

  /**
   * Stops a setup about to claim again once the workspace's binding is no
   * longer one it wrote: a reclaim would take the checkout from the claim
   * that holds it now.
   */
  private async requireBinding(journal: ProjectSetupJournal): Promise<void> {
    const current = await this.deps.workspaces.binding(
      journal.localWorkspaceId,
    );
    if (current === null || !holdsBinding(journal, current))
      await this.superseded(journal);
  }

  /** Whether the binding may still name an earlier claim than the journal's. */
  private bindingBehind(journal: ProjectSetupJournal): boolean {
    return (
      journal.rebinding !== undefined ||
      (journal.bound !== undefined &&
        !sameClaim(journal.bound, claimOf(journal)))
    );
  }

  private async complete(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<void> {
    const pending = journal.rebinding;
    if (
      pending !== undefined &&
      pending.instanceId === journal.instanceId &&
      pending.fencingGeneration === journal.fencingGeneration
    ) {
      // A redirect moved the setup before it claimed the project it led to.
      await this.reclaim(journal, session);
    } else {
      if (this.bindingBehind(journal)) await this.bindRecord(journal, session);
      await this.completeClaim(journal, session);
    }
    try {
      const listed = await this.refreshManifest(journal, session);
      const keep = (repositoryId: string): boolean =>
        listed === null || listed.has(repositoryId);
      const current = await session.cloud.selection(journal.instanceId);
      await session.cloud.updateSelection(journal.instanceId, {
        ...current,
        selectedRepositoryIds: journal.repositories
          .map((repository) => repository.repositoryId)
          .filter(keep),
        dismissedRepositoryIds: journal.declined
          .map((repository) => repository.repositoryId)
          .filter(keep),
      });
    } catch {
      // The binding pass publishes the selection again.
    }
  }

  private async completeClaim(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<void> {
    try {
      await session.cloud.complete(journal.instanceId, journal);
    } catch (error) {
      const failure = this.failure(error);
      // An offline completion is kept for the next launch, never detached.
      if (failure.transient) throw new SetupStop('completion-pending');
      if (isProjectGone(failure)) return this.projectGone(journal, session);
      if (!isConflict(failure)) throw error;
      const fate = await this.claimFate(journal, session);
      if (fate.state.ended) return this.projectGone(journal, session);
      // Whether the user detached the claim is not known yet: the next run
      // reads on through the feed before it claims again.
      if (!fate.complete) throw new SetupStop('completion-pending');
      await this.reclaim(journal, session);
    }
  }

  /**
   * The claim lapsed before completion (a long clone or an offline stretch):
   * claim the same checkout again, move the binding to the new fence, and
   * complete once more. As a bind does (CAN-5190): a redirect is followed to
   * the project its merged duplicate now is and claimed under that project's
   * own key, a released claim or a key used for another request is claimed
   * once more under a fresh key (a limit, a held checkout or a refusal with
   * no known reason stops), and a project the routes no longer find leaves
   * the workspace unbound. A claim the feed records as
   * detached is never claimed again: the user ended it.
   */
  private async reclaim(
    journal: ProjectSetupJournal,
    session: SetupSession,
    redirects = 0,
  ): Promise<void> {
    await this.requireBinding(journal);
    let claim: CloudProjectClaim;
    try {
      ({ claim } = await this.claimOnce(
        session,
        journal.projectId,
        {
          deviceId: journal.deviceId,
          installationGeneration: journal.installationGeneration,
          localWorkspaceId: journal.localWorkspaceId,
        },
        createHash('sha256')
          .update(
            `${journal.idempotencyKey}:reclaim:${journal.projectId}:${journal.fencingGeneration}`,
          )
          .digest('hex'),
        () => this.deps.randomUUID(),
      ));
    } catch (error) {
      const failure = this.failure(error);
      if (isProjectGone(failure)) return this.projectGone(journal, session);
      if (isProjectRedirected(failure)) {
        if (redirects >= REDIRECTS_MAX)
          throw new SetupStop('project-unavailable');
        if (!(await this.moveToRedirect(journal, session)))
          return this.projectGone(journal, session);
        return this.reclaim(journal, session, redirects + 1);
      }
      throw error;
    }
    if (claim.state !== 'CLAIMED' && claim.state !== 'READY')
      throw new SetupStop('setup-failed');
    journal.instanceId = claim.instanceId;
    journal.operationId = claim.operationId;
    journal.fencingGeneration = claim.fencingGeneration;
    if (claim.eventsCursor === undefined) delete journal.eventsCursor;
    else journal.eventsCursor = claim.eventsCursor;
    await this.checkpoint(journal, 'completing');
    await this.bindRecord(journal, session);
    if (claim.state === 'CLAIMED')
      await session.cloud.complete(journal.instanceId, journal);
  }

  /**
   * Claim under `idempotencyKey`. A claim refused because its key's claim
   * was released, or the key went with another request, is sent once more
   * under `freshKey()`, and never again; every other refusal is thrown as
   * it came.
   */
  private async claimOnce(
    session: SetupSession,
    projectId: string,
    checkout: Omit<CloudProjectClaimRequest, 'idempotencyKey'>,
    idempotencyKey: string,
    freshKey: () => string,
  ): Promise<{ claim: CloudProjectClaim; idempotencyKey: string }> {
    const send = async (
      key: string,
    ): Promise<{ claim: CloudProjectClaim; idempotencyKey: string }> => ({
      claim: await session.cloud.claim(projectId, {
        idempotencyKey: key,
        ...checkout,
      }),
      idempotencyKey: key,
    });
    try {
      return await send(idempotencyKey);
    } catch (error) {
      if (claimConflict(this.failure(error)) !== 'fresh-key') throw error;
    }
    return send(freshKey());
  }

  /**
   * The setup's project feed from its first event, in order: whether this
   * setup's claim was ended (a detach of its instance at its generation, or
   * the project deleted) and, until then, where a redirect leads. A redirect
   * after the claim ended is passed over. At most `EVENT_PAGES_MAX` pages a
   * run: how far it read is journaled (`claimFeed`), so the next run reads
   * on rather than from the first event, and `complete` says whether it
   * reached the feed's end.
   */
  private async claimFate(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<FeedFold<ClaimFate>> {
    const claim = {
      projectId: journal.projectId,
      instanceId: journal.instanceId,
      fencingGeneration: journal.fencingGeneration,
    };
    const carried = journal.claimFeed;
    const fold = await foldFeed<ClaimFate>(
      { ended: false, redirect: null },
      carried !== undefined &&
        carried.projectId === claim.projectId &&
        carried.instanceId === claim.instanceId &&
        carried.fencingGeneration === claim.fencingGeneration
        ? {
            state: { ended: carried.ended, redirect: carried.redirect },
            cursor: carried.cursor,
          }
        : null,
      {
        page: (after) => session.cloud.events(claim.projectId, after),
        step: (fate, event): ClaimFate => {
          if (fate.ended) return fate;
          if (
            event.type === 'deleted' ||
            (event.type === 'instance_detached' &&
              event.instanceId === claim.instanceId &&
              event.fencingGeneration === claim.fencingGeneration)
          )
            return { ...fate, ended: true };
          return {
            ...fate,
            redirect: redirectAfter(event, claim.projectId, fate.redirect),
          };
        },
        refused: (error) => {
          const failure = this.failure(error);
          return failure.status === 400 && failure.code === 'invalid_cursor';
        },
      },
    );
    if (fold.cursor !== null) {
      journal.claimFeed = { ...claim, cursor: fold.cursor, ...fold.state };
      await this.checkpoint(journal, journal.phase);
    }
    return fold;
  }

  /**
   * Moves the setup to the project its merged duplicate now is: the same
   * repositories, found again by identity there. A project that moved into
   * an organization is not followed. False when the feed shows this setup's
   * claim ended before the merge.
   */
  private async moveToRedirect(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<boolean> {
    const fate = await this.claimFate(journal, session);
    const { ended, redirect: target } = fate.state;
    if (ended) return false;
    if (!fate.complete) throw new SetupStop('completion-pending');
    if (target?.kind !== 'merged' || target.projectId === journal.projectId)
      throw new SetupStop('project-unavailable');
    const manifest = await session.cloud.manifest(target.projectId);
    if (manifest.kind !== 'code' || manifest.topology !== journal.topology)
      throw new SetupStop('project-unavailable');
    const idOf = (fingerprint: RepoFingerprint): string | undefined =>
      manifest.repositories.find((repository) =>
        isSameRepository(repository.fingerprint, fingerprint),
      )?.repositoryId;
    journal.rebinding ??= {
      projectId: journal.projectId,
      instanceId: journal.instanceId,
      fencingGeneration: journal.fencingGeneration,
    };
    journal.projectId = manifest.projectId;
    journal.manifestRevision = manifest.revision;
    journal.repoListSource = manifest.repoListSource;
    journal.repositories = journal.repositories.map((repository) => ({
      ...repository,
      repositoryId: idOf(repository.fingerprint) ?? repository.repositoryId,
    }));
    journal.declined = journal.declined.flatMap((repository) => {
      const repositoryId =
        repository.fingerprint === undefined
          ? undefined
          : idOf(repository.fingerprint);
      return repositoryId === undefined
        ? []
        : [{ ...repository, repositoryId }];
    });
    await this.checkpoint(journal, journal.phase);
    return true;
  }

  /**
   * The routes no longer find the project, as after a Personal catalog
   * removal, which records no lifecycle event, or its feed records this
   * setup's claim detached: the workspace stays on this computer, its
   * binding is marked detached as the binding pass would, and the setup
   * ends. Only a binding this setup wrote is marked: one a later claim wrote
   * is that claim's to end.
   *
   * The journal is kept while the release is unproven: dropping it would
   * leave a binding that may still be live with nothing left to release it.
   */
  private async projectGone(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<never> {
    if ((await this.detachBinding(journal, session)) !== 'indeterminate')
      await this.deps.journals.remove(journal.journalId);
    throw new SetupStop('project-unavailable');
  }

  /**
   * Marks the workspace's binding detached, as the binding pass would, when
   * it is one this setup wrote: the workspace and its checkout stay on this
   * computer and the project is no longer bound here, so it can be set up
   * again. Only a binding under the setup's own claim fence (its account,
   * instance and generation, through `holdsBinding`) is marked; one a later
   * claim wrote is that claim's to end.
   *
   * A manifest that cannot be read answers `indeterminate`, never a release:
   * the binding may still be live, so a caller ending the setup on it would
   * leave the project bound here with nothing left to release it.
   */
  private async detachBinding(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<BindingRelease> {
    await this.fence(session);
    const detachedAt = this.deps.now().toISOString();
    const status = await this.deps.workspaces.writeBinding(
      journal.localWorkspaceId,
      (current) =>
        current.cloudBinding !== undefined && holdsBinding(journal, current)
          ? { cloudBinding: { ...current.cloudBinding, detachedAt } }
          : null,
    );
    switch (status) {
      case 'written':
        return 'released';
      // Nothing of this setup's is bound: the compare declined, or the
      // workspace has no manifest left to hold a binding.
      case 'declined':
      case 'absent':
        return 'not-ours';
      // 'unreadable', and anything a later status adds, proves nothing.
      default:
        return 'indeterminate';
    }
  }

  /**
   * Finish or retire one journal. A setup stopped with a code the user must
   * see (`stoppedFor`) is kept by the launch sweep and cleared only when
   * the user sets the project up again (`clearStopped`).
   */
  private async resume(
    journal: ProjectSetupJournal,
    clearStopped = false,
  ): Promise<void> {
    const account = await this.deps.account();
    if (!account.ok || account.accountId !== journal.accountId) return;
    const session = this.open(account);
    if (stoppedFor(journal) !== null && !clearStopped) return;
    if (
      journal.phase === 'done' ||
      journal.phase === 'failed' ||
      journal.phase === 'cancelled'
    ) {
      await this.deps.journals.remove(journal.journalId);
      return;
    }
    if (!RESUMABLE_PHASES.includes(journal.phase)) {
      await this.retire(journal, session);
      return;
    }
    if (journal.phase === 'promoted') {
      const staged = await this.deps.fs.isGitCheckout(journal.stagingPath);
      const promoted = await this.deps.fs.isGitCheckout(journal.finalPath);
      const stagingLeft = await this.deps.fs.exists(journal.stagingPath);
      const finalLeft = await this.deps.fs.exists(journal.finalPath);
      if (staged && !finalLeft)
        await this.deps.fs.rename(journal.stagingPath, journal.finalPath);
      else if (!(promoted && !stagingLeft)) {
        // Both or neither: something else touched them; leave the disk alone.
        await this.deps.journals.remove(journal.journalId);
        return;
      }
    } else if (!(await this.deps.workspaces.exists(journal.localWorkspaceId))) {
      if (journal.phase === 'completing') {
        // The user removed the workspace; the setup is over.
        await this.deps.journals.remove(journal.journalId);
        return;
      }
    }
    try {
      await this.finish(journal, session);
    } catch (error) {
      if (error instanceof SetupStop && error.code === 'completion-pending')
        return;
      throw error;
    }
  }

  /** A setup that never reached its promoted folder: undo what it owns. */
  private async retire(
    journal: ProjectSetupJournal,
    session: SetupSession,
  ): Promise<void> {
    await this.deps.fs.removeOwned(journal.stagingPath);
    // Once consent ends the fence sends no detach: the claim lapses with its
    // lease, and the next setup of the project detaches what is left.
    await session.cloud
      .detach(journal.instanceId, journal)
      .catch((): void => {});
    await this.deps.journals.remove(journal.journalId);
  }

  private async fail(
    journal: ProjectSetupJournal,
    code: CloudProjectSetupErrorCode,
    session: SetupSession,
  ): Promise<void> {
    this.deps.progress({
      projectId: journal.projectId,
      phase: journal.phase,
      state: 'failed',
      errorCode: code,
    });
    if (
      code === 'completion-pending' ||
      stoppedFor(journal) !== null ||
      RESUMABLE_PHASES.includes(journal.phase)
    )
      return;
    await this.retire(journal, session).catch((): void => {});
  }

  private codeFor(error: unknown): CloudProjectSetupErrorCode {
    if (error instanceof SetupStop) return error.code;
    if (error instanceof BindingStop) return 'unavailable';
    const failure = this.failure(error);
    if (failure.transient) return 'offline';
    if (isProjectGone(failure) || isProjectRedirected(failure))
      return 'project-unavailable';
    // Outside the identity rollout the routes answer 404 with no code.
    if (failure.status === 404 && failure.code === undefined)
      return 'unavailable';
    switch (claimConflict(failure)) {
      case 'limit':
        return 'setup-limit';
      case 'held':
        return 'busy';
      default:
        return 'setup-failed';
    }
  }
}
