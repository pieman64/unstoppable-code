import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type {
  DesktopOrgProjectCatalogSnapshot,
  OrgProjectConversionErrorCode,
  OrgProjectConversionResult,
  OrgProjectConvertMultiRepoWorkspaceRequest,
  OrgProjectConvertWorkspaceRequest,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import type { OrgProjectConversionOptions } from '../lib/org-project-materialization';
import {
  isMigrationPassOrganizationId,
  isMigrationPassWorkspaceId,
  ORG_PROJECT_MIGRATION_PASSES_UNREADABLE,
  type OrgProjectMigrationPass,
  type OrgProjectMigrationPassStore,
} from '../lib/org-project-migration-passes';
import {
  holdsOrganizationRepository,
  matchOrganizationRepository,
} from '../lib/org-project-relationships';
import type { WorkspaceOwnershipRead } from '../lib/workspace-persistence';

/**
 * Scheduled one-time conversion of Personal projects (CAN-3416, hybrid model
 * 2026-10-02) and awaited creation-time combination binding (CAN-3846).
 *
 * When the organization-projects flag is on, a Personal single-repo checkout
 * whose repository is an organization project the member can use is
 * converted through the coordinator's `convertWorkspace` (CAN-3415), with no
 * prompt: the organization proved it owns the repository (CAN-3385). This
 * module only decides *which* workspaces to hand to it and *when*; the claim,
 * binding, completion, rollback and recorded previous owner all stay in the
 * coordinator.
 *
 * - It is a one-time migration per organization, not a standing rule. Each
 *   organization's pass starts the first time this device sees the member in
 *   it, and only the Personal workspaces that existed then are eligible. The
 *   pass completes once nothing eligible is left to retry (or a week after it
 *   started); afterwards nothing is moved into that organization
 *   automatically. A project created or added later is never moved
 *   by a scan, into any organization. Creation-time combination binding is
 *   independent of these passes. The device-local ledger is
 *   `org-project-migration-passes.ts`; an unreadable ledger stops scans.
 * - Scheduled scans are debounced one-time migrations. Awaited inline
 *   combination decisions share their queue and session memory, but never
 *   read or change migration passes or their eligibility.
 * - Every organization the member belongs to is checked, not only the
 *   selected context, so a match is never decided on a partial view: a
 *   checkout that matches projects in more than one organization is skipped,
 *   and so is one whose decision depends on a catalog that is not known yet.
 * - A workspace that already carries an `ownershipTransfer` (it was converted
 *   before and moved back) is never converted again.
 * - A refusal that can succeed later is retried on a later trigger, with a
 *   per-workspace backoff so the conversion's own catalog refresh cannot
 *   re-trigger it in a loop; one that cannot is remembered for the session.
 * - Personal multi-repo projects, including temporary combinations, convert
 *   when exactly one member organization holds at least one repository and
 *   no other member organization holds any. Unheld checkouts stay local;
 *   the coordinator's definition contains only held repositories.
 * - Retired combinations are silently skipped without holding a pass open.
 *   They stay in pass membership and may convert if revived before closure.
 *   Retirement at the coordinator's fresh read instead refuses for the session.
 */

export const ORG_PROJECTS_CAPABILITY_V1 = 'org-projects-v1';
/** Quiet period after a trigger (catalog refresh, membership, flag change). */
export const ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS = 2_000;
/** The first run waits this long after start, well past first paint. */
export const ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS = 5_000;
/** Backoff after the first transient refusal; doubles per repeat. */
export const ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS = 60_000;
export const ORG_PROJECT_AUTO_CONVERSION_RETRY_MAX_MS = 60 * 60_000;
/**
 * A pass that still has pending retries completes at most this long after it
 * started, so the one-time migration stays bounded.
 */
export const ORG_PROJECT_MIGRATION_PASS_MAX_MS = 7 * 24 * 60 * 60_000;

/** Refusals no later trigger can change within this session. */
const PERMANENT_REFUSALS: ReadonlySet<OrgProjectConversionErrorCode> =
  new Set<OrgProjectConversionErrorCode>([
    'repository-mismatch',
    'unsupported-workspace',
    'not-personal',
    'workspace-not-found',
    'project-already-bound',
    'previously-converted',
  ]);

export type OrgProjectAutoConversionSkipReason =
  /** The member moved it back to Personal; permanent opt-out. */
  | 'moved-back'
  /** It carries a conversion record without an owner or a move back. */
  | 'previously-converted'
  /** Its repository matches projects in more than one organization. */
  | 'ambiguous-organizations'
  /** Its repository matches more than one project in one organization. */
  | 'ambiguous-projects'
  /** Another member organization's catalog is not known yet. */
  | 'catalog-unavailable'
  /** Git could not read the checkout's `origin`. */
  | 'repository-unavailable'
  /** Another workspace on this device already holds the project. */
  | 'project-already-bound'
  /** A multi-repo project whose repositories no single organization holds. */
  | 'repositories-span-organizations'
  /**
   * Its organization's one-time pass is over, or did not list it because it
   * did not exist when the pass started.
   */
  | 'outside-migration-pass';

export type OrgProjectAutoConversionEvent =
  | {
      outcome: 'converted';
      workspaceId: string;
      organizationId: string;
      projectId: string;
    }
  | {
      outcome: 'skipped';
      workspaceId: string;
      reason: OrgProjectAutoConversionSkipReason;
      organizationId?: string;
      projectId?: string;
      /** Organizations the repository (or repositories) matched in. */
      organizationCount?: number;
    }
  | {
      outcome: 'failed';
      workspaceId: string;
      organizationId: string;
      /** Absent for a multi-repo project refused before it had one. */
      projectId?: string;
      reason: OrgProjectConversionErrorCode;
      /** Whether a later trigger retries it. */
      retry: 'later' | 'never-this-session';
    };

/** One organization's one-time pass started or completed. */
export type OrgProjectMigrationPassEvent =
  | {
      outcome: 'started';
      organizationId: string;
      /** Personal workspaces the pass may move. */
      workspaceCount: number;
    }
  | {
      outcome: 'completed';
      organizationId: string;
      /** `expired` when it still had pending retries at the time cap. */
      completion: 'settled' | 'expired';
    };

/** The slice of a sidebar item a run reads. */
export interface OrgProjectAutoConversionWorkspace {
  id: string;
  /** The checkout for a single-repo workspace; `null` for every other type. */
  repoPath: string | null;
  /**
   * A multi-repo workspace's checkouts, its root first when it has one
   * (CAN-3532), including temporary combinations. Absent for other types.
   */
  repoPaths?: readonly string[];
  /**
   * Retirement from the fresh raw sidebar item. Only explicit true skips
   * conversion; the workspace remains in pass membership for later revival.
   */
  retired?: boolean;
  /** Inline creation-time decisions only accept temporary combinations. */
  temporary?: boolean;
  owner?: WorkspaceOwnerBinding;
}

/** One read of the device's workspaces. */
export interface OrgProjectAutoConversionWorkspaces {
  /** The workspaces the sidebar could project. */
  items: OrgProjectAutoConversionWorkspace[];
  /**
   * Every workspace id in the workspace index, including ones the sidebar
   * could not project this time; `null` when the index read was not
   * authoritative. A pass starts only from an authoritative index, so a
   * transient read failure never leaves a project out of it for good.
   */
  indexedIds: readonly string[] | null;
}

export interface OrgProjectAutoConversionDeps {
  /** The organization-projects rollout flag. */
  enabled(): boolean;
  access(): Promise<{
    accountId: string | null;
    capabilities: readonly string[];
    /** Every organization the member belongs to. */
    organizationIds: readonly string[];
    excludedOrganizationIds?: readonly string[];
  }>;
  /** The cached catalog for one organization, loaded or fetched if absent. */
  loadCatalog(
    organizationId: string,
  ): Promise<DesktopOrgProjectCatalogSnapshot>;
  readWorkspaces(): Promise<OrgProjectAutoConversionWorkspaces>;
  readOwnership(workspaceId: string): Promise<WorkspaceOwnershipRead>;
  /** The checkout's `origin`; `null` without one, throws when unknowable. */
  readRemoteUrl(repoPath: string): Promise<string | null>;
  convert(
    request: OrgProjectConvertWorkspaceRequest,
    options: OrgProjectConversionOptions,
  ): Promise<OrgProjectConversionResult>;
  convertMultiRepo(
    request: OrgProjectConvertMultiRepoWorkspaceRequest,
    options: OrgProjectConversionOptions,
  ): Promise<OrgProjectConversionResult>;
  record(event: OrgProjectAutoConversionEvent): void;
  /** A run failed outside any one workspace's decision. */
  reportFailure(error: unknown): void;
  /** The device-local ledger of one-time passes, one per organization. */
  passes: OrgProjectMigrationPassStore;
  recordPass(event: OrgProjectMigrationPassEvent): void;
  now(): number;
}

export interface OrgProjectAutoConversion {
  /** Schedule the first run; later runs follow {@link trigger}. */
  start(): void;
  /** Debounced request for a run. Does nothing while the flag is off. */
  trigger(): void;
  /** Run now, or join the run in progress. Resolves when it settles. */
  runNow(): Promise<void>;
  /** Await a creation-time decision without using the migration ledger. Never rejects. */
  convertNow(
    workspaceId: string,
  ): Promise<OrgProjectAutoConversionEvent | null>;
  dispose(): void;
}

interface Catalog {
  organizationId: string;
  /** `null` while the catalog has never been fetched. */
  projects: OrgProjectSummary[] | null;
  /** An incomplete catalog cannot prove that a checkout is unheld. */
  complete: boolean;
}

/** What handing one workspace to the coordinator came to. */
type ConversionOutcome = (
  | { kind: 'converted'; projectId: string }
  /** Refused for now, or still waiting out its backoff: retried later. */
  | { kind: 'retry' }
  /** Refused for this session. */
  | { kind: 'refused' }
) & { event?: OrgProjectAutoConversionEvent };

/** The open passes one run works for. */
interface MigrationRun {
  /** Each open organization's eligible workspaces. */
  eligible: ReadonlyMap<string, ReadonlySet<string>>;
  /** Open organizations with an eligible workspace still to retry. */
  pending: Set<string>;
}

/** Workspaces a pass could ever move: unowned single- and multi-repo projects. */
export function isMovablePersonalProject(
  workspace: OrgProjectAutoConversionWorkspace,
): boolean {
  return (
    workspace.owner === undefined &&
    (workspace.repoPath !== null || workspace.repoPaths !== undefined)
  );
}

/** Whether an open pass of `organizationId` may move `workspaceId`. */
function inPass(
  run: MigrationRun,
  workspaceId: string,
  organizationId: string,
): boolean {
  return run.eligible.get(organizationId)?.has(workspaceId) ?? false;
}

/** The open organizations whose pass lists the workspace. */
function passesListing(run: MigrationRun, workspaceId: string): string[] {
  return Array.from(run.eligible.keys()).filter((organizationId) =>
    inPass(run, workspaceId, organizationId),
  );
}

/**
 * Keep passes open for a workspace that may still convert: into
 * `organizationId` when the target is known, otherwise into any open
 * organization whose pass lists it.
 */
function keepOpen(
  run: MigrationRun,
  workspaceId: string,
  organizationId?: string,
): void {
  const organizations =
    organizationId === undefined
      ? passesListing(run, workspaceId)
      : [organizationId].filter((id) => inPass(run, workspaceId, id));
  for (const id of organizations) run.pending.add(id);
}

/** Projects a conversion could bind to: what `convertWorkspace` accepts. */
function convertible(project: OrgProjectSummary): boolean {
  return (
    project.state === 'ACTIVE' &&
    project.capabilities.use &&
    !project.memberOwned &&
    project.kind === 'CODE' &&
    project.location === 'LOCAL' &&
    project.topology !== 'multi-repo' &&
    project.repository !== null
  );
}

/**
 * Projects a Personal workspace could move into: a single-repo checkout
 * binds to a `convertible` project, and a multi-repo project's repositories
 * are held by `holdsOrganizationRepository` projects (CAN-3532), which may be
 * members' own organization-visible ones. The run decides whether to look at
 * checkouts, and a pass whether its catalog can settle it, by this one rule.
 */
function couldReceive(project: OrgProjectSummary): boolean {
  return convertible(project) || holdsOrganizationRepository(project);
}

/**
 * One organization's catalog, or `null` when it has never been fetched. A
 * refused context (`access-changed`) has no projects for this member; a stale
 * catalog that failed to refresh still says which projects exist.
 */
function organizationCatalog(
  snapshot: DesktopOrgProjectCatalogSnapshot,
  organizationId: string,
): OrgProjectSummary[] | null {
  if (snapshot.error === 'access-changed') return [];
  if (snapshot.error !== null && snapshot.revision === '') return null;
  return snapshot.projects.filter(
    (project): boolean =>
      project.organizationId?.toLowerCase() === organizationId,
  );
}

export function createOrgProjectAutoConversion(
  deps: OrgProjectAutoConversionDeps,
): OrgProjectAutoConversion {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let pending = false;
  let disposed = false;
  /** `${workspaceId}:${organizationId}:${projectId}` that cannot succeed. */
  const permanent = new Set<string>();
  const backoff = new Map<string, { failures: number; retryAt: number }>();
  /** Skip diagnostics already written this session. */
  const recorded = new Set<string>();
  /** Session memory belongs to one account; another starts it afresh. */
  let accountId: string | null = null;
  /** An unreadable pass ledger is reported once per session. */
  let ledgerReported = false;
  /** Organization ids already reported as ones the ledger cannot hold. */
  const unsupportedReported = new Set<string>();
  /** Pass-start write failures already reported, by message. */
  const startFailuresReported = new Set<string>();

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function schedule(delayMs: number): void {
    if (disposed || !deps.enabled()) {
      clearTimer();
      return;
    }
    if (running) {
      // The run in progress re-triggers once it settles.
      pending = true;
      return;
    }
    clearTimer();
    timer = setTimeout((): void => {
      timer = null;
      void runNow();
    }, delayMs);
    timer.unref?.();
  }

  function reportFailure(error: unknown): void {
    try {
      deps.reportFailure(error);
    } catch {
      // Diagnostic sinks cannot fail a decision or poison the queue.
    }
  }

  function record(event: OrgProjectAutoConversionEvent): void {
    try {
      deps.record(event);
    } catch (error) {
      reportFailure(error);
    }
  }

  function skip(
    event: Extract<OrgProjectAutoConversionEvent, { outcome: 'skipped' }>,
  ): OrgProjectAutoConversionEvent {
    const key = JSON.stringify([
      event.workspaceId,
      event.reason,
      event.organizationId ?? null,
      event.projectId ?? null,
      event.organizationCount ?? null,
    ]);
    if (!recorded.has(key)) {
      recorded.add(key);
      record(event);
    }
    return event;
  }

  /**
   * Hand one conversion to the coordinator. `projectId` is the project a
   * single-repo checkout matched; a multi-repo project learns its own from
   * the conversion.
   */
  async function convertOne(
    workspace: OrgProjectAutoConversionWorkspace,
    organizationId: string,
    projectId: string | undefined,
    run: () => Promise<OrgProjectConversionResult>,
    inline = false,
  ): Promise<ConversionOutcome> {
    const key = `${workspace.id}:${organizationId}:${projectId ?? 'multi-repo'}`;
    if (permanent.has(key)) return { kind: 'refused' };
    const wait = backoff.get(key);
    if (wait && deps.now() < wait.retryAt) return { kind: 'retry' };
    let result: OrgProjectConversionResult;
    try {
      const fresh = await deps.access();
      if (disposed || !deps.enabled()) return { kind: 'refused' };
      if (
        fresh.accountId !== accountId ||
        fresh.excludedOrganizationIds?.some(
          (id) => id.toLowerCase() === organizationId,
        )
      ) {
        const event = skip({
          outcome: 'skipped',
          workspaceId: workspace.id,
          organizationId,
          reason: 'outside-migration-pass',
        });
        return { kind: 'refused', event };
      }
      // Scans retain the coordinator's refusal/backoff/completion behavior.
      // Inline decisions can stop before admission when their access changed.
      if (
        inline &&
        (!fresh.capabilities.includes(ORG_PROJECTS_CAPABILITY_V1) ||
          !memberOrganizationIds(fresh).includes(organizationId))
      )
        return { kind: 'refused' };
      result = await run();
    } catch (error) {
      reportFailure(error);
      result = { ok: false, code: 'conversion-failed' };
    }
    if (result.ok) {
      backoff.delete(key);
      const boundTo = projectId ?? result.owner.projectId;
      const event: OrgProjectAutoConversionEvent = {
        outcome: 'converted',
        workspaceId: workspace.id,
        organizationId,
        projectId: boundTo,
      };
      record(event);
      return { kind: 'converted', projectId: boundTo, event };
    }
    const never = PERMANENT_REFUSALS.has(result.code);
    if (never) {
      permanent.add(key);
      backoff.delete(key);
    } else {
      const failures = (wait?.failures ?? 0) + 1;
      backoff.set(key, {
        failures,
        retryAt:
          deps.now() +
          Math.min(
            ORG_PROJECT_AUTO_CONVERSION_RETRY_BASE_MS * 2 ** (failures - 1),
            ORG_PROJECT_AUTO_CONVERSION_RETRY_MAX_MS,
          ),
      });
    }
    const event: OrgProjectAutoConversionEvent = {
      outcome: 'failed',
      workspaceId: workspace.id,
      organizationId,
      ...(projectId === undefined ? {} : { projectId }),
      reason: result.code,
      retry: never ? 'never-this-session' : 'later',
    };
    record(event);
    return { kind: never ? 'refused' : 'retry', event };
  }

  /** A moved-back or earlier conversion keeps a workspace Personal for good. */
  function skipTransferred(
    workspaceId: string,
    ownership: Extract<WorkspaceOwnershipRead, { authority: 'ok' }>,
  ): OrgProjectAutoConversionEvent | null {
    if (ownership.ownershipTransfer === undefined) return null;
    return skip({
      outcome: 'skipped',
      workspaceId,
      reason:
        ownership.ownershipTransfer.movedBackAt === undefined
          ? 'previously-converted'
          : 'moved-back',
    });
  }

  /**
   * Exactly one organization across all held checkouts selects the owner.
   * Missing catalogs and operational remote failures never establish eligibility.
   */
  async function considerMultiRepo(
    workspace: OrgProjectAutoConversionWorkspace,
    repoPaths: readonly string[],
    catalogs: readonly Catalog[],
    migration: MigrationRun | null,
  ): Promise<OrgProjectAutoConversionEvent | null> {
    if (workspace.retired === true) return null;
    const ownership = await deps.readOwnership(workspace.id);
    // An unreadable config is undecided, not Personal: keep its pass open.
    if (migration && ownership.authority === 'unreadable')
      keepOpen(migration, workspace.id);
    if (
      ownership.authority !== 'ok' ||
      ownership.type !== 'multi-repo' ||
      ownership.owner !== undefined
    )
      return null;
    const transferred = skipTransferred(workspace.id, ownership);
    if (transferred) return transferred;
    // Nothing in it could belong to an organization.
    if (repoPaths.length === 0) return null;
    /** For each repository, the organizations one of whose projects holds it. */
    const holders: Array<Set<string>> = [];
    let unknown = false;
    for (const repoPath of repoPaths) {
      let remoteUrl: string | null;
      try {
        remoteUrl = await deps.readRemoteUrl(repoPath);
      } catch {
        const event = skip({
          outcome: 'skipped',
          workspaceId: workspace.id,
          reason: 'repository-unavailable',
        });
        if (migration) keepOpen(migration, workspace.id);
        return event;
      }
      if (remoteUrl === null) continue;
      const match = matchOrganizationRepository(
        catalogs,
        remoteUrl,
        holdsOrganizationRepository,
      );
      if (match.unknown || catalogs.some(({ complete }) => !complete))
        unknown = true;
      holders.push(
        new Set(match.matches.map(({ organizationId }) => organizationId)),
      );
    }
    const held = holders.filter((organizations) => organizations.size > 0);
    // A Personal project of Personal repositories: nothing to say.
    if (held.length === 0) return null;
    // An organization whose catalog is not known could hold the rest, or
    // hold them all too.
    if (unknown) {
      const event = skip({
        outcome: 'skipped',
        workspaceId: workspace.id,
        reason: 'catalog-unavailable',
      });
      if (migration) keepOpen(migration, workspace.id);
      return event;
    }
    const organizations = new Set(held.flatMap((holder) => Array.from(holder)));
    const [first, ...rest] = held;
    const common = Array.from(first ?? []).filter((organizationId) =>
      rest.every((holder) => holder.has(organizationId)),
    );
    if (organizations.size > 1) {
      const event = skip({
        outcome: 'skipped',
        workspaceId: workspace.id,
        reason:
          common.length > 0
            ? 'ambiguous-organizations'
            : 'repositories-span-organizations',
        organizationCount: organizations.size,
      });
      return event;
    }
    const [organizationId] = Array.from(organizations);
    if (organizationId === undefined) return null;
    if (migration && !inPass(migration, workspace.id, organizationId)) {
      const event = skip({
        outcome: 'skipped',
        workspaceId: workspace.id,
        reason: 'outside-migration-pass',
        organizationId,
      });
      return event;
    }
    const outcome = await convertOne(
      workspace,
      organizationId,
      undefined,
      () =>
        deps.convertMultiRepo(
          { workspaceId: workspace.id, organizationId },
          { automatic: true },
        ),
      migration === null,
    );
    if (migration && outcome.kind === 'retry')
      keepOpen(migration, workspace.id, organizationId);
    return outcome.event ?? null;
  }

  /**
   * Each member organization's pass, starting the ones seen for the first
   * time. `null` when a pass could not be persisted: nothing may convert
   * before its start is on disk.
   */
  async function startPasses(
    ledger: Readonly<Record<string, OrgProjectMigrationPass>>,
    organizationIds: readonly string[],
    workspaces: OrgProjectAutoConversionWorkspaces,
  ): Promise<Map<string, OrgProjectMigrationPass> | null> {
    let known = ledger;
    // Without an authoritative index a pass would leave out a project it
    // cannot see now, for good: wait for a run that can read it in full.
    const indexedIds = workspaces.indexedIds;
    // Organization ids are server UUIDs; one the ledger cannot hold gets no
    // pass and converts nothing, and is reported once a session.
    for (const organizationId of organizationIds)
      if (
        !isMigrationPassOrganizationId(organizationId) &&
        !unsupportedReported.has(organizationId)
      ) {
        unsupportedReported.add(organizationId);
        deps.reportFailure(
          new Error('migration-pass-organization-id-unsupported'),
        );
      }
    const starting =
      indexedIds === null
        ? []
        : organizationIds.filter(
            (organizationId): boolean =>
              known[organizationId] === undefined &&
              isMigrationPassOrganizationId(organizationId),
          );
    if (indexedIds !== null && starting.length > 0) {
      const projected = new Map(
        workspaces.items.map((workspace): [string, boolean] => [
          workspace.id,
          isMovablePersonalProject(workspace),
        ]),
      );
      const pass: OrgProjectMigrationPass = {
        startedAt: new Date(deps.now()).toISOString(),
        // Every indexed workspace that could move; one the sidebar cannot
        // read yet is included and decided once it can be.
        // An id the ledger cannot hold (a legacy index entry) is left out
        // rather than failing every pass start.
        eligibleWorkspaceIds: indexedIds.filter(
          (id): boolean =>
            isMigrationPassWorkspaceId(id) && (projected.get(id) ?? true),
        ),
      };
      try {
        await deps.passes.update((current) => ({
          ...current,
          organizations: {
            ...Object.fromEntries(
              starting.map(
                (organizationId): [string, OrgProjectMigrationPass] => [
                  organizationId,
                  pass,
                ],
              ),
            ),
            // A pass already on disk is never restarted.
            ...current.organizations,
          },
        }));
      } catch (error) {
        // Retried on every trigger; the same failure is reported once a
        // session (an over-sized pass, for one, cannot succeed later).
        const message = error instanceof Error ? error.message : String(error);
        if (!startFailuresReported.has(message)) {
          startFailuresReported.add(message);
          deps.reportFailure(error);
        }
        return null;
      }
      // Work from what was persisted, as the store normalized it.
      const persisted = await deps.passes.read();
      if (persisted.status === 'unreadable') {
        deps.reportFailure(new Error(ORG_PROJECT_MIGRATION_PASSES_UNREADABLE));
        return null;
      }
      known = persisted.file.organizations;
      for (const organizationId of starting) {
        const started = known[organizationId];
        if (started === undefined) continue;
        deps.recordPass({
          outcome: 'started',
          organizationId,
          workspaceCount: started.eligibleWorkspaceIds.length,
        });
      }
    }
    const passes = new Map<string, OrgProjectMigrationPass>();
    for (const organizationId of organizationIds) {
      const pass = known[organizationId];
      // Not persisted (an id the ledger cannot hold): it cannot convert.
      if (pass === undefined) continue;
      passes.set(organizationId, pass);
    }
    return passes;
  }

  /**
   * Complete every open pass with nothing left to retry and a current
   * catalog, and every pass past its time cap.
   */
  async function completePasses(
    passes: ReadonlyMap<string, OrgProjectMigrationPass>,
    migration: MigrationRun,
    current: ReadonlySet<string>,
  ): Promise<void> {
    const now = deps.now();
    const completing: Array<{
      organizationId: string;
      completion: 'settled' | 'expired';
    }> = [];
    for (const organizationId of Array.from(migration.eligible.keys())) {
      const pass = passes.get(organizationId);
      if (pass === undefined) continue;
      if (current.has(organizationId) && !migration.pending.has(organizationId))
        completing.push({ organizationId, completion: 'settled' });
      else if (
        now - Date.parse(pass.startedAt) >=
        ORG_PROJECT_MIGRATION_PASS_MAX_MS
      )
        completing.push({ organizationId, completion: 'expired' });
    }
    if (completing.length === 0) return;
    const completedAt = new Date(now).toISOString();
    await deps.passes.update((file) => ({
      ...file,
      organizations: {
        ...file.organizations,
        ...Object.fromEntries(
          completing.flatMap(
            ({ organizationId }): Array<[string, OrgProjectMigrationPass]> => {
              const pass = file.organizations[organizationId];
              return pass === undefined
                ? []
                : [[organizationId, { ...pass, completedAt }]];
            },
          ),
        ),
      },
    }));
    for (const event of completing)
      deps.recordPass({ outcome: 'completed', ...event });
  }

  /**
   * Convert the eligible workspaces of the open passes. `false` when the run
   * was cut short (flag off or disposed), so no pass may complete.
   */
  async function convertEligible(
    workspaces: readonly OrgProjectAutoConversionWorkspace[],
    catalogs: readonly Catalog[],
    migration: MigrationRun,
  ): Promise<boolean> {
    const boundProjects = new Set(
      workspaces.flatMap((workspace): string[] =>
        workspace.owner
          ? [`${workspace.owner.organizationId}:${workspace.owner.projectId}`]
          : [],
      ),
    );
    for (const workspace of workspaces) {
      if (!deps.enabled() || disposed) return false;
      if (workspace.owner !== undefined) continue;
      // Created after every open pass started: never moved automatically.
      if (passesListing(migration, workspace.id).length === 0) continue;
      if (workspace.repoPaths !== undefined) {
        await considerMultiRepo(
          workspace,
          workspace.repoPaths,
          catalogs,
          migration,
        );
        continue;
      }
      if (workspace.repoPath === null) continue;
      const ownership = await deps.readOwnership(workspace.id);
      // An unreadable config is undecided, not Personal: keep its pass open.
      if (ownership.authority === 'unreadable')
        keepOpen(migration, workspace.id);
      if (
        ownership.authority !== 'ok' ||
        ownership.type !== 'single-repo' ||
        ownership.owner !== undefined
      )
        continue;
      if (skipTransferred(workspace.id, ownership)) continue;
      let remoteUrl: string | null;
      try {
        remoteUrl = await deps.readRemoteUrl(workspace.repoPath);
      } catch {
        skip({
          outcome: 'skipped',
          workspaceId: workspace.id,
          reason: 'repository-unavailable',
        });
        keepOpen(migration, workspace.id);
        continue;
      }
      if (remoteUrl === null) continue;
      // The same decision the "same repository" relationship and the
      // coordinator make: `computeRelationships` (through
      // `matchOrganizationRepository`) over each organization's
      // whole catalog, so verified identities resolve renamed aliases.
      const { matches, unknown } = matchOrganizationRepository(
        catalogs,
        remoteUrl,
        convertible,
      );
      if (matches.length === 0) continue;
      const organizations = new Set(
        matches.map((match): string => match.organizationId),
      );
      if (organizations.size > 1) {
        skip({
          outcome: 'skipped',
          workspaceId: workspace.id,
          reason: 'ambiguous-organizations',
          organizationCount: organizations.size,
        });
        continue;
      }
      const [match] = matches;
      if (matches.length > 1 || !match) {
        skip({
          outcome: 'skipped',
          workspaceId: workspace.id,
          reason: 'ambiguous-projects',
          organizationId: matches[0]?.organizationId,
        });
        continue;
      }
      // Ambiguity cannot be ruled out while an organization is unknown.
      if (unknown) {
        skip({
          outcome: 'skipped',
          workspaceId: workspace.id,
          reason: 'catalog-unavailable',
          organizationId: match.organizationId,
          projectId: match.project.id,
        });
        keepOpen(migration, workspace.id);
        continue;
      }
      if (!inPass(migration, workspace.id, match.organizationId)) {
        skip({
          outcome: 'skipped',
          workspaceId: workspace.id,
          reason: 'outside-migration-pass',
          organizationId: match.organizationId,
        });
        continue;
      }
      if (
        boundProjects.has(`${match.organizationId}:${match.project.id}`) ||
        match.project.instance?.state === 'READY'
      ) {
        skip({
          outcome: 'skipped',
          workspaceId: workspace.id,
          reason: 'project-already-bound',
          organizationId: match.organizationId,
          projectId: match.project.id,
        });
        continue;
      }
      const outcome = await convertOne(
        workspace,
        match.organizationId,
        match.project.id,
        () =>
          deps.convert(
            {
              workspaceId: workspace.id,
              organizationId: match.organizationId,
              projectId: match.project.id,
            },
            { automatic: true },
          ),
      );
      if (outcome.kind === 'converted')
        boundProjects.add(`${match.organizationId}:${outcome.projectId}`);
      else if (outcome.kind === 'retry')
        keepOpen(migration, workspace.id, match.organizationId);
    }
    return true;
  }

  type Access = Awaited<ReturnType<OrgProjectAutoConversionDeps['access']>>;

  function memberOrganizationIds(access: Access): string[] {
    const excluded = new Set(
      access.excludedOrganizationIds?.map((id) => id.toLowerCase()) ?? [],
    );
    return Array.from(
      new Set(access.organizationIds.map((id) => id.toLowerCase())),
    ).filter((id) => !excluded.has(id));
  }

  function synchronizeAccount(access: Access): void {
    if (access.accountId !== accountId) {
      accountId = access.accountId;
      permanent.clear();
      backoff.clear();
      recorded.clear();
      ledgerReported = false;
      unsupportedReported.clear();
      startFailuresReported.clear();
    }
  }

  async function execute(): Promise<void> {
    if (!deps.enabled()) return;
    const access = await deps.access();
    if (
      !access.accountId ||
      !access.capabilities.includes(ORG_PROJECTS_CAPABILITY_V1) ||
      access.organizationIds.length === 0
    )
      return;
    synchronizeAccount(access);
    // A corrupt ledger would restart every pass and move projects created
    // since: convert nothing, and write nothing, until it reads again.
    const ledger = await deps.passes.read();
    if (ledger.status === 'unreadable') {
      if (!ledgerReported) {
        ledgerReported = true;
        deps.reportFailure(new Error(ORG_PROJECT_MIGRATION_PASSES_UNREADABLE));
      }
      return;
    }
    const excluded = new Set(
      access.excludedOrganizationIds?.map((id) => id.toLowerCase()) ?? [],
    );
    if (excluded.size > 0) {
      await deps.passes.update((file) => {
        const organizations = { ...file.organizations };
        for (const id of Array.from(excluded)) {
          if (!isMigrationPassOrganizationId(id)) continue;
          const existing = organizations[id];
          organizations[id] = {
            ...existing,
            startedAt:
              existing?.startedAt ?? new Date(deps.now()).toISOString(),
            eligibleWorkspaceIds: existing?.eligibleWorkspaceIds ?? [],
            completedAt:
              existing?.completedAt ?? new Date(deps.now()).toISOString(),
          };
        }
        return { ...file, organizations };
      });
    }
    const organizationIds = memberOrganizationIds(access);
    // Once every member organization's pass is over, a run reads nothing else.
    if (
      organizationIds.every(
        (organizationId): boolean =>
          ledger.file.organizations[organizationId]?.completedAt !==
            undefined || !isMigrationPassOrganizationId(organizationId),
      )
    )
      return;
    const read = await deps.readWorkspaces();
    const workspaces = read.items;
    const passes = await startPasses(
      ledger.file.organizations,
      organizationIds,
      read,
    );
    if (passes === null) return;
    const migration: MigrationRun = {
      eligible: new Map(
        Array.from(passes)
          .filter(([, pass]): boolean => pass.completedAt === undefined)
          .map(([organizationId, pass]): [string, ReadonlySet<string>] => [
            organizationId,
            new Set(pass.eligibleWorkspaceIds),
          ]),
      ),
      pending: new Set(),
    };
    if (migration.eligible.size === 0) return;
    // An eligible workspace still indexed (or not known to be gone) that the
    // sidebar cannot read now keeps its pass open until it can be decided.
    const projectedIds = new Set(
      workspaces.map((workspace): string => workspace.id),
    );
    const indexed = read.indexedIds === null ? null : new Set(read.indexedIds);
    migration.eligible.forEach((eligible, organizationId): void => {
      if (
        Array.from(eligible).some(
          (id): boolean =>
            !projectedIds.has(id) && (indexed === null || indexed.has(id)),
        )
      )
        migration.pending.add(organizationId);
    });
    const catalogs: Catalog[] = [];
    /**
     * Organizations whose pass this run's catalog can settle: fetched
     * successfully since the pass started (a catalog cached from before
     * could predate the member's repositories), and listing a project a
     * checkout could become, so a member who joins before the admin adds
     * projects keeps the pass open (until its time cap) instead of losing it.
     */
    const current = new Set<string>();
    for (const organizationId of organizationIds) {
      const snapshot = await deps.loadCatalog(organizationId);
      // The server stopped offering organization projects: nothing converts.
      if (snapshot.error === 'unavailable') return;
      const projects = organizationCatalog(snapshot, organizationId);
      catalogs.push({
        organizationId,
        projects,
        complete:
          snapshot.error === 'access-changed' ||
          (!snapshot.stale && snapshot.error === null),
      });
      const startedAt = passes.get(organizationId)?.startedAt;
      if (
        projects !== null &&
        !snapshot.stale &&
        snapshot.error === null &&
        startedAt !== undefined &&
        Date.parse(snapshot.fetchedAt) >= Date.parse(startedAt) &&
        projects.some(couldReceive)
      )
        current.add(organizationId);
    }
    // Reading every checkout's remote is the expensive part; skip it when no
    // organization has anything a checkout could become.
    if (
      catalogs.some(
        ({ projects }): boolean => projects?.some(couldReceive) ?? false,
      ) &&
      !(await convertEligible(workspaces, catalogs, migration))
    )
      return;
    if (!deps.enabled() || disposed) return;
    await completePasses(passes, migration, current);
  }

  /** Reserve the queue before invoking work, including synchronous failures. */
  function serialize<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    const previous = running ?? Promise.resolve();
    const result = previous.then(async (): Promise<T> => {
      if (disposed) return fallback;
      try {
        return await work();
      } catch (error) {
        reportFailure(error);
        return fallback;
      }
    });
    const run = result.then((): void => {
      // A later inline caller already owns the tail and its release.
      if (running !== run) return;
      running = null;
      if (pending) {
        pending = false;
        try {
          schedule(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
        } catch (error) {
          reportFailure(error);
        }
      }
    });
    running = run;
    // Release happens before the caller observes settlement.
    return run.then((): Promise<T> => result);
  }

  function runNow(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (running) {
      pending = true;
      return running;
    }
    return serialize(execute, undefined);
  }

  function convertNow(
    workspaceId: string,
  ): Promise<OrgProjectAutoConversionEvent | null> {
    return serialize(
      async (): Promise<OrgProjectAutoConversionEvent | null> => {
        if (!deps.enabled()) return null;
        const access = await deps.access();
        if (
          !access.accountId ||
          !access.capabilities.includes(ORG_PROJECTS_CAPABILITY_V1) ||
          access.organizationIds.length === 0
        )
          return null;
        synchronizeAccount(access);
        const catalogs: Catalog[] = [];
        for (const organizationId of memberOrganizationIds(access)) {
          const snapshot = await deps.loadCatalog(organizationId);
          if (snapshot.error === 'unavailable') return null;
          catalogs.push({
            organizationId,
            projects: organizationCatalog(snapshot, organizationId),
            complete:
              snapshot.error === 'access-changed' ||
              (!snapshot.stale && snapshot.error === null),
          });
        }
        if (
          !catalogs.some(
            ({ projects }) => projects?.some(couldReceive) ?? false,
          )
        )
          return null;
        const workspace = (await deps.readWorkspaces()).items.find(
          (candidate) => candidate.id === workspaceId,
        );
        if (
          disposed ||
          !deps.enabled() ||
          !workspace ||
          workspace.owner !== undefined ||
          workspace.temporary !== true ||
          workspace.repoPaths === undefined ||
          workspace.retired === true
        )
          return null;
        return considerMultiRepo(
          workspace,
          workspace.repoPaths,
          catalogs,
          null,
        );
      },
      null,
    );
  }

  return {
    start(): void {
      schedule(ORG_PROJECT_AUTO_CONVERSION_STARTUP_DELAY_MS);
    },
    trigger(): void {
      schedule(ORG_PROJECT_AUTO_CONVERSION_DEBOUNCE_MS);
    },
    runNow,
    convertNow,
    dispose(): void {
      disposed = true;
      pending = false;
      clearTimer();
    },
  };
}
