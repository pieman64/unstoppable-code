import type { CanopyCloudCredentialContext } from '../canopy-cloud/client';
import { WorkspaceIdentityInUseError } from './workspace-service';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ORG_PROJECT_LIMITS,
  type ClaimOrgProjectInstanceRequest,
  type ClaimOrgProjectInstanceResponse,
  type CompleteOrgProjectInstanceRequest,
  type CreateMemberMultiRepoOrgProjectRequest,
  type CreateMemberOrgProjectRequest,
  type OrgProjectActivityTransferCounts,
  type OrgProjectActivityTransferRequest,
  type OrgProjectSetupProgress,
  type OrgProjectSummary,
  type PersonalActivityReturnRequest,
} from '@canopy/protocol/org-projects';
import type {
  DesktopOrgProjectCatalogSnapshot,
  OrgProjectConversionErrorCode,
  OrgProjectConversionResult,
  OrgProjectConvertCoworkWorkspaceRequest,
  OrgProjectConvertMultiRepoWorkspaceRequest,
  OrgProjectConvertWorkspaceRequest,
  OrgProjectMoveBackResult,
  OrgProjectMoveBackToPersonalRequest,
  OrgProjectOwnershipChangedEvent,
  PreferencesData,
  SidebarItem,
  TelemetrySharingPreferences,
  WorkspaceContext,
  WorkspaceOwnerBinding,
  WorkspaceOwnershipTransfer,
} from '@canopy/desktop-shared/types';
import { resolveActivityRepairSharing } from '@canopy/desktop-shared/lib/telemetry-enforcement';
import {
  activityRepairTarget,
  classifyActivityRepairFailure,
  type ActivityRepairLedger,
} from './activity-scope-repair';
import type {
  WorkspaceOwnership,
  WorkspaceOwnershipRead,
  WorkspaceOwnershipUpdate,
} from './workspace-persistence';
import type { WorkspaceIndexAuthority } from './workspace-index-repository';
import {
  computeRelationships,
  holdsOrganizationRepository,
} from './org-project-relationships';
import { normalizeRemoteUrl } from './repo-url-matcher';
import { isDefaultCoworkWorkspaceId } from '@canopy/protocol/ui-labels';
import {
  getProjectConfigFileCandidates,
  readCanopyJson,
  hasManifestRepos,
} from './canopy-json';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import type { WorkspaceOwnershipChange } from '../services/background-execution-rebinding';
import { writeFileAtomically } from './atomic-file';
import { buildOrgProjectCloneUrl } from './org-project-clone-url';
import { classifyGitHubAuthFailure } from './github-push-auth-failure';
import {
  normalizeSetupJournal,
  setupOwner,
  type SetupJournal,
  type SetupPhase,
} from './org-project-setup-journal';

/**
 * What the server answered a request to move a checkout's uploaded activity
 * to its organization, or why the request failed (CAN-3601).
 */
export type ActivityMoveReport = { projectId: string } & (
  | {
      result: 'answered';
      outcome: string;
      transferId: string | null;
      counts: OrgProjectActivityTransferCounts | null;
    }
  | {
      result: 'failed';
      status: number | null;
      serverCode: string | null;
      error: string;
    }
);

export interface OrgProjectMaterializationDeps {
  catalog: {
    list(context: WorkspaceContext): Promise<DesktopOrgProjectCatalogSnapshot>;
    refresh(
      context: WorkspaceContext,
      options: { force: true },
    ): Promise<DesktopOrgProjectCatalogSnapshot>;
  };
  cowork: {
    setUp(input: {
      organizationId: string;
      projectId: string;
      name: string;
    }): Promise<{ instanceId: string }>;
  };
  cloud: {
    claim(
      projectId: string,
      request: ClaimOrgProjectInstanceRequest,
      credentialContext?: CanopyCloudCredentialContext,
    ): Promise<ClaimOrgProjectInstanceResponse>;
    complete(
      instanceId: string,
      request: CompleteOrgProjectInstanceRequest,
      credentialContext?: CanopyCloudCredentialContext,
    ): Promise<unknown>;
    detach(
      instanceId: string,
      credentialContext?: CanopyCloudCredentialContext,
    ): Promise<unknown>;
    /**
     * Create, or on a retry for the same local project reuse, the member's
     * private multi-repo organization project (CAN-3532).
     */
    createMemberMultiRepoProject(
      request: CreateMemberMultiRepoOrgProjectRequest,
      credentialContext?: CanopyCloudCredentialContext,
    ): Promise<OrgProjectSummary>;
    /**
     * Create the member's private Cowork organization project for a Personal
     * Cowork project being moved. Idempotent per `creationKey`: the server
     * returns the definition it already made for that key.
     */
    createMemberCoworkProject(
      request: Extract<CreateMemberOrgProjectRequest, { kind: 'COWORK' }>,
    ): Promise<OrgProjectSummary>;
    /**
     * Move the checkout's already-uploaded Personal activity to the
     * project's organization (CAN-3418). Idempotent on the server.
     */
    moveActivity(
      projectId: string,
      request: OrgProjectActivityTransferRequest,
      credentialContext?: CanopyCloudCredentialContext,
    ): Promise<unknown>;
    /** Return that activity to Personal. Idempotent on the server. */
    returnActivity(
      projectId: string,
      request: OrgProjectActivityTransferRequest,
      credentialContext?: CanopyCloudCredentialContext,
    ): Promise<unknown>;
    /**
     * Return a Personal checkout's activity that was uploaded to an
     * organization before CAN-3515 (CAN-3517). Idempotent on the server.
     */
    returnPersonalActivity(
      request: PersonalActivityReturnRequest,
    ): Promise<unknown>;
  };
  /** Repair of activity filed under the wrong scope (CAN-3517). */
  activityRepair: {
    /**
     * The member's effective sharing for work this organization governs, or
     * `null` when it cannot be read now (the next launch tries again).
     */
    sharingFor(
      organizationId: string,
    ): Promise<TelemetrySharingPreferences | null>;
    ledger: ActivityRepairLedger;
  };
  git: {
    clone(
      url: string,
      dest: string,
      options: { signal: AbortSignal; onProgress: (percent: number) => void },
    ): Promise<void>;
  };
  workspace: {
    /**
     * Injected rather than imported: `workspace-service` reaches Electron, and
     * this module is the pure, testable half of materialization.
     */
    buildLocalWorkspaceId(repoName: string, items: SidebarItem[]): string;
    createBoundWorkspace(
      path: string,
      localWorkspaceId: string,
      owner: WorkspaceOwnerBinding,
      preferredName?: string,
    ): Promise<void>;
    applyManagedPrivateMemory(input: {
      workspaceId: string;
      organizationId: string;
      projectId: string;
      privateMemory: boolean;
    }): Promise<void>;
    /** Remove only an adopted workspace's index entry when this instance still owns it. */
    removeBoundWorkspace(
      localWorkspaceId: string,
      instanceId: string,
    ): Promise<boolean>;
    /** Authoritative ownership of an existing workspace (conversion). */
    readOwnership(workspaceId: string): Promise<WorkspaceOwnershipRead>;
    /** Compare-and-set of an existing workspace's ownership (conversion). */
    updateOwnership(
      workspaceId: string,
      update: (
        current: Extract<WorkspaceOwnershipRead, { authority: 'ok' }>,
      ) => WorkspaceOwnership | null,
    ): Promise<WorkspaceOwnershipUpdate>;
    /** The checkout's `origin`; `null` without one, throws when unknowable. */
    readRemoteUrl(repoPath: string): Promise<string | null>;
  };
  backgroundExecution: {
    /**
     * Move the workspace's automations, watchers and hook actions to its new
     * owner (CAN-3543), after the ownership write. Best effort: it never
     * fails the conversion or move back that already happened.
     */
    ownershipChanged(change: WorkspaceOwnershipChange): Promise<void>;
  };
  /**
   * Make a move's answer or refusal visible (CAN-3601). Best effort: a
   * report that throws never fails the move or the sweep.
   */
  reportActivityMove(report: ActivityMoveReport): void;
  resolveDeviceId(): Promise<string>;
  readInstallationGeneration(deviceId: string): Promise<number>;
  now(): string;
  paths: {
    setupsDir(): string;
    /** A Cowork project's folder: its external folder, or its managed home. */
    coworkRootDir(
      workspaceId: string,
      externalPath: string | undefined,
    ): string;
  };
  /** Fresh server exclusion check immediately before automatic mutations. */
  automaticConversionAllowed?(
    organizationId: string,
    accountId: string,
  ): Promise<boolean>;
  access(): Promise<{
    context: WorkspaceContext;
    accountId: string;
    enabled: boolean;
    capabilities: readonly string[];
  }>;
  preferences(): Promise<
    Pick<
      PreferencesData,
      'orgProjectDefaultDestinationRoot' | 'orgProjectCloneProtocol'
    >
  >;
  readItems(): Promise<SidebarItem[]>;
  /**
   * The items with the authority of the reads they came from. Only `ok` or
   * `absent` proves that no workspace is bound to a project.
   */
  readItemsSnapshot(): Promise<{
    items: SidebarItem[];
    authority: WorkspaceIndexAuthority;
  }>;
  hasPersonalRelationship(projectId: string): Promise<boolean>;
  resolveTokenSource(): Promise<'pat' | 'gh-cli' | 'none'>;
  cloneBase?: string;
  /**
   * Called after each journal checkpoint is durable. Production logs the
   * phase and, in unpackaged builds only, can hold the run there so a phase
   * can be interrupted on purpose (see the QA notes in the materialization
   * reference).
   */
  checkpointed?(
    journal: Pick<SetupJournal, 'journalId' | 'projectId'>,
    phase: SetupPhase,
  ): Promise<void>;
}
export interface OrgProjectMaterialization {
  startSetup(
    projectId: string,
    destinationRoot: string,
  ): Promise<OrgProjectSetupProgress>;
  cancelSetup(projectId: string): Promise<void>;
  adoptCheckout(
    input: {
      projectId: string;
      organizationId: string;
      path: string;
      preferredName: string;
    },
    options?: { createdRepo?: boolean },
  ): Promise<{ localWorkspaceId: string }>;
  setupFromFolder(
    projectId: string,
    path: string,
  ): Promise<OrgProjectSetupProgress>;
  /**
   * Bind an existing Personal checkout to the organization project for its
   * repository, in place (CAN-3415). The same claim, binding and fenced
   * completion as setup; the checkout, worktrees and chats keep their ids.
   */
  convertWorkspace(
    request: OrgProjectConvertWorkspaceRequest,
    options?: OrgProjectConversionOptions,
  ): Promise<OrgProjectConversionResult>;
  /**
   * Bind an existing Personal multi-repo project in place (CAN-3532) when
   * every repository in it is one of the organization's projects: the
   * member's private multi-repo organization project is created (or reused)
   * for it, then claimed, bound and completed exactly as `convertWorkspace`
   * does.
   */
  convertMultiRepoWorkspace(
    request: OrgProjectConvertMultiRepoWorkspaceRequest,
    options?: OrgProjectConversionOptions,
  ): Promise<OrgProjectConversionResult>;
  /**
   * Bind an existing Personal Cowork project in place to a new private Cowork
   * project of the organization, with the same claim, binding and fenced
   * completion as `convertWorkspace`. Default Chats spaces never convert.
   */
  convertCoworkWorkspace(
    request: OrgProjectConvertCoworkWorkspaceRequest,
    options?: OrgProjectConversionOptions,
  ): Promise<OrgProjectConversionResult>;
  /** Undo a conversion: release the instance and restore Personal. */
  moveBackToPersonal(
    request: OrgProjectMoveBackToPersonalRequest,
  ): Promise<OrgProjectMoveBackResult>;
  onOwnershipChanged(
    listener: (event: OrgProjectOwnershipChangedEvent) => void,
  ): () => void;
  /**
   * Finish setups the app exited during after promotion (CAN-3130), reclaim
   * lapsed claims (CAN-3129), and retire every other leftover journal.
   */
  sweepInterruptedSetups(): Promise<void>;
  subscribe(listener: (progress: OrgProjectSetupProgress) => void): () => void;
}
export interface OrgProjectConversionOptions {
  credentialContext?: CanopyCloudCredentialContext;
  beforeMutation?: () => Promise<void>;
  onMemberCreated?: (projectId: string) => Promise<void>;
  /** New member-owned multi-repo definition only; the server owns the value. */
  privateMemory?: boolean;
  /**
   * Automatic conversion (CAN-3416): refuse, as `previously-converted`, a
   * workspace that already carries an `ownershipTransfer`. Moving back to
   * Personal is permanent for automatic conversion, and the precondition is
   * re-checked inside the ownership write, so a move back that lands while a
   * run is deciding cannot be undone by it.
   */
  automatic?: boolean;
  /** The member's own fresh private definition may not have a repository yet. */
  memberCreated?: boolean;
}

