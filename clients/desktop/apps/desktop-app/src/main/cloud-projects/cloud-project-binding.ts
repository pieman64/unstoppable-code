import { createHash } from 'node:crypto';
import {
  CloudProjectEventCursorSchema,
  isSameRepository,
  type CloudProjectBinding,
  type CloudProjectCheckout,
  type CloudProjectLifecycleEvent,
  type CloudProjectLifecycleEventsPage,
  type CloudProjectManifest,
  type CloudProjectMatchResponse,
} from '@canopy/protocol/memory-sync';
import { ORG_PROJECT_CLAIM_CONFLICT_REASONS } from '@canopy/protocol/org-projects';
import type {
  CloudProjectLinkCandidate,
  CloudProjectLinkOptions,
  CloudProjectLinkRequest,
  CloudProjectLinkResult,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import type {
  WorkspaceCloudBindingCompare,
  WorkspaceOwnershipRecordStatus,
} from '../lib/worktree-record-decisions';
import type {
  CloudProjectClaim,
  CloudProjectClient,
} from './cloud-project-client';
import {
  BindingStop,
  createCloudProjectFence,
  type CloudProjectConsent,
  type CloudProjectFence,
  type CloudProjectSessionAccount,
  type FencedCloudProjectClient,
} from './cloud-project-fence';
import {
  EVENT_PAGES_MAX,
  FeedFolds,
  type FeedFold,
} from './cloud-project-feed';
import {
  bindsAutomatically,
  fitsTopology,
  listToPublish,
  matchRequestFor,
  type LocalProject,
} from './local-project';

/*
 * One cloud binding per local workspace (CAN-5190, contract sections 21.4 to
 * 21.6). The binding keeps each workspace's `cloudBinding` in step with its
 * cloud project:
 *
 * - an organization workspace's `owner` is mirrored into it, with no network
 *   call and no change to any organization code path;
 * - a single-repository Personal workspace binds without asking (D7): to the
 *   project it matches, or to a new one created with its `personalCatalogId`
 *   as the creation key;
 * - a multi-repository or remote-less workspace binds only when the user
 *   links it from the Link to cloud project dialog;
 * - a bound workspace follows its project's lifecycle events (a merge moves
 *   the binding, a detach or delete stops it from binding again on its own)
 *   and publishes its repository list (D10) and this device's selection (D9);
 * - every request reaches the Cloud only through the consent fence
 *   (cloud-project-fence.ts), which checks before each one that the account
 *   is still signed in and that the Personal project list is still shared;
 *   the engine never holds the raw client.
 *
 * No Electron imports: the host injects the client, the stores and the clock,
 * so the same code can move with the sync engine when the daemon owns
 * workspace manifests (D15).
 */

/**
 * The organization project a Personal project moved into, while its checkout
 * is there. The binding follows that project's feed from `eventCursor` until
 * `moved_to_personal` brings the checkout back; `failures` and `retryAt`
 * space out reads the feed keeps refusing.
 */
export interface BindingMove {
  projectId: string;
  eventCursor?: string;
  failures?: number;
  retryAt?: string;
}

/** The binding fields this build adds to the stored record (kept loose). */
interface BindingProgress {
  /** The opaque feed position after the last lifecycle event applied. */
  eventCursor?: string;
  /** Set when this device's binding was detached or its project deleted. */
  detachedAt?: string;
  /** The cloud project's name, for the Link dialog. */
  name?: string;
  /** Set while the project is in an organization (D20). */
  movedTo?: BindingMove;
  /**
   * On an organization binding: the Personal binding it replaced, restored
   * when the workspace is Personal again (D20).
   */
  personal?: StoredBinding;
}

type StoredBinding = CloudProjectBinding & BindingProgress;

export interface BindingWorkspace {
  workspaceId: string;
  owner: WorkspaceOwnerBinding | undefined;
  temporary: boolean;
  binding: StoredBinding | undefined;
  /** Null for a workspace identity does not cover (Cowork). */
  local: LocalProject | null;
  /**
   * `suppressedRepoIds`: `canopy.json` repo ids, or cloud manifest repository
   * ids, this device does not clone.
   */
  suppressedSourceKeys: readonly string[];
}

export type BindingAccount =
  | (CloudProjectSessionAccount & { ok: true; sharing: boolean })
  | { ok: false; reason: 'signed-out' | 'not-supported' };

/**
 * The account an operation runs for, from its start to its last write, and
 * the fenced client that sends every request under that account's credential.
 */
interface Session {
  accountId: string;
  cloud: FencedCloudProjectClient;
}

export interface CloudProjectBindingFailure {
  status?: number;
  code?: string;
  /** The cause the error body names beside its code, e.g. a claim conflict's. */
  reason?: string;
  transient: boolean;
}

export interface CloudProjectBindingDeps extends CloudProjectConsent {
  /** The raw routes: the engine reaches them only through the consent fence. */
  client: CloudProjectClient;
  account(): Promise<BindingAccount>;
  device(): Promise<{ deviceId: string; installationGeneration: number }>;
  workspaceIds(): Promise<readonly string[]>;
  /** Null when unreadable; rejects when Git or `canopy.json` cannot be read. */
  readWorkspace(workspaceId: string): Promise<BindingWorkspace | null>;
  /** The workspace's `personalCatalogId`, allocated when it has none. */
  creationKey(workspaceId: string): Promise<string | undefined>;
  writeBinding(
    workspaceId: string,
    compare: WorkspaceCloudBindingCompare,
  ): Promise<WorkspaceOwnershipRecordStatus>;
  /** The opaque id this workspace claims under (the Personal catalog's). */
  localWorkspaceId(workspaceId: string): string | null;
  failure(error: unknown): CloudProjectBindingFailure;
  now(): Date;
  randomKey(): string;
  /** Records a failure the next pass retries. */
  warn(message: string, context: Record<string, unknown>): void;
}

/** Redirects and creates one bind may follow before it gives up. */
const BIND_HOPS_MAX = 4;
/** The first wait after a moved project's feed refuses a read, doubled after each refusal. */
const MOVE_BACKOFF_MS = 5 * 60_000;
const MOVE_BACKOFF_MAX_MS = 24 * 60 * 60_000;

/** How a bind reached its project, which decides what a lost claim does. */
type BindOrigin =
  /** The user chose it: never swapped for another project. */
  | { kind: 'chosen' }
  /** Matched, or reached through a redirect or a merge. */
  | { kind: 'found' }
  /** Answered by a create with this key. */
  | { kind: 'created'; creationKey: string };

const CHOSEN: BindOrigin = { kind: 'chosen' };
const FOUND: BindOrigin = { kind: 'found' };

/**
 * The creation key of the project that replaces `lostProjectId`, one this
 * workspace can no longer bind (empty when it never had a binding): derived,
 * so a bind interrupted after its create finds the same project again.
 */
function freshCreationKey(creationKey: string, lostProjectId: string): string {
  const hex = createHash('sha256')
    .update(`cloud-project-rebind:${creationKey}:${lostProjectId}`)
    .digest('hex');
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

export function isConflict(failure: CloudProjectBindingFailure): boolean {
  return failure.status === 409 && failure.code === 'conflict';
}

/**
 * Why a claim answered `409 conflict`, from the reason its body names
 * (CAN-5189): the account is at its active setup limit, another checkout of
 * this installation holds the project, or the key's claim was released.
 * Any other conflict, a reason this build does not know or none, is
 * `unknown`, which creates nothing and tries no new key. Null when the
 * failure is not a claim conflict.
 */
type ClaimConflict = 'limit' | 'held' | 'released' | 'unknown';

function claimConflict(
  failure: CloudProjectBindingFailure,
): ClaimConflict | null {
  if (!isConflict(failure)) return null;
  switch (failure.reason) {
    case ORG_PROJECT_CLAIM_CONFLICT_REASONS.instanceLimit:
      return 'limit';
    case ORG_PROJECT_CLAIM_CONFLICT_REASONS.checkoutConflict:
      return 'held';
    case ORG_PROJECT_CLAIM_CONFLICT_REASONS.claimInvalid:
      return 'released';
    default:
      return 'unknown';
  }
}

export function isProjectRedirected(
  failure: CloudProjectBindingFailure,
): boolean {
  return failure.status === 409 && failure.code === 'project_redirected';
}

/** The project this creation key made was archived or deleted. */
function isNotRestorable(failure: CloudProjectBindingFailure): boolean {
  return failure.status === 409 && failure.code === 'not_restorable';
}

/**
 * The project is gone. A route outside the identity rollout also answers
 * 404, with no code, and says nothing about the project.
 */
export function isProjectGone(failure: CloudProjectBindingFailure): boolean {
  return failure.status === 404 && failure.code === 'not_found';
}

/** Where a redirected project leads: a merged duplicate's survivor, or the organization it moved into. */
export interface ProjectRedirect {
  kind: 'merged' | 'moved';
  projectId: string;
}

/** The redirect of `projectId` once `event` is applied, in feed order. */
export function redirectAfter(
  event: CloudProjectLifecycleEvent,
  projectId: string,
  current: ProjectRedirect | null,
): ProjectRedirect | null {
  if (event.type === 'merged_duplicate' && event.fromProjectId === projectId)
    return { kind: 'merged', projectId: event.toProjectId };
  if (
    event.type === 'moved_to_organization' &&
    event.fromProjectId === projectId
  )
    return { kind: 'moved', projectId: event.toProjectId };
  return current;
}

/** A bound claim's fate in its project's feed: a detach or delete ends it, until then the redirect. */
interface ClaimFate {
  redirect: ProjectRedirect | null;
  detachedAt: string | null;
}

/** A read of a feed from a stored position: where it stopped, and whether nothing is left to read. */
interface FeedRead {
  cursor: string | null;
  /** The read reached the feed's end, or the caller stopped it. */
  complete: boolean;
}

/** A bound project's new events applied to its binding. */
interface BoundRead {
  binding: StoredBinding;
  /** The read reached the feed's end, or a merge or move stopped it. */
  complete: boolean;
  /** A merge or move the binding leaves for, which ended the read. */
  leave: ProjectRedirect | null;
}

/** A stored feed position the server can be sent; anything else reads from the start. */
function feedPosition(cursor: string | undefined): string | null {
  return cursor !== undefined &&
    CloudProjectEventCursorSchema.safeParse(cursor).success
    ? cursor
    : null;
}

function sameBindingKey(
  left: CloudProjectBinding | undefined,
  right: CloudProjectBinding,
): boolean {
  return (
    left !== undefined &&
    left.accountId === right.accountId &&
    left.projectId === right.projectId &&
    left.instanceId === right.instanceId &&
    left.bindingGeneration === right.bindingGeneration &&
    left.ownerType === right.ownerType
  );
}

export class CloudProjectBindingEngine {
  private readonly busy = new Set<string>();
  private readonly deps: Omit<CloudProjectBindingDeps, 'client'>;
  private readonly consent: CloudProjectFence;
  /** Each project's redirect, and so its feed's end, read on from pass to pass. */
  private readonly redirects = new FeedFolds<ProjectRedirect | null>(null);
  /** Each bound claim's fate, read on from pass to pass. */
  private readonly claimFates = new FeedFolds<ClaimFate>({
    redirect: null,
    detachedAt: null,
  });

  constructor({ client, ...deps }: CloudProjectBindingDeps) {
    this.deps = deps;
    this.consent = createCloudProjectFence(client, deps);
  }

  /** The session an operation runs: every request through the fence. */
  private open(account: CloudProjectSessionAccount): Session {
    return { accountId: account.accountId, cloud: this.consent.open(account) };
  }

  /** A failure as the binding reads it; a fence stop is never transient. */
  private failure(error: unknown): CloudProjectBindingFailure {
    return error instanceof BindingStop
      ? { transient: false }
      : this.deps.failure(error);
  }

  /** Reconciles every workspace; one workspace's failure never stops the rest. */
  async reconcileAll(): Promise<void> {
    const account = await this.deps.account();
    if (!account.ok) return;
    for (const workspaceId of await this.deps.workspaceIds()) {
      try {
        await this.reconcile(workspaceId);
      } catch {
        // The next pass retries; a binding is never half-written.
      }
    }
  }

  async reconcile(workspaceId: string): Promise<void> {
    if (this.busy.has(workspaceId)) return;
    this.busy.add(workspaceId);
    try {
      await this.reconcileNow(workspaceId);
    } finally {
      this.busy.delete(workspaceId);
    }
  }

  private async reconcileNow(workspaceId: string): Promise<void> {
    const account = await this.deps.account();
    if (!account.ok) return;
    const read = await this.deps.readWorkspace(workspaceId);
    if (read === null || read.temporary) return;
    const session = this.open(account);
    if (read.owner?.type === 'organization') {
      await this.mirrorOrganization(read, session);
      return;
    }
    if (!account.sharing || read.local === null) return;
    const local = read.local;
    let workspace = read;
    const left = read.binding;
    if (left?.ownerType === 'organization') {
      const restored = await this.leaveOrganization(read, left, session);
      workspace = { ...read, binding: restored };
      if (
        restored !== undefined &&
        personalBinding(workspace, account.accountId) !== undefined &&
        restored.detachedAt === undefined
      ) {
        await this.startMove(
          workspace,
          local,
          restored,
          session,
          left.projectId,
        );
        return;
      }
    }
    const binding = personalBinding(workspace, account.accountId);
    if (binding !== undefined) {
      if (binding.detachedAt === undefined)
        await this.followBound(workspace, local, binding, session);
      return;
    }
    if (bindsAutomatically(local))
      await this.bindAutomatically(workspace, local, session);
  }

  /**
   * The workspace is Personal again, as after this device moved it back from
   * its organization or undid a conversion, while its record is still the
   * organization binding (D20). The record becomes the Personal binding the
   * organization binding replaced, or none when it replaced none, so nothing
   * of the organization stays behind. The caller then treats a live Personal
   * binding as one whose project moved, so its project answering again
   * claims it again.
   */
  private async leaveOrganization(
    workspace: BindingWorkspace,
    organization: StoredBinding,
    session: Session,
  ): Promise<StoredBinding | undefined> {
    const restored = organization.personal;
    await this.fence(session);
    const status = await this.deps.writeBinding(
      workspace.workspaceId,
      (current) =>
        current.owner === undefined &&
        sameBindingKey(current.cloudBinding, organization)
          ? { cloudBinding: restored }
          : null,
    );
    if (status !== 'written') throw new BindingStop('workspace-unreadable');
    return restored;
  }

  /** D7: the project the workspace matches, or a new one of its own. */
  private async bindAutomatically(
    workspace: BindingWorkspace,
    local: LocalProject,
    session: Session,
  ): Promise<void> {
    const match = await this.match(workspace, local, session);
    if (match.decision === 'candidates') return;
    if (match.decision === 'matched') {
      try {
        await this.bindTo(workspace, local, session, match.projectId, FOUND);
        return;
      } catch (error) {
        // A project this workspace cannot take, such as a multi-repository
        // one, leaves it to a project of its own.
        if (
          !(
            error instanceof BindingStop && error.code === 'project-unavailable'
          )
        )
          throw error;
      }
    }
    await this.createAndBind(workspace, local, session, false);
  }

  /** The project a local workspace matches, as the checkout it is. */
  private async match(
    workspace: BindingWorkspace,
    local: LocalProject,
    session: Session,
  ): Promise<CloudProjectMatchResponse> {
    const checkout = await this.checkoutOf(workspace.workspaceId);
    return session.cloud.match({
      ...matchRequestFor(local),
      ...(checkout === null ? {} : { checkout }),
    });
  }

  /** This device's checkout of a workspace, as its claim names it. */
  private async checkoutOf(
    workspaceId: string,
  ): Promise<CloudProjectCheckout | null> {
    const localWorkspaceId = this.deps.localWorkspaceId(workspaceId);
    if (localWorkspaceId === null) return null;
    const { deviceId, installationGeneration } = await this.deps.device();
    return { deviceId, installationGeneration, localWorkspaceId };
  }

  private async requireCheckout(
    workspace: BindingWorkspace,
  ): Promise<CloudProjectCheckout> {
    const checkout = await this.checkoutOf(workspace.workspaceId);
    if (checkout === null) throw new BindingStop('unavailable');
    return checkout;
  }

  /** The options the Link to cloud project dialog shows. */
  async findLink(workspaceId: string): Promise<CloudProjectLinkOptions> {
    const account = await this.deps.account();
    if (!account.ok) return { status: 'unavailable', reason: account.reason };
    if (!account.sharing)
      return { status: 'unavailable', reason: 'sharing-off' };
    const workspace = await this.deps
      .readWorkspace(workspaceId)
      .catch((): null => null);
    if (workspace === null)
      return { status: 'unavailable', reason: 'workspace-unreadable' };
    if (workspace.owner !== undefined)
      return { status: 'unavailable', reason: 'not-personal' };
    if (workspace.local === null || workspace.temporary)
      return { status: 'unavailable', reason: 'not-supported' };
    const binding = personalBinding(workspace, account.accountId);
    const session = this.open(account);
    const local = workspace.local;
    try {
      // A moved binding offers the projects to link: a manual link wins.
      if (
        binding !== undefined &&
        binding.detachedAt === undefined &&
        binding.movedTo === undefined
      ) {
        const linked = await this.linkedProject(local, binding, session);
        if (linked !== null) return linked;
      }
      const match = await this.match(workspace, local, session);
      // Only a project of the workspace's own topology can take it: the
      // server keeps a project's topology, and a single-repository list
      // would replace a multi-repository project's.
      const fitting = async (
        projectId: string,
      ): Promise<CloudProjectManifest | null> => {
        try {
          const manifest = await session.cloud.manifest(projectId);
          return fitsTopology(local, manifest) ? manifest : null;
        } catch (error) {
          if (error instanceof BindingStop || this.failure(error).transient)
            throw error;
          return null;
        }
      };
      if (match.decision === 'matched') {
        const manifest = await fitting(match.projectId);
        return manifest === null
          ? { status: 'choose', candidates: [], suggestedProjectId: null }
          : {
              status: 'choose',
              candidates: [
                {
                  projectId: manifest.projectId,
                  name: manifest.name,
                  matchedRepositories: local.repositories.length,
                  totalRepositories: manifest.repositories.length,
                },
              ],
              suggestedProjectId: manifest.projectId,
            };
      }
      const offered =
        match.decision === 'candidates'
          ? match.candidates.filter(
              (candidate) => candidate.ownerType === 'user',
            )
          : [];
      const fits = await Promise.all(
        offered.map(
          async (candidate): Promise<boolean> =>
            (await fitting(candidate.projectId)) !== null,
        ),
      );
      const candidates: CloudProjectLinkCandidate[] = offered
        .filter((_candidate, index) => fits[index] === true)
        .map((candidate) => ({
          projectId: candidate.projectId,
          name: candidate.name,
          matchedRepositories: candidate.matchedRepositories,
          totalRepositories: candidate.totalRepositories,
        }));
      return { status: 'choose', candidates, suggestedProjectId: null };
    } catch (error) {
      if (error instanceof BindingStop)
        return {
          status: 'unavailable',
          reason: (await this.deps.isSharing()) ? 'signed-out' : 'sharing-off',
        };
      if (this.failure(error).transient)
        return { status: 'unavailable', reason: 'offline' };
      throw error;
    }
  }

  /**
   * A live binding's project, as the dialog shows it linked. Null when the
   * dialog offers projects to link instead: the project redirects, or it no
   * longer has the workspace's topology (a workspace converted between one
   * repository and several), so the binding publishes nothing to it and only
   * a link to a project that fits recovers it. A project that cannot be read
   * right now shows by the name the binding recorded.
   */
  private async linkedProject(
    local: LocalProject,
    binding: StoredBinding,
    session: Session,
  ): Promise<CloudProjectLinkOptions | null> {
    let manifest: CloudProjectManifest;
    try {
      manifest = await session.cloud.manifest(binding.projectId);
    } catch (error) {
      if (error instanceof BindingStop) throw error;
      if (isProjectRedirected(this.failure(error))) return null;
      if (binding.name === undefined) throw error;
      return {
        status: 'linked',
        projectId: binding.projectId,
        name: binding.name,
      };
    }
    return fitsTopology(local, manifest)
      ? { status: 'linked', projectId: binding.projectId, name: manifest.name }
      : null;
  }

  /** Links a workspace to the project the user chose, or to a new one. */
  async link(
    request: CloudProjectLinkRequest,
  ): Promise<CloudProjectLinkResult> {
    if (this.busy.has(request.workspaceId)) return { ok: false, code: 'busy' };
    this.busy.add(request.workspaceId);
    try {
      const account = await this.deps.account();
      if (!account.ok || !account.sharing)
        return { ok: false, code: 'unavailable' };
      const workspace = await this.deps
        .readWorkspace(request.workspaceId)
        .catch((): null => null);
      if (workspace === null)
        return { ok: false, code: 'workspace-unreadable' };
      if (workspace.owner !== undefined)
        return { ok: false, code: 'not-personal' };
      if (workspace.local === null || workspace.temporary)
        return { ok: false, code: 'unavailable' };
      const session = this.open(account);
      const projectId =
        request.target.kind === 'existing'
          ? await this.bindTo(
              workspace,
              workspace.local,
              session,
              request.target.projectId,
              CHOSEN,
            )
          : await this.createAndBind(workspace, workspace.local, session, true);
      return { ok: true, projectId };
    } catch (error) {
      if (error instanceof BindingStop) return { ok: false, code: error.code };
      const failure = this.failure(error);
      if (failure.transient) return { ok: false, code: 'offline' };
      if (isProjectGone(failure) || isProjectRedirected(failure))
        return { ok: false, code: 'project-unavailable' };
      // A codeless 404 is a route outside the identity rollout.
      if (failure.status === 404 && failure.code === undefined)
        return { ok: false, code: 'unavailable' };
      return { ok: false, code: 'link-failed' };
    } finally {
      this.busy.delete(request.workspaceId);
    }
  }

  /**
   * Refuses a `cloudBinding` write once another account is signed in or,
   * unless it only mirrors an organization, once the Personal project list
   * is no longer shared: the check every request makes, read again each time.
   */
  private async fence(session: Session, personal = true): Promise<void> {
    await this.consent.require(session.accountId, { sharing: personal });
  }

  private async mirrorOrganization(
    workspace: BindingWorkspace,
    session: Session,
  ): Promise<void> {
    const accountId = session.accountId;
    const owner = workspace.owner;
    if (owner?.type !== 'organization') return;
    const existing = workspace.binding;
    // The Personal binding this one replaces comes back with the workspace
    // when it is Personal again (D20).
    const personal =
      existing?.ownerType === 'user' ? existing : existing?.personal;
    const next: StoredBinding = {
      version: 1,
      projectId: owner.projectId,
      accountId,
      ownerType: 'organization',
      organizationId: owner.organizationId,
      instanceId: owner.instanceId,
      bindingGeneration: owner.bindingGeneration,
      boundAt: this.deps.now().toISOString(),
      manifestRevision: 0,
      repoListSource: 'cloud_manifest',
      ...(personal === undefined ? {} : { personal }),
    };
    if (sameBindingKey(existing, next)) return;
    await this.fence(session, false);
    await this.deps.writeBinding(workspace.workspaceId, (current) =>
      current.owner?.type === 'organization' &&
      current.owner.projectId === owner.projectId &&
      current.owner.instanceId === owner.instanceId &&
      (existing === undefined
        ? current.cloudBinding === undefined
        : sameBindingKey(current.cloudBinding, existing))
        ? { cloudBinding: next }
        : null,
    );
  }

  /**
   * Creates the workspace's project under its creation key and binds it. A
   * key whose project was archived or deleted answers `not_restorable`; when
   * the user asked for a new project (`replace`), the next key is derived
   * from that key and the project the workspace was bound to, so a link
   * interrupted after its create finds the same project again. A bind of its
   * own never replaces a project the user deleted. A key whose project has
   * the other topology, as after the workspace was converted between one
   * repository and several, leads to a key derived from it and that project
   * the same way: a project keeps its topology.
   */
  private async createAndBind(
    workspace: BindingWorkspace,
    local: LocalProject,
    session: Session,
    replace: boolean,
  ): Promise<string> {
    const lostProjectId =
      personalBinding(workspace, session.accountId)?.projectId ?? '';
    let creationKey = await this.catalogKey(workspace);
    for (let hops = 0; ; hops += 1) {
      let manifest: CloudProjectManifest;
      try {
        manifest = await this.create(workspace, local, session, creationKey);
      } catch (error) {
        if (
          !replace ||
          hops >= BIND_HOPS_MAX ||
          !isNotRestorable(this.failure(error))
        )
          throw error;
        creationKey = freshCreationKey(creationKey, lostProjectId);
        continue;
      }
      if (!fitsTopology(local, manifest)) {
        if (hops >= BIND_HOPS_MAX) throw new BindingStop('project-unavailable');
        creationKey = freshCreationKey(creationKey, manifest.projectId);
        continue;
      }
      return this.bindTo(
        workspace,
        local,
        session,
        manifest.projectId,
        { kind: 'created', creationKey },
        hops,
      );
    }
  }

  /** The workspace's `personalCatalogId`, its first creation key. */
  private async catalogKey(workspace: BindingWorkspace): Promise<string> {
    const creationKey = await this.deps.creationKey(workspace.workspaceId);
    if (creationKey === undefined)
      throw new BindingStop('workspace-unreadable');
    return creationKey;
  }

  /**
   * Creates the project, or finds again the one this key made, as this
   * checkout: without the checkout the server never merges the project into
   * a duplicate another computer uses. A key whose project moved into an
   * organization answers `project_redirected` until the checkout moves back,
   * which ends the bind: nothing is claimed or created meanwhile.
   */
  private async create(
    workspace: BindingWorkspace,
    local: LocalProject,
    session: Session,
    creationKey: string,
  ): Promise<CloudProjectManifest> {
    const checkout = await this.requireCheckout(workspace);
    return session.cloud.create({
      creationKey,
      name: local.name,
      kind: 'code',
      topology: local.topology,
      ...listToPublish(local, null),
      portableConfig: null,
      checkout,
    });
  }

  /**
   * Claims this device's instance of a project whose topology fits,
   * publishes the repository list, completes the claim and only then records
   * the binding, so a list the server refuses never leaves a link behind and
   * a recorded one is a link made.
   */
  private async bindTo(
    workspace: BindingWorkspace,
    local: LocalProject,
    session: Session,
    projectId: string,
    origin: BindOrigin,
    hops = 0,
  ): Promise<string> {
    if (hops > BIND_HOPS_MAX) throw new BindingStop('link-failed');
    const { accountId } = session;
    const checkout = await this.requireCheckout(workspace);
    const from = { origin, hops };
    const follow = (error: unknown): Promise<string> =>
      this.followRedirect(workspace, local, session, projectId, error, from);
    let manifest: CloudProjectManifest;
    try {
      manifest = await session.cloud.manifest(projectId);
    } catch (error) {
      return follow(error);
    }
    if (!fitsTopology(local, manifest))
      throw new BindingStop('project-unavailable');
    // Bound to the project it names, so a redirect's target never replays
    // the key of the project it replaced.
    const stableKey = createHash('sha256')
      .update(
        `cloud-project-bind:${accountId}:${checkout.deviceId}:${checkout.installationGeneration}:${projectId}:${checkout.localWorkspaceId}`,
      )
      .digest('hex');
    const claimWith = (idempotencyKey: string): Promise<CloudProjectClaim> =>
      session.cloud.claim(projectId, { idempotencyKey, ...checkout });
    const refused = async (
      error: unknown,
      conflict: Exclude<ClaimConflict, 'released'>,
    ): Promise<string> => {
      if (conflict === 'limit') throw new BindingStop('too-many-setups');
      if (conflict === 'held' && origin.kind !== 'chosen')
        return this.recreate(workspace, local, session, projectId, from);
      throw error;
    };
    let claim: CloudProjectClaim;
    try {
      claim = await claimWith(stableKey);
    } catch (error) {
      const conflict = claimConflict(this.failure(error));
      if (conflict === null) return follow(error);
      if (conflict !== 'released') return refused(error, conflict);
      // A replayed key whose claim was released starts a fresh claim.
      try {
        claim = await claimWith(this.deps.randomKey());
      } catch (again) {
        const still = claimConflict(this.failure(again));
        if (still === null || still === 'released') throw again;
        return refused(again, still);
      }
    }
    if (claim.state !== 'CLAIMED' && claim.state !== 'READY')
      throw new BindingStop('link-failed');
    let published: CloudProjectManifest;
    try {
      published = await this.publishListOnBind(local, manifest, session);
    } catch (error) {
      // A list the server refused releases the claim. After a fence stop the
      // fenced detach sends nothing: the claim lapses with its lease, and
      // this checkout's next bind with consent claims it again.
      if (claim.state === 'CLAIMED')
        await session.cloud
          .detach(claim.instanceId, claim)
          .catch((): void => {});
      throw error;
    }
    if (claim.state === 'CLAIMED')
      await session.cloud.complete(claim.instanceId, claim);
    // The binding follows the feed from the claim on. A server that predates
    // the claim's cursor gets the feed's end instead, so the new binding
    // never replays history such as the detach a reclaim follows.
    const eventCursor =
      claim.eventsCursor ?? (await this.currentCursor(session, projectId));
    const binding: StoredBinding = {
      version: 1,
      projectId: published.projectId,
      accountId,
      ownerType: 'user',
      organizationId: null,
      instanceId: claim.instanceId,
      bindingGeneration: claim.fencingGeneration,
      boundAt: this.deps.now().toISOString(),
      manifestRevision: published.revision,
      repoListSource: published.repoListSource,
      name: published.name,
      ...(eventCursor === null ? {} : { eventCursor }),
    };
    await this.fence(session);
    const status = await this.deps.writeBinding(
      workspace.workspaceId,
      (current) =>
        current.owner === undefined && !current.temporary
          ? { cloudBinding: binding }
          : null,
    );
    if (status !== 'written') throw new BindingStop('workspace-unreadable');
    return this.catchUp(workspace, local, binding, session);
  }

  /**
   * A bind has succeeded once its binding is recorded. Its first sync is
   * catch-up like any pass's: a failure there, a fence stop included, leaves
   * the record for the next pass, which retries. Answers the project the
   * record ends on.
   */
  private async catchUp(
    workspace: BindingWorkspace,
    local: LocalProject,
    binding: StoredBinding,
    session: Session,
  ): Promise<string> {
    try {
      return await this.followBound(workspace, local, binding, session);
    } catch (error) {
      const failure =
        error instanceof BindingStop
          ? { stop: error.code }
          : this.failure(error);
      this.deps.warn(
        'Cloud project binding: the sync after a bind failed; the next pass retries',
        { workspaceId: workspace.workspaceId, ...failure },
      );
      return binding.projectId;
    }
  }

  /**
   * Binds to the project a `409 project_redirected` leads to: a merged
   * duplicate's survivor. A project that moved into an organization is
   * unavailable to a Personal bind, which never claims an organization
   * project.
   */
  private async followRedirect(
    workspace: BindingWorkspace,
    local: LocalProject,
    session: Session,
    projectId: string,
    error: unknown,
    from: { origin: BindOrigin; hops: number },
  ): Promise<string> {
    if (!isProjectRedirected(this.failure(error))) throw error;
    const { state: redirect, complete } = await this.redirectOf(
      session,
      projectId,
    );
    // The feed is longer than one read: the next pass or link reads on.
    if (!complete) throw new BindingStop('link-failed');
    if (redirect?.kind !== 'merged' || redirect.projectId === projectId)
      throw new BindingStop('project-unavailable');
    return this.bindTo(
      workspace,
      local,
      session,
      redirect.projectId,
      from.origin.kind === 'chosen' ? CHOSEN : FOUND,
      from.hops + 1,
    );
  }

  /**
   * After another checkout of this installation claimed `lostProjectId`
   * first, creates again with the same key and checkout: a merged project
   * comes back on its own. When the answer is that same project, it is this
   * checkout's own, claimed by the other checkout after this one let it go.
   * It is never taken back, which would detach the other checkout: a new
   * project is created under a fresh creation key instead.
   */
  private async recreate(
    workspace: BindingWorkspace,
    local: LocalProject,
    session: Session,
    lostProjectId: string,
    from: { origin: BindOrigin; hops: number },
  ): Promise<string> {
    const creationKey =
      from.origin.kind === 'created'
        ? from.origin.creationKey
        : await this.catalogKey(workspace);
    const again = await this.create(workspace, local, session, creationKey);
    if (again.projectId !== lostProjectId)
      return this.bindTo(
        workspace,
        local,
        session,
        again.projectId,
        { kind: 'created', creationKey },
        from.hops + 1,
      );
    const freshKey = freshCreationKey(creationKey, lostProjectId);
    const created = await this.create(workspace, local, session, freshKey);
    return this.bindTo(
      workspace,
      local,
      session,
      created.projectId,
      { kind: 'created', creationKey: freshKey },
      from.hops + 1,
    );
  }

  /**
   * D10 as a bind starts: the list this device owns, published before the
   * binding is recorded. A write the manifest moved past (`409 conflict`) is
   * tried once more on the manifest it lost to; any other refusal is final.
   */
  private async publishListOnBind(
    local: LocalProject,
    manifest: CloudProjectManifest,
    session: Session,
  ): Promise<CloudProjectManifest> {
    try {
      return await this.writeList(local, manifest, session);
    } catch (error) {
      if (error instanceof BindingStop || !isConflict(this.failure(error)))
        throw error;
    }
    const current = await session.cloud.manifest(manifest.projectId);
    if (!fitsTopology(local, current))
      throw new BindingStop('project-unavailable');
    return this.writeList(local, current, session);
  }

  /**
   * The only manifest write a binding makes: the list `listToPublish`
   * allows, when it allows one (D10 and the topology rule). Answers the
   * manifest.
   */
  private async writeList(
    local: LocalProject,
    manifest: CloudProjectManifest,
    session: Session,
  ): Promise<CloudProjectManifest> {
    const list = listToPublish(local, manifest);
    if (list === null) return manifest;
    return session.cloud.updateManifest(manifest.projectId, {
      baseRevision: manifest.revision,
      name: manifest.name,
      topology: manifest.topology,
      ...list,
      portableConfig: manifest.portableConfig,
    });
  }

  /**
   * Pages a project's feed after `after` (null: from its first event), at
   * most `EVENT_PAGES_MAX` pages, handing each event to `apply` until it
   * answers `'stop'`. Answers the last `nextCursor`, which the caller stores
   * so its next read goes on from there, and whether the read reached the
   * feed's end. A position the server rejects (`invalid_cursor`: one from
   * another project, or ahead of the feed) restarts from the first event;
   * event IDs keep the restart from applying an event twice.
   */
  private async readFeed(
    session: Session,
    projectId: string,
    after: string | null,
    apply: (event: CloudProjectLifecycleEvent) => 'stop' | undefined,
  ): Promise<FeedRead> {
    const seen = new Set<string>();
    let cursor = after;
    let restarted = after === null;
    for (let page = 0; page < EVENT_PAGES_MAX; page++) {
      let events: CloudProjectLifecycleEventsPage;
      try {
        events = await session.cloud.events(projectId, cursor);
      } catch (error) {
        if (restarted || !this.refusesCursor(error)) throw error;
        restarted = true;
        cursor = null;
        continue;
      }
      cursor = events.nextCursor;
      for (const { eventId, event } of events.events) {
        if (seen.has(eventId)) continue;
        seen.add(eventId);
        if (apply(event) === 'stop') return { cursor, complete: true };
      }
      if (!events.hasMore) return { cursor, complete: true };
    }
    return { cursor, complete: false };
  }

  private refusesCursor(error: unknown): boolean {
    const failure = this.failure(error);
    return failure.status === 400 && failure.code === 'invalid_cursor';
  }

  /**
   * A project's feed folded from its first event under `key`, read on from
   * where the last fold of that key stopped (cloud-project-feed.ts).
   */
  private foldFeed<State>(
    folds: FeedFolds<State>,
    session: Session,
    projectId: string,
    key: string,
    step: (state: State, event: CloudProjectLifecycleEvent) => State,
  ): Promise<FeedFold<State>> {
    return folds.fold(`${session.accountId}:${projectId}:${key}`, {
      page: (after) => session.cloud.events(projectId, after),
      step,
      refused: (error) => this.refusesCursor(error),
    });
  }

  /**
   * The feed position after the project's latest lifecycle event, or, for a
   * feed longer than one read, the furthest this device has read; the next
   * call reads on from there.
   */
  private async currentCursor(
    session: Session,
    projectId: string,
  ): Promise<string | null> {
    return (await this.redirectOf(session, projectId)).cursor;
  }

  /** Where a redirected project leads, from its whole feed. */
  private redirectOf(
    session: Session,
    projectId: string,
  ): Promise<FeedFold<ProjectRedirect | null>> {
    return this.foldFeed(
      this.redirects,
      session,
      projectId,
      'redirect',
      (redirect, event) => redirectAfter(event, projectId, redirect),
    );
  }

  /**
   * Where a bound project that answers `project_redirected` leads, from its
   * whole feed in order. A detach of this binding's claim, or the project's
   * deletion, ends the binding there: a redirect after it is passed over.
   */
  private boundRedirect(
    session: Session,
    binding: StoredBinding,
  ): Promise<FeedFold<ClaimFate>> {
    return this.foldFeed(
      this.claimFates,
      session,
      binding.projectId,
      `claim:${binding.instanceId}:${binding.bindingGeneration}`,
      (fate, event): ClaimFate => {
        if (this.eventEffect(binding, event).kind === 'detach')
          return fate.detachedAt === null
            ? { ...fate, detachedAt: event.at }
            : fate;
        return fate.detachedAt === null
          ? {
              ...fate,
              redirect: redirectAfter(event, binding.projectId, fate.redirect),
            }
          : fate;
      },
    );
  }

  /**
   * Applies a bound project's new lifecycle events, then publishes the
   * repository list and this device's selection while it is still bound.
   * Answers the project the binding ends on. The events read are recorded
   * even when publishing fails, so a binding whose publish keeps failing,
   * such as one whose project redirects, still reads on through its feed.
   */
  private async followBound(
    workspace: BindingWorkspace,
    local: LocalProject,
    binding: StoredBinding,
    session: Session,
  ): Promise<string> {
    let read: BoundRead;
    try {
      if (binding.movedTo !== undefined)
        return await this.followMoved(
          workspace,
          local,
          binding,
          binding.movedTo,
          session,
        );
      read = await this.readBound(session, binding);
      const { leave } = read;
      if (leave?.kind === 'merged')
        return await this.bindTo(
          workspace,
          local,
          session,
          leave.projectId,
          FOUND,
        );
      if (leave?.kind === 'moved')
        return await this.startMove(
          workspace,
          local,
          read.binding,
          session,
          leave.projectId,
        );
    } catch (error) {
      return this.boundFailed(workspace, local, binding, session, error, true);
    }
    let next = read.binding;
    try {
      if (next.detachedAt === undefined)
        next = await this.publish(
          local,
          workspace.suppressedSourceKeys,
          next,
          session,
        );
    } catch (error) {
      if (error instanceof BindingStop) throw error;
      await this.writeFollowed(workspace, binding, next, session);
      return this.boundFailed(
        workspace,
        local,
        next,
        session,
        error,
        read.complete,
      );
    }
    await this.writeFollowed(workspace, binding, next, session);
    return binding.projectId;
  }

  /**
   * A bound project's routes failed. A redirect is not a project gone: a
   * project that moved into an organization answers it until its checkout
   * moves back, also through a Personal catalog removal and restore. While
   * the bound feed has more to read (`feedEnd` false) it finds the redirect
   * on a later pass; otherwise the project's whole feed tells, read on from
   * pass to pass. After a Personal catalog removal the identity routes answer
   * 404 with no lifecycle event: the binding stops as after a delete, rather
   * than retrying a project that is gone on every pass.
   */
  private async boundFailed(
    workspace: BindingWorkspace,
    local: LocalProject,
    binding: StoredBinding,
    session: Session,
    error: unknown,
    feedEnd: boolean,
  ): Promise<string> {
    if (error instanceof BindingStop) throw error;
    const failure = this.failure(error);
    if (isProjectRedirected(failure)) {
      if (!feedEnd) throw error;
      const fate = await this.boundRedirect(session, binding);
      const { redirect, detachedAt } = fate.state;
      if (detachedAt !== null) {
        await this.writeDetached(workspace, binding, session, {
          ...binding,
          detachedAt,
          ...(fate.cursor === null ? {} : { eventCursor: fate.cursor }),
        });
        return binding.projectId;
      }
      if (!fate.complete || redirect === null) throw error;
      return redirect.kind === 'merged'
        ? this.bindTo(workspace, local, session, redirect.projectId, FOUND)
        : this.startMove(
            workspace,
            local,
            binding,
            session,
            redirect.projectId,
          );
    }
    if (!isProjectGone(failure)) throw error;
    await this.writeDetached(workspace, binding, session, {
      ...binding,
      detachedAt: this.deps.now().toISOString(),
    });
    return binding.projectId;
  }

  /** Replaces `binding` with its detached record, if it is still the one stored. */
  private async writeDetached(
    workspace: BindingWorkspace,
    binding: StoredBinding,
    session: Session,
    detached: StoredBinding,
  ): Promise<void> {
    await this.fence(session);
    await this.deps.writeBinding(workspace.workspaceId, (current) =>
      current.owner === undefined &&
      sameBindingKey(current.cloudBinding, binding)
        ? { cloudBinding: detached }
        : null,
    );
  }

  /** Records `next` over `binding` when a pass changed it. */
  private async writeFollowed(
    workspace: BindingWorkspace,
    binding: StoredBinding,
    next: StoredBinding,
    session: Session,
  ): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(binding)) return;
    await this.fence(session);
    await this.deps.writeBinding(workspace.workspaceId, (current) =>
      current.owner === undefined &&
      sameBindingKey(current.cloudBinding, binding)
        ? { cloudBinding: next }
        : null,
    );
  }

  /**
   * Reads the bound project's new events in feed order into the binding as
   * it stands after each one. A detach or delete is final: a later merge or
   * move in the same read is passed over, so the binding never rebinds on
   * its own once detached. A merge or move ends the read: the binding leaves
   * for that project.
   */
  private async readBound(
    session: Session,
    binding: StoredBinding,
  ): Promise<BoundRead> {
    let next: StoredBinding = { ...binding };
    const found: { leave: ProjectRedirect | null } = { leave: null };
    const { cursor, complete } = await this.readFeed(
      session,
      binding.projectId,
      feedPosition(binding.eventCursor),
      (event) => {
        const effect = this.eventEffect(binding, event);
        if (effect.kind === 'renamed')
          next = {
            ...next,
            name: effect.name,
            manifestRevision: Math.max(next.manifestRevision, effect.revision),
          };
        else if (next.detachedAt !== undefined) return undefined;
        else if (effect.kind === 'detach')
          next = { ...next, detachedAt: event.at };
        else if (effect.kind === 'rebind' || effect.kind === 'moved') {
          found.leave = {
            kind: effect.kind === 'rebind' ? 'merged' : 'moved',
            projectId: effect.projectId,
          };
          return 'stop';
        }
        return undefined;
      },
    );
    return {
      binding: cursor === null ? next : { ...next, eventCursor: cursor },
      complete,
      leave: found.leave,
    };
  }

  private eventEffect(
    binding: StoredBinding,
    event: CloudProjectLifecycleEvent,
  ):
    | { kind: 'none' }
    | { kind: 'rebind'; projectId: string }
    | { kind: 'moved'; projectId: string }
    | { kind: 'detach' }
    | { kind: 'renamed'; name: string; revision: number } {
    switch (event.type) {
      case 'merged_duplicate':
        return event.fromProjectId === binding.projectId
          ? { kind: 'rebind', projectId: event.toProjectId }
          : { kind: 'none' };
      case 'moved_to_organization':
        return event.fromProjectId === binding.projectId
          ? { kind: 'moved', projectId: event.toProjectId }
          : { kind: 'none' };
      case 'instance_detached':
        // A detach ends one claim; the same instance claimed again carries a
        // higher generation.
        return event.instanceId === binding.instanceId &&
          event.fencingGeneration === binding.bindingGeneration
          ? { kind: 'detach' }
          : { kind: 'none' };
      case 'deleted':
        return { kind: 'detach' };
      case 'renamed':
        return {
          kind: 'renamed',
          name: event.name,
          revision: event.manifestRevision,
        };
      case 'repository_remote_changed':
      case 'moved_to_personal':
      case 'archived':
      case 'restored':
        return { kind: 'none' };
    }
  }

  /**
   * The bound project moved into the organization project `orgProjectId`
   * (D20). The binding is kept, not detached: it publishes nothing, never
   * claims the organization project, and follows that project's feed for its
   * checkout's way back. That feed's end is read before the project itself,
   * so a return landing in between shows either in the project answering
   * again or in the feed after that position.
   */
  private async startMove(
    workspace: BindingWorkspace,
    local: LocalProject,
    binding: StoredBinding,
    session: Session,
    orgProjectId: string,
  ): Promise<string> {
    let move: BindingMove = { projectId: orgProjectId };
    try {
      const eventCursor = await this.currentCursor(session, orgProjectId);
      if (eventCursor !== null) move = { ...move, eventCursor };
    } catch (error) {
      if (!this.refusesMoveRead(error)) throw error;
      move = this.backedOff(move);
    }
    if (await this.projectAnswers(session, binding.projectId))
      return this.bindTo(workspace, local, session, binding.projectId, FOUND);
    await this.writeMove(workspace, binding, session, move);
    return binding.projectId;
  }

  /**
   * Follows a moved binding's organization project, on the pass's own
   * cadence (D20). A `moved_to_personal` back to this binding's project,
   * confirmed by the project answering again, claims it again; one naming
   * another Personal project is not this checkout's and is passed over. A
   * feed that refuses the read (403, 404 or 409) is read again after a
   * doubling wait.
   */
  private async followMoved(
    workspace: BindingWorkspace,
    local: LocalProject,
    binding: StoredBinding,
    move: BindingMove,
    session: Session,
  ): Promise<string> {
    if (
      move.retryAt !== undefined &&
      Date.parse(move.retryAt) > this.deps.now().getTime()
    )
      return binding.projectId;
    const found = { back: false };
    let cursor: string | null;
    try {
      ({ cursor } = await this.readFeed(
        session,
        move.projectId,
        feedPosition(move.eventCursor),
        (event) => {
          if (
            event.type === 'moved_to_personal' &&
            event.fromProjectId === move.projectId &&
            event.toProjectId === binding.projectId
          ) {
            found.back = true;
            return 'stop';
          }
          return undefined;
        },
      ));
    } catch (error) {
      if (!this.refusesMoveRead(error)) throw error;
      await this.writeMove(workspace, binding, session, this.backedOff(move));
      return binding.projectId;
    }
    if (found.back && (await this.projectAnswers(session, binding.projectId)))
      return this.bindTo(workspace, local, session, binding.projectId, FOUND);
    const next: BindingMove = {
      projectId: move.projectId,
      ...(cursor === null ? {} : { eventCursor: cursor }),
    };
    if (JSON.stringify(next) !== JSON.stringify(move))
      await this.writeMove(workspace, binding, session, next);
    return binding.projectId;
  }

  /** Whether the project answers again rather than redirecting. */
  private async projectAnswers(
    session: Session,
    projectId: string,
  ): Promise<boolean> {
    try {
      await session.cloud.manifest(projectId);
      return true;
    } catch (error) {
      if (isProjectRedirected(this.failure(error))) return false;
      throw error;
    }
  }

  /** A moved project's feed refusing this account, not a failure to retry at once. */
  private refusesMoveRead(error: unknown): boolean {
    const { status, transient } = this.failure(error);
    return !transient && (status === 403 || status === 404 || status === 409);
  }

  private backedOff(move: BindingMove): BindingMove {
    const failures = (move.failures ?? 0) + 1;
    const wait = Math.min(
      MOVE_BACKOFF_MS * 2 ** (failures - 1),
      MOVE_BACKOFF_MAX_MS,
    );
    return {
      ...move,
      failures,
      retryAt: new Date(this.deps.now().getTime() + wait).toISOString(),
    };
  }

  private async writeMove(
    workspace: BindingWorkspace,
    binding: StoredBinding,
    session: Session,
    move: BindingMove,
  ): Promise<void> {
    const moved: StoredBinding = { ...binding, movedTo: move };
    await this.fence(session);
    await this.deps.writeBinding(workspace.workspaceId, (current) =>
      current.owner === undefined &&
      sameBindingKey(current.cloudBinding, binding)
        ? { cloudBinding: moved }
        : null,
    );
  }

  /**
   * D10 and D9: publishes the local repository list when this device owns
   * it (`canopy.json` at the root, or local repositories the cloud manifest
   * lacks), then this device's selection. A conflicting write waits for the
   * next pass. A project that no longer has the workspace's topology gets
   * nothing, and the binding stays as it was: the server never changes a
   * project's topology, so it publishes again only once linked to a project
   * that fits (the Link dialog offers them) or converted back.
   */
  private async publish(
    local: LocalProject,
    suppressedSourceKeys: readonly string[],
    binding: StoredBinding,
    session: Session,
  ): Promise<StoredBinding> {
    let manifest = await session.cloud.manifest(binding.projectId);
    if (!fitsTopology(local, manifest)) return binding;
    try {
      manifest = await this.writeList(local, manifest, session);
    } catch (error) {
      if (error instanceof BindingStop) throw error;
      const failure = this.failure(error);
      if (failure.transient || failure.status === 409) return binding;
      throw error;
    }
    await this.publishSelection(
      local,
      suppressedSourceKeys,
      binding,
      manifest,
      session,
    );
    return {
      ...binding,
      name: manifest.name,
      manifestRevision: manifest.revision,
      repoListSource: manifest.repoListSource,
    };
  }

  private async publishSelection(
    local: LocalProject,
    suppressedSourceKeys: readonly string[],
    binding: StoredBinding,
    manifest: CloudProjectManifest,
    session: Session,
  ): Promise<void> {
    const localKeys = new Set(
      local.repositories
        .filter((repository) => repository.cloned)
        .map((repository) => repository.fingerprint.remoteKey),
    );
    const selected = manifest.repositories
      .filter((repository) => localKeys.has(repository.fingerprint.remoteKey))
      .map((repository) => repository.repositoryId);
    // Declined here: an entry of this checkout's own `canopy.json` its
    // `suppressedRepoIds` name (a checkout of another root does not share
    // those ids with the project), or the repository id a setup on this
    // device recorded for a cloud manifest repository (CAN-5192).
    const declined = local.repositories.filter(
      (repository) =>
        !repository.cloned &&
        repository.sourceKey !== null &&
        suppressedSourceKeys.includes(repository.sourceKey),
    );
    const dismissed = manifest.repositories
      .filter(
        (repository) =>
          !localKeys.has(repository.fingerprint.remoteKey) &&
          (suppressedSourceKeys.includes(repository.repositoryId) ||
            declined.some((entry) =>
              isSameRepository(entry.fingerprint, repository.fingerprint),
            )),
      )
      .map((repository) => repository.repositoryId);
    const current = await session.cloud.selection(binding.instanceId);
    const same = (left: readonly string[], right: readonly string[]): boolean =>
      left.length === right.length && left.every((id) => right.includes(id));
    if (
      same(current.selectedRepositoryIds, selected) &&
      same(current.dismissedRepositoryIds, dismissed)
    )
      return;
    try {
      await session.cloud.updateSelection(binding.instanceId, {
        ...current,
        selectedRepositoryIds: selected,
        dismissedRepositoryIds: dismissed,
      });
    } catch (error) {
      const failure = this.failure(error);
      if (!failure.transient && failure.status !== 409) throw error;
    }
  }
}

/** The workspace's Personal binding under this account, if it has one. */
function personalBinding(
  workspace: BindingWorkspace,
  accountId: string,
): StoredBinding | undefined {
  const binding = workspace.binding;
  return binding?.accountId === accountId && binding.ownerType === 'user'
    ? binding
    : undefined;
}
