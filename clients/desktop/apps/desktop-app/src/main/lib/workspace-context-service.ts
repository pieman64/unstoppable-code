import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  PERSONAL_WORKSPACE_CONTEXT,
  isSameWorkspaceContext,
  parseWorkspaceContext,
  serializeWorkspaceContext,
  type WorkspaceContext,
  type WorkspaceContextBroadcast,
  type WorkspaceContextChangeReason,
  type WorkspaceContextOrganization,
  type WorkspaceContextState,
} from '@canopy/desktop-shared/types';
import { isWorkspaceContextOrganizationRole } from '@canopy/protocol/workspace-context';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { writeFileAtomically } from './atomic-file';
import {
  readCanopyCloudAccountWithStatus,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from './canopy-cloud-account-store';
import { getWorkspaceContextFilePath } from './paths';

export type {
  WorkspaceContextBroadcast,
  WorkspaceContextState,
} from '@canopy/desktop-shared/types';

/**
 * Main-owned, account-scoped selection of the navigation context: the user's
 * Personal projects or one organization's projects (CAN-2952, plan chapter 03
 * "Context and navigation").
 *
 * The context is a navigation fact only. Selecting an organization never
 * grants access or changes execution ownership. Telemetry snapshots this
 * selection at enqueue as a delivery ceiling (CAN-3278); every consumer still
 * re-derives authorization from live membership. What this service
 * guarantees:
 *
 * - One authority. Renderer windows read and switch through IPC and receive
 *   the same broadcast, so two windows can never disagree.
 * - Serialized switches with a monotonic `revision` per account, so a caller
 *   that passes the revision it last saw is rejected when it is stale.
 * - Persistence per account under `<dataDir>/workspace-context.json`. A
 *   different account never inherits another account's selection, and a
 *   signed-out account's selection survives for its next sign-in.
 * - Fallback to Personal whenever the selected organization is not a current
 *   membership: on restore, on a membership refresh that drops it
 *   (`departed`), and on sign-out or account change (`account-change`).
 */

const WORKSPACE_CONTEXT_FILE_VERSION = 1;

interface PersistedWorkspaceContextEntry {
  context: string;
  revision: number;
}

interface PersistedWorkspaceContextFile {
  version: number;
  byAccount: Record<string, PersistedWorkspaceContextEntry>;
}

export type WorkspaceContextErrorCode =
  | 'unknown-organization'
  | 'stale-revision';

export class WorkspaceContextError extends Error {
  readonly code: WorkspaceContextErrorCode;

  constructor(code: WorkspaceContextErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceContextError';
    this.code = code;
  }
}

export interface WorkspaceContextService {
  /** Load the account and the persisted selection. Idempotent. */
  initialize(): Promise<void>;
  getState(): WorkspaceContextState;
  /**
   * Switch context. Resolves with the new state (unchanged when the context
   * is already selected). Rejects with {@link WorkspaceContextError} when the
   * organization is not a current membership or `expectedRevision` is stale.
   */
  setContext(
    context: WorkspaceContext,
    expectedRevision?: number,
  ): Promise<WorkspaceContextState>;
  subscribe(listener: (state: WorkspaceContextBroadcast) => void): () => void;
  /** Resolves once every queued switch and account transition has settled. */
  whenIdle(): Promise<void>;
  /**
   * Monotonic counter bumped on EVERY account event, including a sign-out and
   * sign-in that lands back on the same account id. A long operation captures
   * it once and re-checks before each side effect; the account id alone cannot
   * see a same-id transition.
   */
  accountEpoch(): number;
  /** Main-only resource mapping, never a switcher organization. */
  personalOrganizationId(): string | null;
  dispose(): void;
}

function isRolloutEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePersistedFile(value: unknown): PersistedWorkspaceContextFile {
  const empty: PersistedWorkspaceContextFile = {
    version: WORKSPACE_CONTEXT_FILE_VERSION,
    byAccount: {},
  };
  if (
    !isRecord(value) ||
    value.version !== WORKSPACE_CONTEXT_FILE_VERSION ||
    !isRecord(value.byAccount)
  ) {
    return empty;
  }
  const byAccount: Record<string, PersistedWorkspaceContextEntry> = {};
  for (const [accountId, entry] of Object.entries(value.byAccount)) {
    if (
      isRecord(entry) &&
      typeof entry.context === 'string' &&
      parseWorkspaceContext(entry.context) !== null &&
      typeof entry.revision === 'number' &&
      Number.isInteger(entry.revision) &&
      entry.revision >= 0
    ) {
      byAccount[accountId] = {
        context: entry.context,
        revision: entry.revision,
      };
    }
  }
  return { version: WORKSPACE_CONTEXT_FILE_VERSION, byAccount };
}

async function readPersistedFile(): Promise<PersistedWorkspaceContextFile> {
  try {
    const raw = await readFile(getWorkspaceContextFilePath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return normalizePersistedFile(parsed);
  } catch {
    // Missing or corrupt state starts from Personal; nothing here is worth
    // failing startup over.
    return normalizePersistedFile(null);
  }
}

function accountKey(entry: CanopyCloudAccountEntry | null): string | null {
  // The store normalizes entries, but a partially written or legacy record can
  // still surface without an id; treat it as signed out rather than crash.
  const rawId = entry?.account?.id;
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  return id ? id : null;
}

/** Backoff for re-reading an account store that was unavailable at startup. */
const STARTUP_READ_RETRY_DELAYS_MS: readonly number[] = [
  2_000, 5_000, 15_000, 30_000, 60_000,
];

/** What startup learned about the account: a real answer, or nothing yet. */
type StartupAccountRead =
  | { kind: 'read'; entry: CanopyCloudAccountEntry | null }
  | { kind: 'unavailable' };

/**
 * Read the cloud account for startup, keeping "signed out" apart from "could
 * not read". Secure storage can be unavailable (a locked keychain, a corrupt
 * store); the context then starts from Personal WITHOUT adopting a sign-out,
 * and the account-change subscription delivers the real entry once the store
 * recovers. Startup never fails on it.
 */
async function readAccountForStartup(): Promise<StartupAccountRead> {
  try {
    const result = await readCanopyCloudAccountWithStatus({ cache: false });
    return result.status === 'ok'
      ? { kind: 'read', entry: result.entry }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

function organizationsOf(
  entry: CanopyCloudAccountEntry | null,
): WorkspaceContextOrganization[] {
  return (entry?.organizations ?? []).map((organization) => {
    // `role` reaches the summary with CAN-2940; until both land together it
    // is read structurally. Absent or unknown means the least privileged role
    // for the client; the server re-checks the real role on every operation.
    const raw: Record<string, unknown> = { ...organization };
    return {
      id: organization.id,
      name: organization.name,
      ...(typeof organization.logoUrl === 'string' &&
      organization.logoUrl.length > 0
        ? { logoUrl: organization.logoUrl }
        : {}),
      role: isWorkspaceContextOrganizationRole(raw.role) ? raw.role : 'MEMBER',
    };
  });
}

/**
 * The server mints `org-projects-v1` per user from the same rollout flag. The
 * catalog and organization Chats need it, so consumers re-check when it
 * changes even though the memberships did not.
 */
function hasOrgProjectsCapability(
  entry: CanopyCloudAccountEntry | null,
): boolean {
  return entry?.capabilities.includes('org-projects-v1') === true;
}

function isMember(
  context: WorkspaceContext,
  organizations: readonly WorkspaceContextOrganization[],
): boolean {
  return (
    context.kind === 'personal' ||
    organizations.some(
      (organization) => organization.id === context.organizationId,
    )
  );
}

export function createWorkspaceContextService(): WorkspaceContextService {
  let accountId: string | null = null;
  /** Highest revision this process has handed out, across accounts. */
  let revisionFloor = 0;
  /** Signed-in accounts adopted so far; every later adoption is a transition. */
  let adoptedAccounts = 0;
  /** Pending retry of a startup read that found secure storage unavailable. */
  let startupRetry: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped on every account event the service processes. A startup retry
   * captures it before reading and discards its result when it moved, so a
   * read that raced a sign-in, sign-out, or account switch can never re-adopt
   * stale account state.
   */
  let accountGeneration = 0;
  let state: WorkspaceContextState = {
    context: PERSONAL_WORKSPACE_CONTEXT,
    revision: 0,
    organizations: [],
  };
  let persistedFile: PersistedWorkspaceContextFile | null = null;
  const listeners = new Set<(state: WorkspaceContextBroadcast) => void>();
  // Every mutation (switch, account transition) runs on this chain so a
  // revision is assigned exactly once and in order across windows.
  let chain: Promise<unknown> = Promise.resolve();
  let initialized: Promise<void> | null = null;
  let unsubscribeAccount: (() => void) | null = null;
  let unsubscribeFlags: (() => void) | null = null;
  let rolloutEnabled = isRolloutEnabled();
  let orgProjectsCapability = false;
  let personalOrganizationId: string | null = null;

  /**
   * CAN-2960: the rollout flag is the single switch for organization
   * projects on the desktop. While it is off every consumer of this service
   * (renderer, telemetry, catalog, background bindings) sees the Personal
   * context and no memberships, whatever selection is persisted; the stored
   * selection is untouched so it returns when the flag does.
   */
  function projected(): WorkspaceContextState {
    return isRolloutEnabled()
      ? state
      : { ...state, context: PERSONAL_WORKSPACE_CONTEXT, organizations: [] };
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function broadcast(reason: WorkspaceContextChangeReason): void {
    const payload: WorkspaceContextBroadcast = { ...projected(), reason };
    listeners.forEach((listener) => {
      try {
        listener(payload);
      } catch {
        // A faulty subscriber must not break the switch for the others.
      }
    });
  }

  async function persist(): Promise<void> {
    if (!accountId) {
      return;
    }
    const file = persistedFile ?? (await readPersistedFile());
    persistedFile = {
      version: WORKSPACE_CONTEXT_FILE_VERSION,
      byAccount: {
        ...file.byAccount,
        [accountId]: {
          context: serializeWorkspaceContext(state.context),
          revision: state.revision,
        },
      },
    };
    const filePath = getWorkspaceContextFilePath();
    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFileAtomically(
        filePath,
        `${JSON.stringify(persistedFile, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch {
      // Persistence is best effort: the in-memory state is still authoritative
      // for this process, and the next successful write catches up.
    }
  }

  /** Replace the in-memory state for `entry`, restoring its persisted selection. */
  async function adoptAccount(
    entry: CanopyCloudAccountEntry | null,
  ): Promise<void> {
    accountId = accountKey(entry);
    orgProjectsCapability = hasOrgProjectsCapability(entry);
    personalOrganizationId = entry?.personalOrganizationId ?? null;
    const organizations = organizationsOf(entry);
    persistedFile ??= await readPersistedFile();
    const persisted = accountId
      ? persistedFile.byAccount[accountId]
      : undefined;
    const restored = persisted
      ? parseWorkspaceContext(persisted.context)
      : null;
    const restoredIsCurrent =
      restored !== null && isMember(restored, organizations);
    // Revisions are fenced across accounts within this process: an account
    // switch always moves past every revision handed out so far, so a switch
    // request minted under the previous account can never match by
    // coincidence and land on the new one.
    // Signed out has no revision space to fence: nothing persists and every
    // organization switch is rejected as an unknown membership. Every
    // account-to-account transition advances the fence, even from revision 0,
    // so a delayed request from the previous account can never match.
    const fencedRevision = accountId
      ? Math.max(
          persisted?.revision ?? 0,
          adoptedAccounts > 0 ? revisionFloor + 1 : 0,
        )
      : 0;
    if (accountId) {
      adoptedAccounts += 1;
    }
    state = {
      context: restoredIsCurrent ? restored : PERSONAL_WORKSPACE_CONTEXT,
      revision: fencedRevision,
      organizations,
    };
    revisionFloor = Math.max(revisionFloor, state.revision);
    if (
      restored !== null &&
      restored.kind === 'organization' &&
      !restoredIsCurrent
    ) {
      // The persisted selection names an organization the account no longer
      // belongs to. Record the fallback like the live departure path does, so
      // a membership that returns before the next restart cannot resurrect
      // the stale selection.
      state = { ...state, revision: state.revision + 1 };
      revisionFloor = Math.max(revisionFloor, state.revision);
      await persist();
    }
  }

  async function handleAccountChange(
    entry: CanopyCloudAccountEntry | null,
  ): Promise<void> {
    accountGeneration += 1;
    if (startupRetry) {
      // A real account event supersedes the startup read entirely.
      clearTimeout(startupRetry);
      startupRetry = null;
    }
    const nextAccountId = accountKey(entry);
    if (nextAccountId !== accountId) {
      await adoptAccount(entry);
      broadcast('account-change');
      return;
    }
    const capabilityChanged =
      hasOrgProjectsCapability(entry) !== orgProjectsCapability;
    const personalMappingChanged =
      personalOrganizationId !== (entry?.personalOrganizationId ?? null);
    orgProjectsCapability = hasOrgProjectsCapability(entry);
    personalOrganizationId = entry?.personalOrganizationId ?? null;
    const organizations = organizationsOf(entry);
    if (!isMember(state.context, organizations)) {
      state = {
        context: PERSONAL_WORKSPACE_CONTEXT,
        revision: state.revision + 1,
        organizations,
      };
      revisionFloor = Math.max(revisionFloor, state.revision);
      await persist();
      broadcast('departed');
      return;
    }
    const unchanged =
      organizations.length === state.organizations.length &&
      organizations.every((organization, index) => {
        const previous = state.organizations[index];
        return (
          previous !== undefined &&
          previous.id === organization.id &&
          previous.name === organization.name &&
          previous.role === organization.role &&
          // A logo can arrive after an account cached without one.
          (previous.logoUrl ?? null) === (organization.logoUrl ?? null)
        );
      });
    if (unchanged) {
      // Organization availability is the rollout flag plus the capability the
      // server mints from it, so a capability change is announced like a
      // rollout flip.
      if (capabilityChanged || personalMappingChanged)
        broadcast('organizations');
      return;
    }
    state = { ...state, organizations };
    broadcast('organizations');
  }

  /**
   * Secure storage that was unavailable at startup usually becomes readable
   * shortly after (keychain unlock, first-run migration). The account-change
   * subscription only fires on writes, so poll the read a bounded number of
   * times and adopt the entry through the normal account-change path once it
   * answers; give up quietly after the last attempt.
   */
  function scheduleStartupRetry(attempt: number): void {
    if (attempt >= STARTUP_READ_RETRY_DELAYS_MS.length) {
      return;
    }
    startupRetry = setTimeout(() => {
      startupRetry = null;
      const generation = accountGeneration;
      void readAccountForStartup().then((result) => {
        if (accountGeneration !== generation) {
          // An account event landed while the read was in flight; its state
          // is newer than anything this read can report.
          return;
        }
        if (result.kind === 'read') {
          void enqueue(() => {
            if (accountGeneration !== generation) return Promise.resolve();
            return handleAccountChange(result.entry);
          });
          return;
        }
        scheduleStartupRetry(attempt + 1);
      });
    }, STARTUP_READ_RETRY_DELAYS_MS[attempt]);
    startupRetry.unref?.();
  }

  function handleRolloutChange(): void {
    void enqueue((): Promise<void> => {
      const next = isRolloutEnabled();
      if (next === rolloutEnabled) return Promise.resolve();
      rolloutEnabled = next;
      // Serialize notifications with context/account mutations; projection
      // still reads the live flag while an earlier persistence is pending.
      broadcast('organizations');
      return Promise.resolve();
    });
  }

  return {
    initialize(): Promise<void> {
      initialized ??= enqueue(async () => {
        const startup = await readAccountForStartup();
        await adoptAccount(startup.kind === 'read' ? startup.entry : null);
        if (startup.kind === 'unavailable') {
          scheduleStartupRetry(0);
        }
        unsubscribeAccount = subscribeCanopyCloudAccountChanges((entry) => {
          void enqueue(() => handleAccountChange(entry));
        });
        unsubscribeFlags =
          getFeatureFlagService().onSnapshotChanged(handleRolloutChange);
        handleRolloutChange();
      });
      return initialized;
    },
    getState(): WorkspaceContextState {
      return projected();
    },
    setContext(context, expectedRevision): Promise<WorkspaceContextState> {
      return enqueue(async () => {
        if (!isRolloutEnabled()) {
          if (context.kind === 'personal') return projected();
          throw new WorkspaceContextError(
            'unknown-organization',
            'Organization projects are not available for this account yet.',
          );
        }
        if (
          expectedRevision !== undefined &&
          expectedRevision !== state.revision
        ) {
          throw new WorkspaceContextError(
            'stale-revision',
            `Workspace context changed elsewhere (expected revision ${expectedRevision}, current ${state.revision}).`,
          );
        }
        if (!isMember(context, state.organizations)) {
          throw new WorkspaceContextError(
            'unknown-organization',
            'That organization is not one of your current memberships.',
          );
        }
        if (isSameWorkspaceContext(context, state.context)) {
          return projected();
        }
        state = { ...state, context, revision: state.revision + 1 };
        revisionFloor = Math.max(revisionFloor, state.revision);
        await persist();
        broadcast('switch');
        return projected();
      });
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    whenIdle(): Promise<void> {
      return chain.then(() => undefined);
    },
    accountEpoch(): number {
      return accountGeneration;
    },
    personalOrganizationId(): string | null {
      return rolloutEnabled ? personalOrganizationId : null;
    },
    dispose(): void {
      unsubscribeFlags?.();
      unsubscribeFlags = null;
      unsubscribeAccount?.();
      if (startupRetry) {
        clearTimeout(startupRetry);
        startupRetry = null;
      }
      unsubscribeAccount = null;
      listeners.clear();
    },
  };
}

let singleton: WorkspaceContextService | null = null;

export function getWorkspaceContextService(): WorkspaceContextService {
  singleton ??= createWorkspaceContextService();
  return singleton;
}

/**
 * Main-process list/search scoping context. A disabled rollout deliberately
 * returns `undefined` so legacy all-workspace behavior remains unchanged.
 */
export function getWorkspaceScopingContext(): WorkspaceContext | undefined {
  return isRolloutEnabled()
    ? getWorkspaceContextService().getState().context
    : undefined;
}

export function __resetWorkspaceContextServiceForTests(): void {
  singleton?.dispose();
  singleton = null;
}