export class OrgProjectAdoptionError extends Error {
  constructor(
    message: string,
    readonly completionSent: boolean,
  ) {
    super(message);
    this.name = 'OrgProjectAdoptionError';
  }
}
/** The server's outcome for a repair call, for the ledger. */
function repairOutcome(response: unknown): string {
  return typeof response === 'object' &&
    response !== null &&
    'outcome' in response &&
    typeof response.outcome === 'string'
    ? response.outcome.slice(0, 64)
    : 'done';
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function transferCounts(
  value: unknown,
): OrgProjectActivityTransferCounts | null {
  if (!isObject(value)) return null;
  const {
    worktrees,
    turns,
    plans,
    pullRequests,
    skippedPullRequests,
    pipelineRuns,
    rekeyedBodies,
  } = value;
  if (
    typeof worktrees !== 'number' ||
    typeof turns !== 'number' ||
    typeof plans !== 'number' ||
    typeof pullRequests !== 'number' ||
    typeof skippedPullRequests !== 'number' ||
    typeof pipelineRuns !== 'number' ||
    typeof rekeyedBodies !== 'number'
  )
    return null;
  return {
    worktrees,
    turns,
    plans,
    pullRequests,
    skippedPullRequests,
    pipelineRuns,
    rekeyedBodies,
  };
}
function answeredMove(
  projectId: string,
  response: unknown,
): ActivityMoveReport {
  const transferId = isObject(response) ? response.transferId : undefined;
  return {
    projectId,
    result: 'answered',
    outcome: repairOutcome(response),
    transferId: typeof transferId === 'string' ? transferId : null,
    counts: transferCounts(isObject(response) ? response.counts : undefined),
  };
}
function failedMove(projectId: string, error: unknown): ActivityMoveReport {
  const cloud = error instanceof CanopyCloudClientError ? error : undefined;
  return {
    projectId,
    result: 'failed',
    status: cloud?.status ?? null,
    serverCode: cloud?.serverCode ?? null,
    error: error instanceof Error ? error.message : String(error),
  };
}
/** Remember a refusal no later launch can change; leave the rest to retry. */
async function recordFailure(
  error: unknown,
  record: (outcome: string) => Promise<void>,
): Promise<void> {
  const failure = classifyActivityRepairFailure(error);
  if (failure !== 'retry') await record(failure);
}
class SetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const COPY = {
  claiming: 'Claiming a setup slot',
  materializing: 'Setting up the project',
  credentials: 'Cloning with your Git credentials',
  ready: 'Ready',
  'needs-credentials': 'GitHub access is needed to clone this repository',
  // Same copy; the code tells the renderer that a GitHub sign-in can recover.
  'github-not-authenticated':
    'GitHub access is needed to clone this repository',
  'unsupported-topology':
    'This repository holds several projects, which is not supported yet',
  'unsupported-multi-repo':
    'This project has several repositories, which setup does not support yet',
  'claim-expired':
    'Your files are ready, but setup lost its place in the queue before it finished',
  'unsupported-location':
    'This project does not run on your machine, so it cannot be set up here',
  'unsupported-project-file':
    "This repository's project file cannot be read safely",
  'access-removed': 'Your access to this project changed',
  'completion-pending':
    'Your files are ready, but setup did not finish with your organization',
  superseded: 'A newer setup of this project superseded this attempt',
  cancelled: 'Setup cancelled',
};
function fail(code: keyof typeof COPY): never {
  throw new SetupError(code, COPY[code]);
}
/** A conversion precondition that did not hold; nothing was changed for it. */
class ConversionRefusal extends Error {
  constructor(readonly code: OrgProjectConversionErrorCode) {
    super(code);
  }
}
function refuse(code: OrgProjectConversionErrorCode): never {
  throw new ConversionRefusal(code);
}
/** The code a conversion that got as far as a claim reports for a failure. */
function conversionFailureCode(
  error: unknown,
  setupCode: string,
): OrgProjectConversionErrorCode {
  if (error instanceof ConversionRefusal) return error.code;
  if (setupCode === 'access-removed') return 'project-unavailable';
  if (
    setupCode === 'completion-pending' ||
    (error instanceof CanopyCloudClientError && error.code === 'network-error')
  )
    return 'offline';
  return 'conversion-failed';
}
/** Why the organization would not create a member's multi-repo project. */
function memberProjectRefusal(error: unknown): OrgProjectConversionErrorCode {
  if (!(error instanceof CanopyCloudClientError)) return 'conversion-failed';
  if (error.code === 'network-error') return 'offline';
  if (error.status === 409 && error.serverCode === 'member_project_limit')
    return 'member-project-limit';
  if (error.status === 409 && error.serverCode === 'repository_mismatch')
    return 'repository-mismatch';
  // 404 is also a server that predates the route.
  if (error.status === 404 || error.status === 403)
    return 'project-unavailable';
  return 'conversion-failed';
}
/** Every checkout of a multi-repo project: its root when it has one, then each child. */
function multiRepoCheckouts(
  item: Extract<SidebarItem, { type: 'multi-repo' }>,
): string[] {
  const paths = [
    item.sourceRepoPath,
    ...item.repos.map((repo): string => repo.repoPath),
  ].flatMap((path): string[] => (path ? [resolve(path)] : []));
  return Array.from(new Set(paths));
}
function sameTransfer(
  left: WorkspaceOwnershipTransfer | undefined,
  right: WorkspaceOwnershipTransfer | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    throw error;
  }
}
/**
 * The claim's idempotency key. The attempt nonce is what makes a retry
 * possible: the server refuses to reuse a key whose operation is failed,
 * cancelled or detached ("start a new claim"), so a key derived only from
 * account, device and project would make one terminal attempt the last one
 * this device can ever make for that project. The nonce is rotated exactly
 * when an attempt ends terminally, so an interrupted attempt still resumes
 * under the key it claimed with.
 */
function key(
  accountId: string,
  deviceId: string,
  projectId: string,
  attemptNonce: string,
): string {
  return createHash('sha256')
    .update(`${accountId}:${deviceId}:${projectId}:${attemptNonce}`)
    .digest('hex');
}
/**
 * The clone is repository-controlled content, and the shared manifest reader
 * follows symlinks and reads without a bound. A committed `canopy.json`
 * pointing at an endless device would otherwise be buffered into the main
 * process until it dies, so the manifest has to be an ordinary, small file
 * inside the checkout before anything reads it.
 */
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * A server that can verify a reclaim (CAN-3129). An older one would take the
 * reclaim for a fresh claim, which can revive a superseded instance, so it is
 * never asked.
 */
const RECLAIM_CAPABILITY = 'org-project-reclaim-v1';

export async function rejectUnsafeManifest(stagingPath: string): Promise<void> {
  for (const candidate of getProjectConfigFileCandidates(stagingPath)) {
    let info;
    try {
      info = await lstat(candidate);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_MANIFEST_BYTES)
      fail('unsupported-project-file');
  }
}

const NONCES = 'attempt-nonces.json';

/** What a retained attempt claimed under, so a retry can present it again. */
interface AttemptIdentity {
  nonce: string;
  /** The workspace id the claim body carried. */
  localWorkspaceId: string;
}

/**
 * Per-project attempt identities, kept beside the journals they authorize and
 * versioned like every other persisted file. Anything unreadable, older or
 * newer falls back to an empty map, which costs at most one extra claim.
 *
 * The workspace id belongs here with the nonce: the key is an idempotency key
 * over a *request*, and a retry that recomputes the id from a sidebar which
 * has moved would present the same key with a different body, which the server
 * rejects as a digest conflict.
 */
/** An entry is only usable if it names both halves of what was claimed. */
function normalizeAttemptIdentity(value: unknown): AttemptIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record: Record<string, unknown> = Object.fromEntries(
    Object.entries(value),
  );
  const { nonce, localWorkspaceId } = record;
  if (typeof nonce !== 'string' || typeof localWorkspaceId !== 'string')
    return null;
  return { nonce, localWorkspaceId };
}

async function readAttemptNonces(
  dir: string,
): Promise<Record<string, AttemptIdentity>> {
  try {
    const text = await readFile(join(dir, NONCES), 'utf8');
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
      return {};
    const record: Record<string, unknown> = Object.fromEntries(
      Object.entries(raw),
    );
    const { version, nonces } = record;
    if (
      version !== 2 ||
      typeof nonces !== 'object' ||
      nonces === null ||
      Array.isArray(nonces)
    )
      return {};
    const entries: Array<[string, AttemptIdentity]> = [];
    for (const [projectId, value] of Object.entries(nonces)) {
      const identity = normalizeAttemptIdentity(value);
      if (identity) entries.push([projectId, identity]);
    }
    return Object.fromEntries(entries);
  } catch (error) {
    // Malformed content takes the empty default every persisted file here
    // takes: its contents are unusable either way, and one corrupt bookkeeping
    // file must not make a project impossible to set up. A read that *failed*
    // is a different answer: the store may be perfectly good and merely
    // unavailable, and calling that "empty" would let a retirement report
    // success while the spent nonce is still on disk.
    if (error instanceof SyntaxError) return {};
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return {};
    throw error;
  }
}

function serializeAttemptNonces(
  nonces: Record<string, AttemptIdentity>,
): string {
  return JSON.stringify({ version: 2, nonces });
}

interface Attempt {
  credentialContext?: CanopyCloudCredentialContext;
  beforeMutation?: () => Promise<void>;
  controller: AbortController;
  /** Set before the claim leaves, so an unanswered one is not mistaken for one that never went. */
  claimSent?: boolean;
  first: OrgProjectSetupProgress;
  done: Promise<void>;
  journal?: SetupJournal;
  promoted: boolean;
  /** A completion request went out, so its outcome is not knowable locally. */
  completionSent?: boolean;
  /**
   * The instance a claim actually returned, held from the moment the response
   * arrives until the journal that records it exists. Everything between those
   * two points touches the filesystem and can throw, and a claim nobody wrote
   * down is still a claim the server is holding.
   */
  claimed?: string;
  /**
   * The rename actually happened, so the final path holds this attempt's
   * checkout. `promoted` is the *intent* — it locks cancellation before the
   * rename — and a rename that throws leaves whatever is at that path alone.
   */
  renamed?: boolean;
  /**
   * Binding was *started*. `createBoundWorkspace` persists the workspace index
   * before it writes the rest of a workspace's metadata, so a failure part-way
   * through still leaves durable state pointing at the checkout. Deleting it
   * then would strand that state, which makes the attempt — not its success —
   * the thing worth recording.
   */
  bindStarted?: boolean;
  ownsStaging: boolean;
  /** Converting an existing workspace in place: no staging, no setup progress. */
  conversion?: boolean;
  /** Binding a checkout that was not previously in the workspace index. */
  adoption?: boolean;
  /**
   * Started by the startup sweep, before any window can be listening: it
   * reports nothing until a start from the renderer joins it.
   */
  quiet?: boolean;
}

export function createOrgProjectMaterialization(
  deps: OrgProjectMaterializationDeps,
): OrgProjectMaterialization {
  const attempts = new Map<string, Attempt>();
  const listeners = new Set<(progress: OrgProjectSetupProgress) => void>();
  const ownershipListeners = new Set<
    (event: OrgProjectOwnershipChangedEvent) => void
  >();
  /** Workspaces a conversion or move back is changing right now. */
  const changingWorkspaces = new Set<string>();
  /** The dep already logs; a rejection must still never undo the move. */
  async function rebindBackgroundExecution(
    change: WorkspaceOwnershipChange,
  ): Promise<void> {
    await deps.backgroundExecution
      .ownershipChanged(change)
      .catch((): void => {});
  }
  function emitOwnership(event: OrgProjectOwnershipChangedEvent): void {
    for (const listener of Array.from(ownershipListeners)) {
      try {
        listener(event);
      } catch {
        /* A renderer listener cannot interrupt ownership changes. */
      }
    }
  }
  let sweeping: Promise<void> | undefined;
  function emit(
    projectId: string,
    state: OrgProjectSetupProgress['state'],
    message: string,
    journal?: Pick<SetupJournal, 'instanceId'>,
    percent: number | null = null,
    errorCode?: string,
  ): OrgProjectSetupProgress {
    const progress: OrgProjectSetupProgress = {
      projectId,
      instanceId: journal?.instanceId ?? null,
      state,
      message,
      percent,
      updatedAt: deps.now(),
      ...(errorCode ? { errorCode } : {}),
    };
    if (attempts.get(projectId)?.quiet === true) return progress;
    for (const listener of Array.from(listeners)) {
      try {
        listener(progress);
      } catch {
        /* A renderer listener cannot interrupt persistence. */
      }
    }
    return progress;
  }
  /**
   * The nonce an attempt claims under. It is created once per project and
   * rotated only when an attempt ends terminally, so a crash between the claim
   * and the journal write resumes under the same key rather than orphaning the
   * server-side claim behind a key nobody will present again.
   */
  // The store is one file shared by every project, so read-modify-write has to
  // be serialized: atomic replacement stops a torn file, not a lost update.
  let nonceWrites: Promise<unknown> = Promise.resolve();
  function serializeNonceWrite<T>(work: () => Promise<T>): Promise<T> {
    const next = nonceWrites.then(work, work);
    nonceWrites = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async function attemptNonce(
    projectId: string,
    localWorkspaceId: string,
  ): Promise<AttemptIdentity> {
    return serializeNonceWrite(() =>
      readOrCreateAttemptNonce(projectId, localWorkspaceId),
    );
  }
  async function readOrCreateAttemptNonce(
    projectId: string,
    localWorkspaceId: string,
  ): Promise<AttemptIdentity> {
    const dir = deps.paths.setupsDir();
    const nonces = await readAttemptNonces(dir);
    // A retained identity is replayed whole. Recomputing the workspace id from
    // a sidebar that has moved would send the same key over a different body.
    const current = nonces[projectId];
    if (current) return current;
    const next: AttemptIdentity = { nonce: randomUUID(), localWorkspaceId };
    await mkdir(dir, { recursive: true });
    await writeFileAtomically(
      join(dir, NONCES),
      serializeAttemptNonces({ ...nonces, [projectId]: next }),
      { mode: 0o600 },
    );
    return next;
  }
  async function rotateAttemptNonce(projectId: string): Promise<void> {
    return serializeNonceWrite(() => dropAttemptNonce(projectId));
  }
  async function dropAttemptNonce(projectId: string): Promise<void> {
    const dir = deps.paths.setupsDir();
    const nonces = await readAttemptNonces(dir);
    if (!nonces[projectId]) return;
    const rest = Object.fromEntries(
      Object.entries(nonces).filter(([id]) => id !== projectId),
    );
    // An empty store leaves no file behind: this directory means "setups in
    // flight", and a stray bookkeeping file would say otherwise.
    if (Object.keys(rest).length === 0) {
      await rm(join(dir, NONCES), { force: true });
      return;
    }
    await mkdir(dir, { recursive: true });
    await writeFileAtomically(join(dir, NONCES), serializeAttemptNonces(rest), {
      mode: 0o600,
    });
  }
  async function checkpoint(
    journal: SetupJournal,
    phase: SetupPhase,
    errorCode?: string,
  ): Promise<void> {
    journal.phase = phase;
    journal.updatedAt = deps.now();
    journal.errorCode = errorCode;
    await mkdir(deps.paths.setupsDir(), { recursive: true });
    await writeFileAtomically(
      join(deps.paths.setupsDir(), `${journal.journalId}.json`),
      JSON.stringify(journal),
      { mode: 0o600 },
    );
    await deps.checkpointed?.(journal, phase);
    // A conversion has no row of its own to show progress on: the project's
    // setup offer must not flash while an existing checkout is being bound.
    if (
      journal.conversion === undefined &&
      ['validated', 'promoted', 'bound', 'completing'].includes(phase)
    )
      emit(journal.projectId, 'materializing', COPY.materializing, journal);
  }
  /**
   * Undo an unfinished conversion's binding. Only the binding this journal
   * wrote is undone, and the conversion record the workspace had before comes
   * back with it. `false` means the workspace could not be read, so nothing
   * was restored and the journal must stay in flight.
   */
  async function restorePersonal(journal: SetupJournal): Promise<boolean> {
    const outcome = await deps.workspace.updateOwnership(
      journal.localWorkspaceId,
      (current) =>
        current.owner?.instanceId === journal.instanceId &&
        current.owner.projectId === journal.projectId
          ? {
              owner: undefined,
              ownershipTransfer: journal.conversion?.previousOwnershipTransfer,
            }
          : null,
    );
    // The binding may already have been read by the renderer (or anything
    // else listening), so undoing it is announced like any other change.
    if (outcome === 'written')
      emitOwnership({
        workspaceId: journal.localWorkspaceId,
        organizationId: journal.organizationId,
        projectId: journal.projectId,
        owner: 'personal',
      });
    return outcome !== 'unreadable';
  }
  async function validateRoot(root: string): Promise<string> {
    if (
      typeof root !== 'string' ||
      !isAbsolute(root) ||
      !(await stat(root).catch((): null => null))?.isDirectory()
    )
      throw new SetupError(
        'invalid-destination',
        'Choose an existing absolute destination folder',
      );
    const canonical = await realpath(root);
    for (const item of await deps.readItems()) {
      const paths =
        item.type === 'single-repo'
          ? [item.repoPath]
          : item.type === 'multi-repo'
            ? [item.sourceRepoPath, ...item.repos.map((repo) => repo.repoPath)]
            : [];
      for (const path of paths) {
        if (!path) continue;
        const checkout = await realpath(path).catch(() => null);
        if (checkout && inside(checkout, canonical))
          throw new SetupError(
            'invalid-destination',
            'Choose a destination outside existing workspaces',
          );
      }
    }
    return canonical;
  }
  async function checkAccess(journal: SetupJournal): Promise<WorkspaceContext> {
    const access = await deps.access();
    const deviceId = await deps.resolveDeviceId();
    if (
      !access.enabled ||
      !access.capabilities.includes('org-projects-v1') ||
      key(
        access.accountId,
        deviceId,
        journal.projectId,
        journal.attemptNonce,
      ) !== journal.idempotencyKey
    )
      fail('access-removed');
    const context: WorkspaceContext = {
      kind: 'organization',
      organizationId: journal.organizationId,
    };
    const snapshot = await deps.catalog.refresh(context, { force: true });
    if (snapshot.error === 'offline') {
      if (['promoted', 'bound', 'completing'].includes(journal.phase))
        fail('completion-pending');
      throw new SetupError(
        'offline',
        'Project access could not be checked while offline',
      );
    }
    if (
      snapshot.stale ||
      snapshot.error ||
      !snapshot.projects.some(
        (row) =>
          row.id === journal.projectId &&
          row.organizationId === journal.organizationId &&
          row.listed &&
          row.capabilities.use,
      )
    )
      fail('access-removed');
    return context;
  }
  /**
   * The id was chosen from a sidebar snapshot taken before the claim and the
   * clone; an ordinary project created in between can have taken it. Re-derive
   * against the current list and persist the result, so a promoted checkout is
   * never stuck behind a name someone else now owns.
   */
  async function bindCheckout(
    journal: SetupJournal,
    path: string,
    preferredName?: string,
  ): Promise<void> {
    // The id is the one the server recorded with the claim, and the one a
    // reclaim has to present again (CAN-3129). Another workspace already bound
    // to the project is a refusal, never a reason to re-point the journal at
    // it: that would bind under an id the claim does not carry.
    const bound = (await deps.readItems()).find(
      (item) =>
        item.owner?.type === 'organization' &&
        item.owner.projectId === journal.projectId &&
        item.owner.organizationId === journal.organizationId,
    );
    if (bound && bound.id !== journal.localWorkspaceId)
      throw new SetupError(
        'project-already-bound',
        'This project is already a workspace',
      );
    const owner = setupOwner(journal);
    if (preferredName === undefined) {
      await deps.workspace.createBoundWorkspace(
        path,
        journal.localWorkspaceId,
        owner,
      );
    } else {
      await deps.workspace.createBoundWorkspace(
        path,
        journal.localWorkspaceId,
        owner,
        preferredName,
      );
    }
    const summary = await deps.catalog.list({
      kind: 'organization',
      organizationId: journal.organizationId,
    });
    const project = summary.projects.find(
      (row) => row.id === journal.projectId,
    );
    if (!project) fail('access-removed');
    if (typeof project.privateMemory === 'boolean') {
      await deps.workspace.applyManagedPrivateMemory({
        workspaceId: journal.localWorkspaceId,
        organizationId: journal.organizationId,
        projectId: journal.projectId,
        privateMemory: project.privateMemory,
      });
    }
  }

  /**
   * A setup (not a conversion or adoption) that got as far as promoting its
   * checkout: resumed rather than retired (CAN-3130). Every earlier phase
   * still retires, as does every conversion and adoption.
   */
  function resumable(journal: SetupJournal): boolean {
    return (
      journal.conversion === undefined &&
      journal.adoption === undefined &&
      ['promoted', 'bound', 'completing', 'reclaiming'].includes(journal.phase)
    );
  }
  /** The phase as it is now; `checkpoint` changes it under a narrowed read. */
  function phaseOf(journal: SetupJournal): SetupPhase {
    return journal.phase;
  }
  /** A real directory holding a Git repository, never a symlink. */
  async function repositoryAt(path: string): Promise<boolean> {
    const info = await lstat(path).catch((): null => null);
    if (!info?.isDirectory()) return false;
    return (await lstat(join(path, '.git')).catch((): null => null)) !== null;
  }
  /**
   * Where a promoted journal's checkout is, decided only from the paths the
   * journal itself recorded: its own staging directory, whose name no other
   * run uses, and the final path it checked was free before recording
   * `promoted`. The rename between them is atomic, so exactly one of the two
   * holds the checkout. Both or neither means something else touched them,
   * and nothing is adopted on a guess.
   */
  async function promotedCheckout(
    journal: SetupJournal,
  ): Promise<'staged' | 'renamed' | null> {
    const root = await realpath(journal.destinationRoot).catch(
      (): null => null,
    );
    if (root !== journal.destinationRoot) return null;
    const staged = await exists(journal.stagingPath);
    const renamed = await exists(journal.finalPath);
    if (staged && !renamed && (await repositoryAt(journal.stagingPath)))
      return 'staged';
    if (renamed && !staged && (await repositoryAt(journal.finalPath)))
      return 'renamed';
    return null;
  }
  /**
   * Whether an interrupted setup can be finished from what is on disk. A
   * journal that cannot is retired like any other interrupted run, leaving
   * the disk as it is.
   */
  async function canResume(journal: SetupJournal): Promise<boolean> {
    if (journal.phase === 'promoted')
      return (await promotedCheckout(journal)) !== null;
    if (journal.phase === 'bound')
      return (
        (await promotedCheckout(journal)) === 'renamed' ||
        ((await boundTo(journal)) && (await repositoryAt(journal.finalPath)))
      );
    // `completing` and `reclaiming` bound the workspace before they were
    // written; a user who has since removed it has nothing left to finish.
    return boundTo(journal);
  }
  /**
   * The journal's checkout is still the workspace it bound: same id, same
   * organization project, same instance. The fence is not compared — moving
   * it forward is exactly what a reclaim does.
   */
  async function boundTo(journal: SetupJournal): Promise<boolean> {
    return (await deps.readItems()).some(
      (item): boolean =>
        item.id === journal.localWorkspaceId &&
        item.owner?.type === 'organization' &&
        item.owner.organizationId === journal.organizationId &&
        item.owner.projectId === journal.projectId &&
        item.owner.instanceId === journal.instanceId,
    );
  }
  /**
   * Whether this account, device and server can finish the journal now. The
   * startup sweep keeps anything else for a later launch rather than
   * terminalizing it on a transient startup state.
   */
  function canFinishNow(
    access: Awaited<ReturnType<OrgProjectMaterializationDeps['access']>>,
    deviceId: string,
    journal: SetupJournal,
  ): boolean {
    return (
      access.enabled &&
      access.accountId !== '' &&
      access.capabilities.includes('org-projects-v1') &&
      (journal.phase !== 'reclaiming' ||
        access.capabilities.includes(RECLAIM_CAPABILITY)) &&
      key(
        access.accountId,
        deviceId,
        journal.projectId,
        journal.attemptNonce,
      ) === journal.idempotencyKey
    );
  }
  /**
   * Replace the lapsed claim a promoted, bound checkout was set up under
   * (CAN-3129), then bind and complete under the new fence. Nothing is
   * cloned. The request names the exact claim being replaced and the
   * workspace id the claim carried, and the server refuses anything that is
   * not still that claim — its 409 is a supersede, final, and nothing is
   * taken back. The reclaim key is derived from the fence being replaced, so
   * a request whose answer was lost is presented again unchanged.
   */
  async function reclaimAndFinish(
    journal: SetupJournal,
    attempt: Attempt,
  ): Promise<void> {
    attempt.journal = journal;
    // Past promotion and binding: Cancel is refused, and the checkout is a
    // workspace the user can see, so a failure never removes it.
    attempt.promoted = true;
    attempt.renamed = true;
    attempt.bindStarted = true;
    const access = await deps.access();
    const deviceId = await deps.resolveDeviceId();
    if (
      !access.enabled ||
      !access.capabilities.includes('org-projects-v1') ||
      key(
        access.accountId,
        deviceId,
        journal.projectId,
        journal.attemptNonce,
      ) !== journal.idempotencyKey
    )
      fail('access-removed');
    // A server that cannot verify a reclaim keeps the journal for one that can.
    if (!access.capabilities.includes(RECLAIM_CAPABILITY))
      fail('claim-expired');
    const installationGeneration =
      await deps.readInstallationGeneration(deviceId);
    emit(journal.projectId, 'materializing', COPY.materializing, journal);
    let claim: ClaimOrgProjectInstanceResponse;
    try {
      claim = await deps.cloud.claim(journal.projectId, {
        deviceId,
        installationGeneration,
        localWorkspaceId: journal.localWorkspaceId,
        idempotencyKey: key(
          access.accountId,
          deviceId,
          journal.projectId,
          `${journal.attemptNonce}:reclaim:${journal.fencingGeneration}`,
        ),
        reclaim: {
          instanceId: journal.instanceId,
          operationId: journal.operationId,
          fencingGeneration: journal.fencingGeneration,
        },
      });
    } catch (error) {
      if (
        error instanceof CanopyCloudClientError &&
        error.status === 409 &&
        error.serverCode === 'conflict'
      )
        fail('superseded');
      throw error;
    }
    if (
      claim.instanceId !== journal.instanceId ||
      claim.fencingGeneration < journal.fencingGeneration
    )
      throw new Error('Invalid reclaim');
    // Still `reclaiming` until the completion goes out: an exit before then
    // presents this claim again, which the server confirms unchanged while
    // its lease holds and replaces once it lapsed.
    journal.operationId = claim.operationId;
    journal.fencingGeneration = claim.fencingGeneration;
    await checkpoint(journal, 'reclaiming', 'claim-expired');
    await bindCheckout(journal, journal.finalPath);
    await finish(journal, attempt);
  }
  /**
   * Finish a setup the app exited during after it promoted its checkout
   * (CAN-3130), from the phase its journal recorded, without cloning again:
   * complete the rename, bind, and complete the fenced claim. A claim whose
   * lease lapsed meanwhile is reclaimed exactly as Retry would (CAN-3129).
   * Callers have checked `canResume`.
   */
  async function resumeSetup(
    journal: SetupJournal,
    attempt: Attempt,
  ): Promise<void> {
    if (journal.phase === 'reclaiming') {
      await reclaimAndFinish(journal, attempt);
      return;
    }
    attempt.journal = journal;
    attempt.promoted = true;
    const access = await deps.access();
    const deviceId = await deps.resolveDeviceId();
    if (
      !access.enabled ||
      !access.capabilities.includes('org-projects-v1') ||
      key(
        access.accountId,
        deviceId,
        journal.projectId,
        journal.attemptNonce,
      ) !== journal.idempotencyKey
    )
      fail('access-removed');
    emit(journal.projectId, 'materializing', COPY.materializing, journal);
    const binds = journal.phase === 'promoted' || journal.phase === 'bound';
    if (
      journal.phase === 'promoted' &&
      (await promotedCheckout(journal)) === 'staged'
    )
      await rename(journal.stagingPath, journal.finalPath);
    attempt.renamed = true;
    if (journal.phase === 'promoted') await checkpoint(journal, 'bound');
    // From here the checkout is, or may be, in the workspace index: a
    // failure never removes it.
    attempt.bindStarted = true;
    if (binds) {
      await bindCheckout(journal, journal.finalPath);
      // The workspace may be new to the index; the renderer re-reads its
      // projects on an ownership change, whether or not it was there to hear
      // any progress.
      emitOwnership({
        workspaceId: journal.localWorkspaceId,
        organizationId: journal.organizationId,
        projectId: journal.projectId,
        owner: 'organization',
      });
    }
    try {
      await finish(journal, attempt);
    } catch (error) {
      // The lease ran out while the app was closed: reclaim, as Retry would.
      if (
        error instanceof SetupError &&
        error.code === 'claim-expired' &&
        // `finish` moved the phase on; read it fresh.
        phaseOf(journal) === 'reclaiming'
      ) {
        await reclaimAndFinish(journal, attempt);
        return;
      }
      throw error;
    }
  }
  /**
   * The startup sweep's half of resuming: the same routine Set up and Retry
   * run, as an attempt that reports nothing (no window exists to hear it
   * yet). The row follows the catalog, which `finish` refreshes. A journal
   * this account, device or server cannot finish yet is kept for a later
   * launch; one whose checkout cannot be accounted for is retired.
   */
  async function resumeInterrupted(journal: SetupJournal): Promise<void> {
    if (!(await canResume(journal))) {
      await retire(journal);
      return;
    }
    const access = await deps.access();
    if (!canFinishNow(access, await deps.resolveDeviceId(), journal)) return;
    const attempt: Attempt = {
      controller: new AbortController(),
      first: {
        projectId: journal.projectId,
        instanceId: journal.instanceId,
        state: 'materializing',
        message: COPY.materializing,
        percent: null,
        updatedAt: deps.now(),
      },
      done: Promise.resolve(),
      promoted: true,
      ownsStaging: false,
      quiet: true,
    };
    attempts.set(journal.projectId, attempt);
    attempt.done = resumeSetup(journal, attempt)
      .catch(async (error: unknown): Promise<void> => {
        await reportFailure(journal.projectId, attempt, error);
      })
      .finally((): void => {
        if (attempts.get(journal.projectId) === attempt)
          attempts.delete(journal.projectId);
      });
    await attempt.done;
  }
  async function finish(
    journal: SetupJournal,
    attempt: Attempt,
  ): Promise<void> {
    await attempt.beforeMutation?.();
    await checkpoint(journal, 'completing');
    attempt.completionSent = true;
    try {
      await deps.cloud.complete(
        journal.instanceId,
        {
          operationId: journal.operationId,
          fencingGeneration: journal.fencingGeneration,
          outcome: 'ready',
        },
        ...(attempt.credentialContext ? [attempt.credentialContext] : []),
      );
    } catch (error) {
      if (
        error instanceof CanopyCloudClientError &&
        error.status === 409 &&
        error.serverCode === 'conflict'
      ) {
        // The claim is gone — superseded, or simply lapsed: its lease is 15
        // minutes and an offline stretch outlives it. The answer is the same
        // for both, so a checkout this attempt promoted and bound keeps its
        // binding and its instance, and a reclaim asks the server which it
        // was (CAN-3129). Without a server that can verify one, either
        // reading spends the key as before.
        attempt.completionSent = false;
        if (
          attempt.renamed === true &&
          attempt.conversion !== true &&
          attempt.adoption !== true &&
          (await deps.access().then(
            (access): boolean =>
              access.capabilities.includes(RECLAIM_CAPABILITY),
            (): boolean => false,
          ))
        ) {
          await checkpoint(journal, 'reclaiming', 'claim-expired');
          fail('claim-expired');
        }
        if (attempt.promoted) fail('claim-expired');
        fail('superseded');
      }
      if (
        error instanceof CanopyCloudClientError &&
        error.code === 'network-error'
      ) {
        fail('completion-pending');
      }
      throw error;
    }
    // The instance is READY on the server from here. What follows is local
    // bookkeeping, and a failure in it must not reach `reportFailure` — that
    // would detach a completed instance whose workspace is already bound. The
    // sweep clears a `done` journal on the next launch.
    await checkpoint(journal, 'done').catch((): void => {});
    // Retire the spent claim BEFORE dropping the journal: a crash in between
    // must not leave the key live with no local record that it was used.
    // Order matters more than tidiness here: the journal is what tells the
    // sweep the key still needs spending. Removing it after a failed rotation
    // would leave a live key with no record of it, and the next setup would
    // present one the server has already retired.
    const rotated = await rotateAttemptNonce(journal.projectId).then(
      (): boolean => true,
      (): boolean => false,
    );
    if (rotated)
      await rm(join(deps.paths.setupsDir(), `${journal.journalId}.json`), {
        force: true,
      }).catch((): void => {});
    await deps.catalog
      .refresh(
        { kind: 'organization', organizationId: journal.organizationId },
        { force: true },
      )
      .catch((): void => {});
    emit(journal.projectId, 'ready', COPY.ready, journal);
  }
  async function reportFailure(
    projectId: string,
    attempt: Attempt,
    error: unknown,
  ): Promise<string> {
    const journal = attempt.journal;
    const cancelled =
      (attempt.controller.signal.aborted ||
        (error instanceof SetupError && error.code === 'cancelled')) &&
      !attempt.promoted;
    let code = error instanceof SetupError ? error.code : 'setup-failed';
    // Only `SetupError` carries copy meant for a person; everything else is an
    // internal message ("Unsafe staging path", a Node errno) that the row must
    // not display. The detail still reaches the log through the thrown error.
    let message =
      error instanceof SetupError ? error.message : 'Project setup failed';
    if (error instanceof CanopyCloudClientError) {
      if (error.status === 409 && error.serverCode === 'conflict')
        code = 'claim-conflict';
      if (
        (error.status === 404 && error.serverCode === 'not_found') ||
        (error.status === 403 && error.serverCode === 'forbidden')
      ) {
        code = 'access-removed';
        message = COPY['access-removed'];
      }
    }
    if (cancelled) {
      code = 'cancelled';
      message = COPY.cancelled;
    }
    const definitive =
      cancelled ||
      code === 'superseded' ||
      code === 'access-removed' ||
      // The server rejected the claim outright. That key is spent whether or
      // not a journal was ever written.
      code === 'claim-conflict';
    // A lapsed claim's checkout stays bound and its instance stays this
    // device's (CAN-3129), and so does one whose completion went unanswered
    // (CAN-3130). Short of the server's own definitive answer, nothing is
    // retired: Retry or the next launch reclaims the first, the next launch
    // completes the second.
    if (
      journal !== undefined &&
      journal.conversion === undefined &&
      journal.adoption === undefined &&
      (journal.phase === 'reclaiming' ||
        // A claim gone with no server able to reclaim it is final.
        (journal.phase === 'completing' && code !== 'claim-expired')) &&
      !definitive
    ) {
      const kept = journal.phase === 'reclaiming' ? 'claim-expired' : code;
      emit(
        projectId,
        'failed',
        journal.phase === 'reclaiming' ? COPY['claim-expired'] : message,
        journal,
        null,
        kept,
      );
      return kept;
    }
    // A conversion that bound the workspace goes back to Personal first. Once
    // it has, the instance is released even if a completion went out: the
    // checkout is Personal again, and a READY instance would hide the project
    // from the organization. A binding that cannot be undone keeps the claim
    // and the journal for the next launch's sweep to finish.
    const restoredConversion =
      attempt.conversion === true && journal && attempt.bindStarted
        ? await restorePersonal(journal).catch((): boolean => false)
        : undefined;
    const removedAdoption =
      attempt.adoption === true && journal && attempt.bindStarted
        ? attempt.completionSent
          ? false
          : await deps.workspace
              .removeBoundWorkspace(
                journal.localWorkspaceId,
                journal.instanceId,
              )
              .catch((): boolean => false)
        : undefined;
    const localBindingRetired =
      restoredConversion !== false && removedAdoption !== false;
    if (journal && localBindingRetired) {
      // Each step stands alone, and terminalizing is last. An unreadable nonce
      // store or a destination that moved must not stop the claim being handed
      // back, and a journal marked failed is one the sweep skips — so the
      // journal is only terminalized once the key really was spent. Anything
      // short of that stays readable as in-flight for the next launch to
      // finish.
      const retired = await rotateAttemptNonce(projectId).then(
        (): boolean => true,
        (): boolean => false,
      );
      // Remove what this attempt put on disk. Provenance is not in question
      // here: the same run created the staging directory, renamed it, and is
      // now unwinding it, so there is nothing to infer from the filesystem.
      // A checkout the workspace index knows about is left alone: it is either
      // a workspace the user can see, or half-written metadata that a delete
      // here would strand.
      if ((attempt.ownsStaging || attempt.renamed) && !attempt.bindStarted) {
        // A destination that cannot be resolved is a reason to leave the disk
        // alone, not a reason to skip handing the claim back.
        const root = await realpath(journal.destinationRoot).catch(
          (): null => null,
        );
        if (root === journal.destinationRoot)
          await rm(attempt.renamed ? journal.finalPath : journal.stagingPath, {
            recursive: true,
            force: true,
          }).catch((): void => {});
      }
      // Same rule as the sweep, read from the attempt instead of the journal:
      // once a completion has gone out, its answer may have been lost rather
      // than never given, so the instance is not ours to detach.
      // A superseded instance belongs to whichever claim replaced this one.
      if (
        code !== 'superseded' &&
        (!attempt.completionSent || restoredConversion === true)
      )
        await deps.cloud
          .detach(
            journal.instanceId,
            ...(attempt.credentialContext ? [attempt.credentialContext] : []),
          )
          .catch((): void => {});
      if (retired)
        await checkpoint(
          journal,
          cancelled ? 'cancelled' : 'failed',
          code,
        ).catch((): void => {});
    }
    if (!journal && attempt.claimed !== undefined) {
      // The claim landed but nothing wrote it down: the destination checks
      // between the response and the journal touch the filesystem and can
      // throw. The instance is known, so hand it back and spend the key rather
      // than leaving the server holding a claim this device cannot name.
      await deps.cloud
        .detach(
          attempt.claimed,
          ...(attempt.credentialContext ? [attempt.credentialContext] : []),
        )
        .catch((): void => {});
      await rotateAttemptNonce(projectId);
    } else if (!journal && (!attempt.claimSent || definitive))
      // A claim whose response was *lost* may well have committed, and
      // presenting the same key again is exactly what idempotency is for. A
      // claim the server definitively rejected is the opposite case: that key
      // is spent, and reusing it only replays the rejection.
      await rotateAttemptNonce(projectId);
    // A conversion answers its caller instead of the project's setup row.
    if (attempt.conversion !== true)
      emit(
        projectId,
        cancelled ? 'cancelled' : 'failed',
        message,
        journal,
        null,
        code,
      );
    return code;
  }
  async function run(
    projectId: string,
    destinationRoot: string,
    attempt: Attempt,
  ): Promise<void> {
    const signal = attempt.controller.signal;
    const abort = (): void => {
      if (signal.aborted) fail('cancelled');
    };
    try {
      const access = await deps.access();
      if (
        access.context.kind !== 'organization' ||
        !access.accountId ||
        !access.enabled ||
        !access.capabilities.includes('org-projects-v1')
      )
        fail('access-removed');
      const { organizationId } = access.context;
      const { found: saved } = await journals();
      const pending = saved.find(
        (journal) =>
          journal.projectId === projectId &&
          !['failed', 'cancelled'].includes(journal.phase),
      );
      // A setup that promoted its checkout before it stopped is finished
      // rather than replaced: Retry reclaims a lapsed claim (CAN-3129), and an
      // interrupted one resumes where it was (CAN-3130), never cloning again.
      if (pending && resumable(pending) && (await canResume(pending))) {
        await resumeSetup(pending, attempt);
        return;
      }
      // Any other journal that never reached a terminal phase belongs to a run
      // the app exited before it promoted anything. Retire it here: the user
      // asked for a setup now, and a fresh attempt is the thing they are
      // watching.
      if (pending) await retire(pending);
      const snapshot = await deps.catalog.list(access.context);
      const project = snapshot.projects.find((row) => row.id === projectId);
      if (
        !project ||
        !project.listed ||
        !project.capabilities.use ||
        project.organizationId !== access.context.organizationId
      )
        fail('access-removed');
      if (project.kind === 'COWORK' && project.location === 'LOCAL') {
        if (project.instance?.state === 'READY') {
          const indexed = (await deps.readItems()).some(
            (item) =>
              item.owner?.type === 'organization' &&
              item.owner.projectId === projectId &&
              item.owner.organizationId === organizationId,
          );
          if (indexed) {
            emit(projectId, 'ready', COPY.ready, {
              instanceId: project.instance.id,
            });
            return;
          }
        }
        attempt.promoted = true;
        emit(
          projectId,
          'materializing',
          'Creating the project on this computer',
        );
        const result = await deps.cowork.setUp({
          organizationId,
          projectId,
          name: project.name,
        });
        if (typeof project.privateMemory === 'boolean') {
          const item = (await deps.readItems()).find(
            (row) =>
              row.owner?.type === 'organization' &&
              row.owner.organizationId === organizationId &&
              row.owner.projectId === projectId,
          );
          if (!item)
            throw new Error('Created organization cowork workspace missing');
          await deps.workspace.applyManagedPrivateMemory({
            workspaceId: item.id,
            organizationId,
            projectId,
            privateMemory: project.privateMemory,
          });
        }
        await deps.catalog.refresh(access.context, { force: true });
        emit(projectId, 'ready', COPY.ready, {
          instanceId: result.instanceId,
        });
        return;
      }
      // A member's converted multi-repo project (CAN-3532) exists only on the
      // device that converted it; its first repository alone is not it.
      if (project.topology === 'multi-repo') fail('unsupported-multi-repo');
      // Only a local code project has a checkout to make here. Anything else is
      // rejected before a claim, not at a server boundary after a clone.
      if (
        project.kind !== 'CODE' ||
        project.location !== 'LOCAL' ||
        !project.repository
      )
        fail('unsupported-location');
      // Removing a bound workspace leaves its instance READY on the server.
      // With nothing bound here it is stale: it is released just before the
      // claim, which the server refuses beside a READY instance (CAN-3592).
      let staleReadyInstanceId: string | undefined;
      // Only an authoritative read proves nothing is bound. An unreadable
      // workspace could be the bound one, so it keeps the instance.
      const provenUnbound = async (): Promise<boolean> => {
        const index = await deps.readItemsSnapshot();
        return (
          (index.authority === 'ok' || index.authority === 'absent') &&
          !index.items.some(
            (item) =>
              item.owner?.type === 'organization' &&
              item.owner.projectId === projectId &&
              item.owner.organizationId === organizationId,
          )
        );
      };
      if (project.instance?.state === 'READY') {
        if (!(await provenUnbound())) {
          emit(projectId, 'ready', COPY.ready, {
            instanceId: project.instance.id,
          });
          return;
        }
        staleReadyInstanceId = project.instance.id;
      }
      // Short of ready, a workspace already bound to this project means an
      // earlier attempt got as far as binding one. Cloning a second checkout
      // would leave the user with two; the index is the record of what was
      // bound, rather than a guess about a directory on disk.
      const already = (await deps.readItems()).find(
        (item) =>
          item.owner?.type === 'organization' &&
          item.owner.projectId === projectId &&
          item.owner.organizationId === organizationId,
      );
      if (already) {
        const previous = saved.find(
          (entry) =>
            entry.projectId === projectId &&
            ['failed', 'cancelled'].includes(entry.phase),
        );
        emit(
          projectId,
          'failed',
          previous?.errorCode === 'superseded'
            ? COPY.superseded
            : 'This project is already a workspace',
          previous,
          null,
          // Not the previous attempt's own code: a lapsed claim's code is the
          // one the row offers Retry for, and nothing can finish this one.
          previous?.errorCode === 'superseded'
            ? 'superseded'
            : 'project-already-bound',
        );
        return;
      }
      const preferences = await deps.preferences();
      const root = await validateRoot(destinationRoot);
      abort();
      const repoName = project.repository.name;
      const separate = await deps.hasPersonalRelationship(projectId);
      abort();
      const url = buildOrgProjectCloneUrl(
        project.repository,
        preferences.orgProjectCloneProtocol ?? 'https',
        deps.cloneBase,
      );
      const deviceId = await deps.resolveDeviceId();
      const installationGeneration =
        await deps.readInstallationGeneration(deviceId);
      const identity = await attemptNonce(
        projectId,
        deps.workspace.buildLocalWorkspaceId(repoName, await deps.readItems()),
      );
      const { nonce, localWorkspaceId } = identity;
      const idempotencyKey = key(access.accountId, deviceId, projectId, nonce);
      const current = await deps.access();
      if (
        current.accountId !== access.accountId ||
        current.context.kind !== 'organization' ||
        current.context.organizationId !== access.context.organizationId ||
        !current.enabled ||
        !current.capabilities.includes('org-projects-v1')
      )
        fail('access-removed');
      abort();
      if (staleReadyInstanceId !== undefined) {
        // Checked again here: a workspace bound since the check above keeps
        // the instance.
        if (!(await provenUnbound())) {
          emit(projectId, 'ready', COPY.ready, {
            instanceId: staleReadyInstanceId,
          });
          return;
        }
        // A 404 or 403 means the server no longer holds it for us.
        await deps.cloud.detach(staleReadyInstanceId).catch((error): void => {
          if (
            !(
              error instanceof CanopyCloudClientError &&
              ((error.status === 404 && error.serverCode === 'not_found') ||
                (error.status === 403 && error.serverCode === 'forbidden'))
            )
          )
            throw error;
        });
        // The catalog still shows it READY, which hides the setup row.
        await deps.catalog
          .refresh(access.context, { force: true })
          .catch((): void => {});
        abort();
      }
      attempt.claimSent = true;
      const claim = await deps.cloud.claim(projectId, {
        deviceId,
        installationGeneration,
        localWorkspaceId,
        idempotencyKey,
      });
      attempt.claimed = claim.instanceId;
      let finalPath = join(root, repoName);
      let destinationEscapes = false;
      if (separate || (await exists(finalPath))) {
        destinationEscapes =
          (await exists(finalPath)) &&
          inside(root, await realpath(finalPath)) === false;
        finalPath = join(
          root,
          `${repoName}-${claim.instanceId.replace(/-/g, '').slice(0, 6).toLowerCase()}`,
        );
      }
      const journalId = randomUUID();
      const journal: SetupJournal = {
        version: 1,
        journalId,
        projectId,
        organizationId: access.context.organizationId,
        instanceId: claim.instanceId,
        operationId: claim.operationId,
        idempotencyKey,
        attemptNonce: nonce,
        fencingGeneration: claim.fencingGeneration,
        localWorkspaceId,
        destinationRoot: root,
        finalPath,
        stagingPath: join(root, `.canopy-setup-${journalId}`),
        phase: 'claimed',
        updatedAt: deps.now(),
      };
      if (!normalizeSetupJournal(journal))
        throw new Error('Invalid setup claim');
      attempt.journal = journal;
      // The journal now names the instance, so the pre-journal safety net above
      // is no longer the thing keeping track of it.
      attempt.claimed = undefined;
      await checkpoint(journal, 'claimed');
      if (destinationEscapes)
        throw new SetupError(
          'invalid-destination',
          'Destination escapes the selected folder',
        );
      if (process.platform === 'win32' && finalPath.length >= 240)
        throw new SetupError(
          'invalid-destination',
          'Destination path is too long',
        );
      if ((await exists(finalPath)) || (await exists(journal.stagingPath)))
        throw new SetupError(
          'destination-exists',
          'The setup destination already exists',
        );
      abort();
      await checkpoint(journal, 'cloning');
      abort();
      await mkdir(journal.stagingPath);
      attempt.ownsStaging = true;
      const message =
        (preferences.orgProjectCloneProtocol ?? 'https') === 'https' &&
        (await deps.resolveTokenSource()) === 'none'
          ? COPY.credentials
          : COPY.materializing;
      emit(projectId, 'materializing', message, journal);
      abort();
      try {
        await deps.git.clone(url, journal.stagingPath, {
          signal,
          onProgress: (percent): void => {
            if (!signal.aborted)
              emit(
                projectId,
                'materializing',
                COPY.materializing,
                journal,
                Math.min(100, Math.max(0, percent)),
              );
          },
        });
      } catch (error) {
        if (
          classifyGitHubAuthFailure(url, error) === 'github_not_authenticated'
        )
          fail('github-not-authenticated');
        const stderr =
          error instanceof Error &&
          'stderr' in error &&
          typeof error.stderr === 'string'
            ? error.stderr
            : error instanceof Error
              ? error.message
              : '';
        if (
          /could not read Username|Authentication failed|Permission denied|Repository not found|403|401/i.test(
            stderr,
          )
        )
          fail('needs-credentials');
        throw new SetupError('clone-failed', 'Could not clone the repository');
      }
      abort();
      await rejectUnsafeManifest(journal.stagingPath);
      if (hasManifestRepos(await readCanopyJson(journal.stagingPath)))
        fail('unsupported-topology');
      await checkpoint(journal, 'validated');
      await checkAccess(journal);
      abort();
      if (
        (await realpath(root)) !== root ||
        !inside(root, await realpath(journal.stagingPath)) ||
        (await exists(finalPath))
      )
        throw new SetupError(
          'invalid-destination',
          'The setup destination changed',
        );
      // Those checks await the filesystem, so a cancellation can be accepted
      // inside them. Re-read the signal here, in the same turn as the promotion
      // flag: past this line Cancel is refused and the checkout is kept.
      abort();
      // Past this line Cancel is refused and the checkout is kept.
      attempt.promoted = true;
      await checkpoint(journal, 'promoted');
      await rename(journal.stagingPath, finalPath);
      attempt.renamed = true;
      await checkpoint(journal, 'bound');
      attempt.bindStarted = true;
      try {
        await bindCheckout(journal, finalPath);
      } catch (error) {
        // An id taken by something else while this attempt was cloning, or a
        // project another workspace was bound to meanwhile, are the bind
        // failures that wrote nothing, so the checkout is still this attempt's
        // alone and goes with it rather than being left for the user to find
        // and delete.
        if (
          error instanceof WorkspaceIdentityInUseError ||
          (error instanceof SetupError &&
            error.code === 'project-already-bound')
        )
          attempt.bindStarted = false;
        throw error;
      }
      await finish(journal, attempt);
    } catch (error) {
      await reportFailure(projectId, attempt, error);
    }
  }

  async function adopt(
    input: {
      projectId: string;
      organizationId: string;
      path: string;
      preferredName: string;
    },
    options: { createdRepo?: boolean },
    attempt: Attempt,
  ): Promise<{ localWorkspaceId: string }> {
    const organizationId = input.organizationId.toLowerCase();
    const access = await deps.access();
    if (
      access.context.kind !== 'organization' ||
      access.context.organizationId !== organizationId ||
      !access.accountId ||
      !access.enabled ||
      !access.capabilities.includes('org-projects-v1') ||
      !access.capabilities.includes('org-member-code-projects-v1')
    )
      fail('access-removed');
    const path = await realpath(input.path);
    const snapshot = await deps.catalog.refresh(
      { kind: 'organization', organizationId },
      { force: true },
    );
    if (snapshot.error === 'offline')
      throw new SetupError(
        'offline',
        'Project access could not be checked while offline',
      );
    const catalog =
      snapshot.stale || snapshot.error
        ? []
        : snapshot.projects.filter(
            (row) => row.organizationId === organizationId,
          );
    const project = catalog.find((row) => row.id === input.projectId);
    if (
      !project ||
      project.state !== 'ACTIVE' ||
      project.kind !== 'CODE' ||
      project.location !== 'LOCAL' ||
      !project.capabilities.use
    )
      fail('access-removed');
    const preferredName = input.preferredName.trim() || project.name;
    let remoteUrl: string | null;
    try {
      remoteUrl = await deps.workspace.readRemoteUrl(path);
    } catch {
      throw new SetupError(
        'repository-unavailable',
        'The repository could not be checked',
      );
    }
    if (project.repository) {
      if (
        !computeRelationships(catalog, [
          {
            id: 'adopted-checkout',
            type: 'single-repo',
            remoteUrl,
          },
        ]).some((relationship) => relationship.projectId === project.id)
      )
        throw new SetupError(
          'repository-mismatch',
          'The folder does not match this project',
        );
    } else {
      const normalized =
        remoteUrl === null ? null : normalizeRemoteUrl(remoteUrl, true);
      if (normalized?.startsWith('github.com/') === true)
        throw new SetupError(
          'repository-mismatch',
          'The folder does not match this project',
        );
    }
    if (
      (await deps.readItems()).some(
        (item) =>
          item.owner?.type === 'organization' &&
          item.owner.organizationId === organizationId &&
          item.owner.projectId === project.id,
      )
    )
      throw new SetupError(
        'project-already-bound',
        'This project is already a workspace',
      );
    const { found } = await journals();
    const pending = found.find(
      (journal) =>
        journal.projectId === project.id &&
        !['failed', 'cancelled'].includes(journal.phase),
    );
    if (pending) await retire(pending);
    const proposedWorkspaceId = deps.workspace.buildLocalWorkspaceId(
      project.repository?.name ?? preferredName,
      await deps.readItems(),
    );
    let identity = await attemptNonce(project.id, proposedWorkspaceId);
    if (identity.localWorkspaceId !== proposedWorkspaceId) {
      await rotateAttemptNonce(project.id);
      identity = await attemptNonce(project.id, proposedWorkspaceId);
    }
    const deviceId = await deps.resolveDeviceId();
    const installationGeneration =
      await deps.readInstallationGeneration(deviceId);
    const idempotencyKey = key(
      access.accountId,
      deviceId,
      project.id,
      identity.nonce,
    );
    const current = await deps.access();
    if (
      current.accountId !== access.accountId ||
      current.context.kind !== 'organization' ||
      current.context.organizationId !== organizationId ||
      !current.enabled ||
      !current.capabilities.includes('org-projects-v1') ||
      !current.capabilities.includes('org-member-code-projects-v1')
    )
      fail('access-removed');
    attempt.claimSent = true;
    const claimed = await deps.cloud.claim(project.id, {
      deviceId,
      installationGeneration,
      localWorkspaceId: identity.localWorkspaceId,
      idempotencyKey,
    });
    attempt.claimed = claimed.instanceId;
    const finalPath = resolve(path);
    const destinationRoot = dirname(finalPath);
    const journalId = randomUUID();
    const journal: SetupJournal = {
      version: 1,
      journalId,
      projectId: project.id,
      organizationId,
      instanceId: claimed.instanceId,
      operationId: claimed.operationId,
      idempotencyKey,
      attemptNonce: identity.nonce,
      fencingGeneration: claimed.fencingGeneration,
      localWorkspaceId: identity.localWorkspaceId,
      destinationRoot,
      finalPath,
      stagingPath: join(destinationRoot, `.canopy-setup-${journalId}`),
      phase: 'claimed',
      updatedAt: deps.now(),
      adoption: options.createdRepo === true ? { createdRepo: true } : {},
    };
    if (!normalizeSetupJournal(journal))
      throw new Error('Invalid adoption claim');
    attempt.journal = journal;
    attempt.claimed = undefined;
    await checkpoint(journal, 'claimed');
    await checkpoint(journal, 'bound');
    attempt.bindStarted = true;
    await bindCheckout(journal, finalPath, preferredName);
    await finish(journal, attempt);
    return { localWorkspaceId: journal.localWorkspaceId };
  }

  /**
   * Convert an existing Personal workspace in place. Preconditions refuse
   * before anything is claimed; after the claim the setup path's own journal,
   * binding and fenced completion run, with the workspace's current id as the
   * claim's local workspace id and its checkout as the final path.
   */
  async function convert(
    request: OrgProjectConvertWorkspaceRequest,
    attempt: Attempt,
    options: OrgProjectConversionOptions,
  ): Promise<Extract<OrgProjectConversionResult, { ok: true }>> {
    const { workspaceId, projectId } = request;
    const organizationId = request.organizationId.toLowerCase();
    attempt.credentialContext = options.credentialContext;
    const access = await deps.access();
    attempt.beforeMutation =
      options.beforeMutation ??
      (options.automatic && deps.automaticConversionAllowed
        ? async (): Promise<void> => {
            if (
              !(await deps.automaticConversionAllowed?.(
                organizationId,
                access.accountId,
              ))
            )
              refuse('disabled');
          }
        : undefined);
    if (
      !access.enabled ||
      !access.accountId ||
      !access.capabilities.includes('org-projects-v1') ||
      (options.memberCreated === true &&
        !access.capabilities.includes('org-member-code-projects-v1'))
    )
      refuse('disabled');
    const items = await deps.readItems();
    const item = items.find((candidate) => candidate.id === workspaceId);
    if (!item) refuse('workspace-not-found');
    // Binding is defined for one checkout only; setup refuses multi-project
    // repositories for the same reason.
    if (item.type !== 'single-repo') refuse('unsupported-workspace');
    const read = await deps.workspace.readOwnership(workspaceId);
    if (read.authority === 'absent') refuse('workspace-not-found');
    if (read.authority !== 'ok') refuse('workspace-unreadable');
    if (read.type !== 'single-repo') refuse('unsupported-workspace');
    if (read.owner !== undefined) refuse('not-personal');
    if (options.automatic === true && read.ownershipTransfer !== undefined)
      refuse('previously-converted');
    if (
      items.some(
        (other) =>
          other.owner?.type === 'organization' &&
          other.owner.organizationId === organizationId &&
          other.owner.projectId === projectId,
      )
    )
      refuse('project-already-bound');
    const snapshot = await deps.catalog.refresh(
      { kind: 'organization', organizationId },
      { force: true },
    );
    if (snapshot.error === 'offline') refuse('offline');
    const catalog =
      snapshot.stale || snapshot.error
        ? []
        : snapshot.projects.filter(
            (row) => row.organizationId === organizationId,
          );
    const project = catalog.find((row) => row.id === projectId);
    if (
      !project ||
      project.state !== 'ACTIVE' ||
      !project.capabilities.use ||
      project.kind !== 'CODE' ||
      project.location !== 'LOCAL' ||
      project.topology === 'multi-repo' ||
      (project.repository === null &&
        !(
          options.memberCreated === true &&
          project.memberOwned &&
          project.visibility === 'private' &&
          project.capabilities.administer &&
          project.instance === null
        ))
    )
      refuse('project-unavailable');
    let remoteUrl: string | null;
    try {
      remoteUrl = await deps.workspace.readRemoteUrl(item.repoPath);
    } catch {
      refuse('repository-unavailable');
    }
    // The same decision the "same repository" relationship makes: provider
    // identity when verified, otherwise one unambiguous remote URL match.
    if (project.repository) {
      if (
        !computeRelationships(catalog, [
          { id: workspaceId, type: 'single-repo', remoteUrl },
        ]).some((relationship) => relationship.projectId === projectId)
      )
        refuse('repository-mismatch');
    } else {
      const normalized =
        remoteUrl === null ? null : normalizeRemoteUrl(remoteUrl, true);
      if (normalized?.startsWith('github.com/') === true)
        refuse('repository-mismatch');
    }
    if (
      options.automatic &&
      deps.automaticConversionAllowed &&
      !(await deps.automaticConversionAllowed(organizationId, access.accountId))
    )
      refuse('disabled');
    return bindInPlace({
      attempt,
      accountId: access.accountId,
      workspaceId,
      organizationId,
      projectId,
      type: 'single-repo',
      checkoutPath: item.repoPath,
      previousTransfer: read.ownershipTransfer,
      memberCreated: options.memberCreated,
      beforeMutation: attempt.beforeMutation,
      privateMemory: project.privateMemory,
    });
  }
  /**
   * Convert an existing Personal multi-repo project or temporary combination in
   * place (CAN-3532), projecting only checkouts held by usable organization
   * projects into the definition. Unheld checkouts remain local.
   * Add project and newly gained settings repositories remain strict.
   * The organization then creates
   * (or, for a retry, returns) the member's private multi-repo project with
   * those repositories, and the same claim, binding and fenced completion as
   * `convert` follow. `claimProject` reserves the project for this attempt once
   * its id is known.
   */
  async function convertMulti(
    request: OrgProjectConvertMultiRepoWorkspaceRequest,
    attempt: Attempt,
    options: OrgProjectConversionOptions,
    claimProject: (projectId: string) => void,
  ): Promise<Extract<OrgProjectConversionResult, { ok: true }>> {
    const { workspaceId } = request;
    const organizationId = request.organizationId.toLowerCase();
    attempt.credentialContext = options.credentialContext;
    const access = await deps.access();
    attempt.beforeMutation =
      options.beforeMutation ??
      (options.automatic && deps.automaticConversionAllowed
        ? async (): Promise<void> => {
            if (
              !(await deps.automaticConversionAllowed?.(
                organizationId,
                access.accountId,
              ))
            )
              refuse('disabled');
          }
        : undefined);
    if (
      !access.enabled ||
      !access.accountId ||
      !access.capabilities.includes('org-projects-v1')
    )
      refuse('disabled');
    const items = await deps.readItems();
    const item = items.find((candidate) => candidate.id === workspaceId);
    if (!item) refuse('workspace-not-found');
    // Temporary combinations bind in place just like permanent multi-repo workspaces.
    if (item.type !== 'multi-repo') refuse('unsupported-workspace');
    const read = await deps.workspace.readOwnership(workspaceId);
    if (read.authority === 'absent') refuse('workspace-not-found');
    if (read.authority !== 'ok') refuse('workspace-unreadable');
    if (read.type !== 'multi-repo') refuse('unsupported-workspace');
    if (read.owner !== undefined) refuse('not-personal');
    if (options.automatic === true && read.ownershipTransfer !== undefined)
      refuse('previously-converted');
    // The selector's raw snapshot may predate retirement. Recheck this fresh
    // item before remote creation or binding; unsupported-workspace is cached
    // for the session even if the combination later revives. Manual conversion
    // remains allowed. Changes after this read are not protected atomically.
    if (options.automatic === true && isRetiredTemporaryWorkspace(item))
      refuse('unsupported-workspace');
    const checkouts = multiRepoCheckouts(item);
    const [firstCheckout] = checkouts;
    // No repository, nothing that could belong to an organization.
    if (firstCheckout === undefined) refuse('unsupported-workspace');
    const remoteUrls: string[] = [];
    for (const checkout of checkouts) {
      let remoteUrl: string | null;
      try {
        remoteUrl = await deps.workspace.readRemoteUrl(checkout);
      } catch {
        refuse('repository-unavailable');
      }
      if (remoteUrl !== null) remoteUrls.push(remoteUrl);
    }
    // A member's Create new multi-repo project (CAN-3546) starts with only
    // its remote-less root; its settings add the repositories afterwards.
    const memberCreatedEmpty =
      options.memberCreated === true && remoteUrls.length === 0;
    if (remoteUrls.length === 0 && !memberCreatedEmpty)
      refuse('unsupported-workspace');
    const repositoryProjectIds: string[] = [];
    const snapshot = memberCreatedEmpty
      ? null
      : await deps.catalog.refresh(
          { kind: 'organization', organizationId },
          { force: true },
        );
    if (snapshot?.error === 'offline') refuse('offline');
    // A catalog that could not be refreshed proves nothing about the
    // repositories; a mismatch would stop automatic conversion for the session.
    if (snapshot && (snapshot.stale || snapshot.error))
      refuse('project-unavailable');
    const catalog = (snapshot?.projects ?? []).filter(
      (row) => row.organizationId === organizationId,
    );
    for (const remoteUrl of remoteUrls) {
      // The single-repo rule for each checkout: provider identity when
      // verified, otherwise one unambiguous remote URL match.
      const [holder] = computeRelationships(catalog, [
        { id: workspaceId, type: 'single-repo', remoteUrl },
      ])
        .flatMap((relationship): OrgProjectSummary[] =>
          catalog.filter(
            (row): boolean =>
              row.id === relationship.projectId &&
              holdsOrganizationRepository(row),
          ),
        )
        .map((row): string => row.id)
        .sort((left, right): number => left.localeCompare(right));
      if (holder === undefined) {
        if (options.memberCreated === true) refuse('repository-mismatch');
        continue;
      }
      if (!repositoryProjectIds.includes(holder))
        repositoryProjectIds.push(holder);
    }
    if (repositoryProjectIds.length === 0 && !memberCreatedEmpty)
      refuse('repository-mismatch');
    let project: OrgProjectSummary;
    await options.beforeMutation?.();
    if (
      options.automatic &&
      deps.automaticConversionAllowed &&
      !(await deps.automaticConversionAllowed(organizationId, access.accountId))
    )
      refuse('disabled');
    try {
      project = await deps.cloud.createMemberMultiRepoProject(
        {
          organizationId,
          name:
            item.name.trim().slice(0, ORG_PROJECT_LIMITS.nameLength) ||
            workspaceId,
          localWorkspaceId: workspaceId,
          repositoryProjectIds,
          ...(options.privateMemory !== undefined
            ? { privateMemory: options.privateMemory }
            : {}),
        },
        ...(attempt.credentialContext ? [attempt.credentialContext] : []),
      );
    } catch (error) {
      refuse(memberProjectRefusal(error));
    }
    await options.onMemberCreated?.(project.id);
    if (
      project.organizationId?.toLowerCase() !== organizationId ||
      (options.privateMemory === true && project.privateMemory !== true) ||
      project.kind !== 'CODE' ||
      project.location !== 'LOCAL' ||
      project.topology !== 'multi-repo' ||
      project.state !== 'ACTIVE' ||
      !project.capabilities.use
    )
      refuse('project-unavailable');
    const projectId = project.id;
    if (
      items.some(
        (other) =>
          other.owner?.type === 'organization' &&
          other.owner.organizationId === organizationId &&
          other.owner.projectId === projectId,
      )
    )
      refuse('project-already-bound');
    claimProject(projectId);
    if (
      options.automatic &&
      deps.automaticConversionAllowed &&
      !(await deps.automaticConversionAllowed(organizationId, access.accountId))
    )
      refuse('disabled');
    return bindInPlace({
      attempt,
      accountId: access.accountId,
      workspaceId,
      organizationId,
      projectId,
      type: 'multi-repo',
      checkoutPath: firstCheckout,
      previousTransfer: read.ownershipTransfer,
      privateMemory: project.privateMemory,
      ...(options.memberCreated === true ? { memberCreated: true } : {}),
      beforeMutation: attempt.beforeMutation,
    });
  }
  /**
   * Convert an existing Personal Cowork project in place. The organization
   * creates a new private Cowork project for it, then the same claim, binding
   * and fenced completion as `convert` follow, with the Cowork folder as the
   * journal's final path. Every failure after the create carries the created
   * project's id. The create's key is stable per workspace, prior transfer
   * and name, so a retry reuses that definition instead of making another.
   */
  async function convertCowork(
    request: OrgProjectConvertCoworkWorkspaceRequest,
    attempt: Attempt,
    options: OrgProjectConversionOptions,
    claimProject: (projectId: string) => void,
    created: (projectId: string) => void,
  ): Promise<Extract<OrgProjectConversionResult, { ok: true }>> {
    const { workspaceId } = request;
    const organizationId = request.organizationId.toLowerCase();
    const access = await deps.access();
    if (
      !access.enabled ||
      !access.accountId ||
      !access.capabilities.includes('org-projects-v1')
    )
      refuse('disabled');
    const items = await deps.readItems();
    const item = items.find((candidate) => candidate.id === workspaceId);
    if (!item) refuse('workspace-not-found');
    if (item.type !== 'cowork' || isDefaultCoworkWorkspaceId(item.id))
      refuse('unsupported-workspace');
    const read = await deps.workspace.readOwnership(workspaceId);
    if (read.authority === 'absent') refuse('workspace-not-found');
    if (read.authority !== 'ok') refuse('workspace-unreadable');
    if (read.type !== 'cowork') refuse('unsupported-workspace');
    if (read.owner !== undefined) refuse('not-personal');
    if (options.automatic === true && read.ownershipTransfer !== undefined)
      refuse('previously-converted');
    const name =
      item.name.trim().slice(0, ORG_PROJECT_LIMITS.nameLength) || workspaceId;
    let project: OrgProjectSummary;
    try {
      project = await deps.cloud.createMemberCoworkProject({
        organizationId,
        // The server replays the definition it made for this key, so a retry
        // after a later failure binds that one. The key covers what the server
        // compares on replay (name, private memory), so a rename makes a new
        // definition instead of a permanent conflict; a move back to Personal
        // records a new transfer, so a later move creates a fresh one too.
        creationKey: createHash('sha256')
          .update(
            JSON.stringify([
              'cowork-move',
              workspaceId,
              read.ownershipTransfer?.convertedAt ?? '',
              name,
              options.privateMemory ?? false,
            ]),
          )
          .digest('hex'),
        kind: 'COWORK',
        name,
        ...(options.privateMemory !== undefined
          ? { privateMemory: options.privateMemory }
          : {}),
      });
    } catch (error) {
      refuse(memberProjectRefusal(error));
    }
    const projectId = project.id;
    created(projectId);
    if (
      project.organizationId?.toLowerCase() !== organizationId ||
      project.kind !== 'COWORK' ||
      project.purpose !== 'project' ||
      project.location !== 'LOCAL' ||
      project.state !== 'ACTIVE' ||
      !project.capabilities.use
    )
      refuse('project-unavailable');
    if (
      items.some(
        (other) =>
          other.owner?.type === 'organization' &&
          other.owner.organizationId === organizationId &&
          other.owner.projectId === projectId,
      )
    )
      refuse('project-already-bound');
    claimProject(projectId);
    return bindInPlace({
      attempt,
      accountId: access.accountId,
      workspaceId,
      organizationId,
      projectId,
      type: 'cowork',
      checkoutPath: deps.paths.coworkRootDir(item.id, item.externalPath),
      previousTransfer: read.ownershipTransfer,
      privateMemory: project.privateMemory,
    });
  }
  /**
   * The in-place half of a conversion, once its preconditions held: claim
   * the project's instance under the workspace's own id, journal it, write
   * the owner and the conversion record in one compare-and-set, and complete
   * the fenced claim. The journal's final path is a checkout of the
   * workspace; nothing is staged, cloned or moved.
   */
  async function bindInPlace(input: {
    attempt: Attempt;
    accountId: string;
    workspaceId: string;
    organizationId: string;
    projectId: string;
    type: 'single-repo' | 'multi-repo' | 'cowork';
    /** The workspace's folder: a checkout, or a Cowork project's folder. */
    checkoutPath: string;
    previousTransfer: WorkspaceOwnershipTransfer | undefined;
    memberCreated?: boolean;
    privateMemory?: boolean;
    beforeMutation?: () => Promise<void>;
  }): Promise<Extract<OrgProjectConversionResult, { ok: true }>> {
    const { attempt, workspaceId, organizationId, projectId } = input;
    const { found } = await journals();
    const pending = found.find(
      (journal) =>
        journal.projectId === projectId &&
        !['failed', 'cancelled'].includes(journal.phase),
    );
    if (pending) await retire(pending);
    const deviceId = await deps.resolveDeviceId();
    const installationGeneration =
      await deps.readInstallationGeneration(deviceId);
    let identity = await attemptNonce(projectId, workspaceId);
    // A retained identity claims for whatever workspace id it was minted
    // for; this claim is for the existing workspace.
    if (identity.localWorkspaceId !== workspaceId) {
      await rotateAttemptNonce(projectId);
      identity = await attemptNonce(projectId, workspaceId);
    }
    const idempotencyKey = key(
      input.accountId,
      deviceId,
      projectId,
      identity.nonce,
    );
    const current = await deps.access();
    if (
      current.accountId !== input.accountId ||
      !current.enabled ||
      !current.capabilities.includes('org-projects-v1') ||
      (input.memberCreated === true &&
        !current.capabilities.includes('org-member-code-projects-v1'))
    )
      refuse('disabled');
    await input.beforeMutation?.();
    attempt.claimSent = true;
    const claimed = await deps.cloud.claim(
      projectId,
      {
        deviceId,
        installationGeneration,
        localWorkspaceId: workspaceId,
        idempotencyKey,
      },
      ...(attempt.credentialContext ? [attempt.credentialContext] : []),
    );
    attempt.claimed = claimed.instanceId;
    const finalPath = resolve(input.checkoutPath);
    const destinationRoot = dirname(finalPath);
    const journalId = randomUUID();
    const journal: SetupJournal = {
      version: 1,
      journalId,
      projectId,
      organizationId,
      instanceId: claimed.instanceId,
      operationId: claimed.operationId,
      idempotencyKey,
      attemptNonce: identity.nonce,
      fencingGeneration: claimed.fencingGeneration,
      localWorkspaceId: workspaceId,
      destinationRoot,
      finalPath,
      // Never created: the checkout is already where it belongs.
      stagingPath: join(destinationRoot, `.canopy-setup-${journalId}`),
      phase: 'claimed',
      updatedAt: deps.now(),
      conversion:
        input.previousTransfer === undefined
          ? {}
          : { previousOwnershipTransfer: input.previousTransfer },
    };
    if (!normalizeSetupJournal(journal))
      throw new Error('Invalid conversion claim');
    attempt.journal = journal;
    attempt.claimed = undefined;
    await checkpoint(journal, 'claimed');
    const owner = setupOwner(journal);
    const ownershipTransfer: WorkspaceOwnershipTransfer = {
      version: 1,
      previousOwner: { type: 'personal' },
      organizationId,
      projectId,
      convertedAt: deps.now(),
    };
    await checkpoint(journal, 'bound');
    await input.beforeMutation?.();
    attempt.bindStarted = true;
    const bound = await deps.workspace.updateOwnership(
      workspaceId,
      (now): WorkspaceOwnership | null =>
        now.type === input.type &&
        now.owner === undefined &&
        sameTransfer(now.ownershipTransfer, input.previousTransfer)
          ? { owner, ownershipTransfer }
          : null,
    );
    if (bound !== 'written') {
      // Nothing was written, so there is no binding to undo.
      attempt.bindStarted = false;
      refuse(
        bound === 'declined'
          ? 'not-personal'
          : bound === 'absent'
            ? 'workspace-not-found'
            : 'workspace-unreadable',
      );
    }
    if (typeof input.privateMemory === 'boolean') {
      await deps.workspace.applyManagedPrivateMemory({
        workspaceId,
        organizationId,
        projectId,
        privateMemory: input.privateMemory,
      });
    }
    await finish(journal, attempt);
    return { ok: true, workspaceId, owner, ownershipTransfer };
  }
  async function moveBack(
    workspaceId: string,
  ): Promise<OrgProjectMoveBackResult> {
    const read = await deps.workspace.readOwnership(workspaceId);
    if (read.authority === 'absent')
      return { ok: false, code: 'workspace-not-found' };
    if (read.authority !== 'ok')
      return { ok: false, code: 'workspace-unreadable' };
    const { owner, ownershipTransfer: transfer } = read;
    if (
      owner === undefined ||
      transfer === undefined ||
      transfer.movedBackAt !== undefined ||
      transfer.organizationId !== owner.organizationId ||
      transfer.projectId !== owner.projectId
    )
      return { ok: false, code: 'not-converted' };
    if (attempts.has(owner.projectId)) return { ok: false, code: 'busy' };
    // Hand the moved activity back first, while the organization still
    // holds the instance: if the server cannot take it back, nothing changes.
    // A 404 is a server without the route, or nothing to return.
    try {
      await deps.cloud.returnActivity(owner.projectId, {
        localWorkspaceId: workspaceId,
      });
    } catch (error) {
      if (!(error instanceof CanopyCloudClientError && error.status === 404))
        return { ok: false, code: 'activity-return-failed' };
    }
    // Release first: a Personal checkout next to a READY instance would hide
    // the project from the organization, so nothing changes locally unless
    // the organization let go of the instance (or no longer holds it).
    try {
      await deps.cloud.detach(owner.instanceId);
    } catch (error) {
      if (
        !(
          error instanceof CanopyCloudClientError &&
          ((error.status === 404 && error.serverCode === 'not_found') ||
            (error.status === 403 && error.serverCode === 'forbidden'))
        )
      )
        return { ok: false, code: 'release-failed' };
    }
    const movedBack: WorkspaceOwnershipTransfer = {
      ...transfer,
      movedBackAt: deps.now(),
    };
    const outcome = await deps.workspace.updateOwnership(
      workspaceId,
      (current): WorkspaceOwnership | null =>
        current.owner?.instanceId === owner.instanceId &&
        sameTransfer(current.ownershipTransfer, transfer)
          ? { owner: undefined, ownershipTransfer: movedBack }
          : null,
    );
    if (outcome !== 'written')
      return {
        ok: false,
        code:
          outcome === 'declined'
            ? 'not-converted'
            : outcome === 'absent'
              ? 'workspace-not-found'
              : 'workspace-unreadable',
      };
    await deps.catalog
      .refresh(
        { kind: 'organization', organizationId: owner.organizationId },
        { force: true },
      )
      .catch((): void => {});
    emitOwnership({
      workspaceId,
      organizationId: owner.organizationId,
      projectId: owner.projectId,
      owner: 'personal',
    });
    await rebindBackgroundExecution({
      workspaceId,
      from: { kind: 'organization', organizationId: owner.organizationId },
      to: { kind: 'personal' },
    });
    return { ok: true, workspaceId, ownershipTransfer: movedBack };
  }
  /**
   * The journals on disk, and what could not be read. Malformed content is not
   * a journal and is simply absent from the list; a directory or file that
   * could not be *read* is different — answering "no journals" there would let
   * the sweep report success while stale claims and keys sit unretired.
   */
  async function journals(): Promise<{
    found: SetupJournal[];
    unreadable: string[];
  }> {
    const dir = deps.paths.setupsDir();
    const files = await readdir(dir).catch((error: unknown): string[] => {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return [];
      throw error;
    });
    const found: SetupJournal[] = [];
    const unreadable: string[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const path = join(dir, file);
      let text: string;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > 65536) continue;
        text = await readFile(path, 'utf8');
      } catch {
        // Could not be read at all: it may still be authorizing a live claim.
        unreadable.push(file);
        continue;
      }
      try {
        const journal = normalizeSetupJournal(JSON.parse(text));
        if (journal && file === `${journal.journalId}.json`)
          found.push(journal);
      } catch {
        /* Malformed content cannot authorize anything, and is not a journal. */
      }
    }
    return { found, unreadable };
  }
  /**
   * A setup that did not finish before the app exited and cannot be resumed
   * (anything before promotion, a conversion or adoption, or a promoted
   * checkout that cannot be accounted for). The claim's 15-minute lease
   * expires on its own, so this only retires this device's side: terminalize
   * the journal and spend its key, so the row goes back to "Set up". Anything
   * the attempt left on disk is deliberately left alone — deleting a checkout
   * on the strength of a journal is a guess.
   *
   * Dispose of a journal left behind by a run that is no longer going. Both the
   * startup sweep and a fresh `startSetup` come through here, so the rules
   * cannot drift apart between them.
   */
  async function retire(journal: SetupJournal): Promise<void> {
    // `checkpoint` overwrites `phase` in place, so read it first.
    const reached = journal.phase;
    // An unfinished conversion is rolled back to Personal before anything
    // else, so a workspace that cannot be read keeps its journal in flight.
    const converting = journal.conversion !== undefined && reached !== 'done';
    const adopting = journal.adoption !== undefined && reached !== 'done';
    // `completing` is written before the request goes out. For an adopted
    // checkout, preserving the binding but discarding this record would leave
    // no durable evidence that the server may already have accepted it. Keep
    // both until a later reconciliation can establish the server outcome.
    if (adopting && reached === 'completing') return;
    const adoptionNeedsRollback = adopting && reached !== 'completing';
    if (converting && !(await restorePersonal(journal)))
      throw new Error('conversion could not be rolled back');
    if (
      adoptionNeedsRollback &&
      !(await deps.workspace.removeBoundWorkspace(
        journal.localWorkspaceId,
        journal.instanceId,
      ))
    )
      throw new Error('adoption could not be rolled back');
    // Spend the key before recording that the journal is finished with, for the
    // same reason the failure path does: a journal marked terminal is one the
    // sweep skips, so terminalizing first would strand a live key and the setup
    // it belongs to. `done` means the server accepted the completion and only
    // the local cleanup was interrupted — nothing to fail, nothing to hand back.
    await rotateAttemptNonce(journal.projectId);
    if (reached !== 'done') await checkpoint(journal, 'failed', 'interrupted');
    // Detaching frees the claim immediately instead of waiting out its
    // 15-minute lease, which is what the user wants before a retry. Once a
    // completion has been *requested* it stops being safe: `completing` is
    // written before the request goes out, so it may describe an instance the
    // server already made READY, and `done` says it certainly did. Detaching
    // either would undo a completion the server accepted. Every earlier phase
    // asked for no completion, so nothing can have committed.
    if (
      converting ||
      adoptionNeedsRollback ||
      !['completing', 'done'].includes(reached)
    )
      await deps.cloud.detach(journal.instanceId).catch((): void => {});
    await rm(join(deps.paths.setupsDir(), `${journal.journalId}.json`), {
      force: true,
    });
  }
  /**
   * Ask the server to move a converted checkout's uploaded Personal activity
   * to the organization. Best effort: the server re-checks everything, a
   * replay is a no-op, and `sweep` retries it on every launch.
   */
  async function moveActivity(
    projectId: string,
    workspaceId: string,
    credentialContext?: CanopyCloudCredentialContext,
  ): Promise<void> {
    await deps.cloud
      .moveActivity(
        projectId,
        { localWorkspaceId: workspaceId },
        ...(credentialContext ? [credentialContext] : []),
      )
      .then(
        (response): void => report(answeredMove(projectId, response)),
        (error: unknown): void => report(failedMove(projectId, error)),
      );
  }
  function report(move: ActivityMoveReport): void {
    try {
      deps.reportActivityMove(move);
    } catch {
      // Visibility only; the move itself is already settled.
    }
  }
  /**
   * Put every workspace's already-uploaded activity where it belongs.
   *
   * - Converted, still bound to the project it was converted into: retry the
   *   CAN-3418 move on every launch; the server answers a replay with
   *   `already-moved`.
   * - Otherwise bound to an organization project (set up from the catalog,
   *   org Cowork, default Chats): once, move the member's private rows for
   *   the checkout to the organization, unless the member keeps activity for
   *   that organization private (CAN-3517).
   * - Personal, never converted: once, return the member's rows for the
   *   checkout that were filed in an organization (CAN-3517).
   *
   * "Once" is per workspace and ownership, recorded in the repair ledger when
   * the server answers or refuses for good; anything else is retried on the
   * next launch. The server verifies every move before it changes anything.
   */
  async function reconcileActivityOwnership(): Promise<void> {
    const access = await deps.access();
    if (
      !access.enabled ||
      !access.accountId ||
      !access.capabilities.includes('org-projects-v1')
    )
      return;
    const { accountId } = access;
    const repaired = await deps.activityRepair.ledger.read(accountId);
    for (const item of await deps.readItems()) {
      if (
        changingWorkspaces.has(item.id) ||
        (item.owner?.type === 'organization' &&
          attempts.has(item.owner.projectId))
      )
        continue;
      const read = await deps.workspace.readOwnership(item.id);
      if (read.authority !== 'ok') continue;
      const target = activityRepairTarget(read);
      if (target === null) continue;
      if (target.kind === 'converted') {
        await moveActivity(target.projectId, item.id);
        continue;
      }
      if (repaired[item.id]?.target === target.key) continue;
      const record = (outcome: string): Promise<void> =>
        deps.activityRepair.ledger.record(accountId, item.id, {
          target: target.key,
          outcome,
          at: deps.now(),
        });
      if (target.kind === 'organization') {
        const sharing = await deps.activityRepair.sharingFor(
          target.organizationId,
        );
        if (sharing === null) continue;
        const decision = resolveActivityRepairSharing(sharing);
        if (!decision.share) {
          await record('kept-private');
          continue;
        }
        await deps.cloud
          .moveActivity(target.projectId, {
            localWorkspaceId: item.id,
            withheldKinds: decision.withheldKinds,
          })
          .then(
            (response) => {
              report(answeredMove(target.projectId, response));
              return record(repairOutcome(response));
            },
            (error: unknown) => {
              report(failedMove(target.projectId, error));
              return recordFailure(error, record);
            },
          );
        continue;
      }
      await deps.cloud
        .returnPersonalActivity({ localWorkspaceId: item.id })
        .then(
          (response) => record(repairOutcome(response)),
          (error: unknown) => recordFailure(error, record),
        );
    }
  }
  async function sweep(): Promise<void> {
    const failures: unknown[] = [];
    const { found, unreadable } = await journals();
    for (const file of unreadable)
      failures.push(new Error(`journal ${file} could not be read`));
    for (const journal of found) {
      if (
        attempts.has(journal.projectId) ||
        ['failed', 'cancelled'].includes(journal.phase)
      )
        continue;
      // One unreadable store or unwritable file must not stop the rest: the
      // journals left here are independent, and the next launch sweeps again.
      // The failures are still worth surfacing, so they are collected rather
      // than swallowed — a sweep that quietly did nothing is indistinguishable
      // from one with nothing to do.
      await (
        resumable(journal) ? resumeInterrupted(journal) : retire(journal)
      ).catch((error: unknown): void => {
        failures.push(error);
      });
    }
    // After the journals, so a slow server cannot hold interrupted setups
    // back. Best effort: every workspace it skips is retried next launch.
    await reconcileActivityOwnership().catch((): void => {});
    if (failures.length > 0)
      throw new Error(
        `${failures.length} interrupted setup(s) could not be retired: ${failures
          .map((error) => (error instanceof Error ? error.message : 'unknown'))
          .join('; ')}`,
      );
  }
  function newAdoptionAttempt(first: OrgProjectSetupProgress): Attempt {
    return {
      controller: new AbortController(),
      first,
      done: Promise.resolve(),
      // There is no clone to cancel, and the checkout must never be removed.
      promoted: true,
      ownsStaging: false,
      adoption: true,
    };
  }

  async function executeAdoption(
    input: {
      projectId: string;
      organizationId: string;
      path: string;
      preferredName: string;
    },
    options: { createdRepo?: boolean },
    attempt: Attempt,
  ): Promise<{ localWorkspaceId: string }> {
    try {
      return await adopt(input, options, attempt);
    } catch (error) {
      await reportFailure(input.projectId, attempt, error);
      throw new OrgProjectAdoptionError(
        error instanceof SetupError ? error.message : 'Project setup failed',
        attempt.completionSent === true,
      );
    }
  }

  /**
   * One conversion of a workspace, single-repo or multi-repo. The workspace
   * is reserved for the whole attempt, and the project from the moment
   * `work` names it (a multi-repo conversion learns it from the server), so
   * a setup, conversion or move back of either answers `busy` meanwhile.
   */
  async function runConversion(
    workspaceId: string,
    work: (
      attempt: Attempt,
      claimProject: (projectId: string) => void,
      created: (projectId: string) => void,
    ) => Promise<Extract<OrgProjectConversionResult, { ok: true }>>,
  ): Promise<OrgProjectConversionResult> {
    const attempt: Attempt = {
      controller: new AbortController(),
      // What a setup started meanwhile joins; never broadcast.
      first: {
        projectId: '',
        instanceId: null,
        state: 'claiming',
        message: COPY.claiming,
        percent: null,
        updatedAt: deps.now(),
      },
      done: Promise.resolve(),
      // Nothing to cancel: there is no clone, and the checkout is the user's.
      promoted: true,
      ownsStaging: false,
      conversion: true,
    };
    const reserved: { projectId?: string; createdProjectId?: string } = {};
    const created = (id: string): void => {
      reserved.createdProjectId = id;
    };
    const claimProject = (id: string): void => {
      if (attempts.has(id)) refuse('busy');
      reserved.projectId = id;
      attempt.first = { ...attempt.first, projectId: id };
      attempts.set(id, attempt);
    };
    changingWorkspaces.add(workspaceId);
    try {
      const result = await work(attempt, claimProject, created);
      emitOwnership({
        workspaceId,
        organizationId: result.owner.organizationId,
        projectId: result.owner.projectId,
        owner: 'organization',
      });
      await rebindBackgroundExecution({
        workspaceId,
        from: { kind: 'personal' },
        to: {
          kind: 'organization',
          organizationId: result.owner.organizationId,
        },
      });
      // The conversion is complete on the server, so it can now vouch for
      // moving the Personal activity uploaded from this checkout. A failure
      // here does not undo the conversion; the next launch retries it.
      try {
        await attempt.beforeMutation?.();
      } catch {
        return result;
      }
      await moveActivity(
        result.owner.projectId,
        workspaceId,
        attempt.credentialContext,
      );
      return result;
    } catch (error) {
      // A refusal before the claim changed nothing and has nothing to undo.
      const setupCode =
        attempt.claimSent && reserved.projectId !== undefined
          ? await reportFailure(reserved.projectId, attempt, error)
          : '';
      const code = conversionFailureCode(error, setupCode);
      return reserved.createdProjectId === undefined
        ? { ok: false, code }
        : { ok: false, code, organizationProjectId: reserved.createdProjectId };
    } finally {
      if (
        reserved.projectId !== undefined &&
        attempts.get(reserved.projectId) === attempt
      )
        attempts.delete(reserved.projectId);
      changingWorkspaces.delete(workspaceId);
    }
  }
  return {
    startSetup(projectId, destinationRoot): Promise<OrgProjectSetupProgress> {
      const existing = attempts.get(projectId);
      if (existing) {
        // A renderer start joining the startup sweep's reclaim is someone to
        // report to: from here on that attempt reports like any other.
        if (existing.quiet === true) {
          existing.quiet = false;
          emit(
            projectId,
            existing.first.state,
            existing.first.message ?? COPY.materializing,
            existing.journal,
          );
        }
        return Promise.resolve(existing.first);
      }
      const first = emit(projectId, 'claiming', COPY.claiming);
      const attempt: Attempt = {
        controller: new AbortController(),
        first,
        done: Promise.resolve(),
        promoted: false,
        ownsStaging: false,
      };
      attempts.set(projectId, attempt);
      attempt.done = Promise.resolve()
        .then(() => run(projectId, destinationRoot, attempt))
        .catch((error: unknown): void => {
          emit(
            projectId,
            'failed',
            error instanceof Error
              ? error.message
              : 'Could not save setup progress',
            attempt.journal,
            null,
            'persistence-failed',
          );
        })
        .finally((): void => {
          attempts.delete(projectId);
        });
      return Promise.resolve(first);
    },
    async adoptCheckout(
      input,
      options = {},
    ): Promise<{ localWorkspaceId: string }> {
      if (attempts.has(input.projectId))
        throw new OrgProjectAdoptionError(
          'Project setup is already running',
          false,
        );
      const first = emit(input.projectId, 'claiming', COPY.claiming);
      const attempt = newAdoptionAttempt(first);
      attempts.set(input.projectId, attempt);
      try {
        return await executeAdoption(input, options, attempt);
      } finally {
        attempts.delete(input.projectId);
      }
    },
    setupFromFolder(projectId, path): Promise<OrgProjectSetupProgress> {
      const existing = attempts.get(projectId);
      if (existing) return Promise.resolve(existing.first);
      const first = emit(projectId, 'claiming', COPY.claiming);
      const attempt = newAdoptionAttempt(first);
      attempts.set(projectId, attempt);
      const accessPromise = deps.access();
      attempt.done = accessPromise
        .then((access) => {
          if (access.context.kind !== 'organization') fail('access-removed');
          return executeAdoption(
            {
              projectId,
              organizationId: access.context.organizationId,
              path,
              preferredName: '',
            },
            {},
            attempt,
          );
        })
        .then((): void => undefined)
        .catch((): void => undefined)
        .finally((): void => {
          attempts.delete(projectId);
        });
      return Promise.resolve(first);
    },
    async convertWorkspace(
      request,
      options = {},
    ): Promise<OrgProjectConversionResult> {
      const { projectId, workspaceId } = request;
      if (attempts.has(projectId) || changingWorkspaces.has(workspaceId))
        return { ok: false, code: 'busy' };
      return runConversion(workspaceId, (attempt, claimProject) => {
        claimProject(projectId);
        return convert(request, attempt, options);
      });
    },
    async convertMultiRepoWorkspace(
      request,
      options = {},
    ): Promise<OrgProjectConversionResult> {
      const { workspaceId } = request;
      if (changingWorkspaces.has(workspaceId))
        return { ok: false, code: 'busy' };
      return runConversion(workspaceId, (attempt, claimProject) =>
        convertMulti(request, attempt, options, claimProject),
      );
    },
    async convertCoworkWorkspace(
      request,
      options = {},
    ): Promise<OrgProjectConversionResult> {
      const { workspaceId } = request;
      if (changingWorkspaces.has(workspaceId))
        return { ok: false, code: 'busy' };
      return runConversion(workspaceId, (attempt, claimProject, created) =>
        convertCowork(request, attempt, options, claimProject, created),
      );
    },
    async moveBackToPersonal({
      workspaceId,
    }): Promise<OrgProjectMoveBackResult> {
      if (changingWorkspaces.has(workspaceId))
        return { ok: false, code: 'busy' };
      changingWorkspaces.add(workspaceId);
      try {
        return await moveBack(workspaceId);
      } finally {
        changingWorkspaces.delete(workspaceId);
      }
    },
    onOwnershipChanged(listener): () => void {
      ownershipListeners.add(listener);
      return (): void => {
        ownershipListeners.delete(listener);
      };
    },
    async cancelSetup(projectId): Promise<void> {
      const attempt = attempts.get(projectId);
      if (!attempt) return;
      if (attempt.promoted)
        throw new Error('This project is already a workspace');
      attempt.controller.abort();
      await attempt.done;
    },
    sweepInterruptedSetups(): Promise<void> {
      sweeping ??= sweep().finally((): void => {
        sweeping = undefined;
      });
      return sweeping;
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}
let singleton: OrgProjectMaterialization | undefined;
export function getOrgProjectMaterialization(): OrgProjectMaterialization {
  singleton ??= createOrgProjectMaterialization(createProductionDeps());
  return singleton;
}
export function resetOrgProjectMaterializationForTests(): void {
  singleton = undefined;
}
import { createProductionDeps } from './org-project-materialization-deps';
