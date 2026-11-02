import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  IPC_CHANNELS,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { isMissingFileError } from './fs-utils';
import { logMainProcessError } from './main-process-logging';
import { getPlanExplorePlanFilePath, getPlanExploreScopeDir } from './paths';
import { getPlanExploreTargetSync } from './plan-explore-registry';
import { getTrackedPlan, updateTrackedPlan } from './plan-persistence';
import { hasTrackedPlanStorage } from './tracked-plan-scope';
import { sendToWindow, type SendableBrowserWindow } from './window-send';

/** The real worktree scope that owns tracked plans and their plan files. */
export interface PlanFileScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

/** One tracked plan's materialized file, identified by its owning scope. */
export interface PlanFileRef extends PlanFileScope {
  readonly planId: string;
}

export type PlanFileWindowGetter = () => SendableBrowserWindow | null;

export interface MaterializePlanFileOptions {
  /**
   * Apply an edited working copy as a new plan revision before returning, when
   * no turn is running in the plan's scope. `false` never creates a revision.
   */
  readonly flush: boolean;
}

export interface MaterializedPlanFile {
  readonly filePath: string;
  readonly title: string;
  readonly latestRevisionNumber: number;
}

/** A running chat turn's exposure of its scope's plan files. */
export interface PlanTurnLease {
  /** End the turn. Idempotent; a no-op once a newer turn with the same key began. */
  end(): void;
}

/** Debounce window before a detected file change is synced back into content. */
const REFRESH_DEBOUNCE_MS = 1500;
/** Slow background poll cadence while at least one plan file is visible. */
const VISIBILITY_POLL_INTERVAL_MS = 25_000;
/** Plan ids are path segments; mirrors `validateId`. */
const PLAN_ID_SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;

const NOOP_LEASE: PlanTurnLease = { end: () => undefined };

/** An edit left in the working copy because a turn runs in its scope. */
const PARKED = Symbol('parked');

interface PlanFileState {
  readonly ref: PlanFileRef;
  readonly scopeKey: string;
  /**
   * Hash of the content last known to be in sync between `plan.md` and the
   * tracked plan (written or applied here). Null until known, e.g. after a
   * restart.
   */
  baselineHash: string | null;
  /** Pending debounced refresh, if any. */
  debounce: ReturnType<typeof setTimeout> | null;
  /** Visibility owners (`${sender.id}:${consumerId}`) currently showing the plan. */
  readonly visibilityOwners: Set<string>;
}

interface TurnLeaseRecord {
  readonly turnKey: string;
  readonly scope: PlanFileScope;
  readonly scopeKey: string;
  live: boolean;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function planFileKey(ref: PlanFileRef): string {
  return JSON.stringify([ref.projectId, ref.worktreeId, ref.planId]);
}

function planScopeKey(scope: PlanFileScope): string {
  return JSON.stringify([scope.projectId, scope.worktreeId]);
}

/** Lease key for one chat's turns, in the chat's own (possibly sentinel) scope. */
export function planChatTurnKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return JSON.stringify([projectId, worktreeId, chatId]);
}

/**
 * Real scope whose plan files a chat turn exposes: the chat's own worktree,
 * or for the plan-explore sentinel (`worktreeId` = plan id) the registered
 * target worktree, read synchronously through the legacy sentinel adapter.
 * Null for scopes without tracked plans (Cowork, assistant and app-managed
 * sentinels, the shared-container viewer) and unregistered takeovers.
 */
export function resolvePlanTurnScope(
  projectId: string,
  worktreeId: string,
): PlanFileScope | null {
  if (projectId === PLAN_EXPLORE_CHAT_PROJECT_ID) {
    const target = getPlanExploreTargetSync(worktreeId);
    if (!target || !hasTrackedPlanStorage(target.projectId)) {
      return null;
    }
    return { projectId: target.projectId, worktreeId: target.worktreeId };
  }
  return hasTrackedPlanStorage(projectId) ? { projectId, worktreeId } : null;
}

/** The plan file path, or null for scopes without plans and invalid ids. */
function resolvePlanFilePath(ref: PlanFileRef): string | null {
  if (!hasTrackedPlanStorage(ref.projectId)) {
    return null;
  }
  try {
    return getPlanExplorePlanFilePath(
      ref.projectId,
      ref.worktreeId,
      ref.planId,
    );
  } catch {
    return null;
  }
}

/**
 * A plan file that exists but could not be read (permissions, I/O). Its bytes
 * are unknown, so nothing may overwrite it or turn it into a revision.
 */
class PlanFileReadError extends Error {
  // `declare`: only some programs' libs (via type-fest) give Error a `cause`.
  declare readonly cause: unknown;

  constructor(filePath: string, cause: unknown) {
    super(`Could not read the plan file at ${filePath}`);
    this.name = 'PlanFileReadError';
    this.cause = cause;
  }
}

/**
 * The working copy's text, or null when it does not exist yet (`ENOENT`).
 * Every other read failure throws {@link PlanFileReadError}.
 */
async function readPlanFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw new PlanFileReadError(filePath, error);
  }
}

/** Plan ids with a directory under the scope's plan-file root. */
async function listScopePlanIds(scope: PlanFileScope): Promise<string[]> {
  let scopeDir: string;
  try {
    scopeDir = getPlanExploreScopeDir(scope.projectId, scope.worktreeId);
  } catch {
    return [];
  }
  try {
    const names = await readdir(scopeDir);
    return names.filter((name) => PLAN_ID_SEGMENT_RE.test(name));
  } catch {
    return [];
  }
}

/**
 * Whether `fileText` is an edit that has not reached the tracked plan yet.
 * A file equal to the latest content is in sync; with a known baseline, any
 * other difference from what was last written or applied is an edit. After a
 * restart the baseline is unknown, so a file equal to a stored revision is a
 * stale working copy rather than an edit (an unapplied revert to an older
 * revision's exact bytes is therefore treated as stale).
 */
function isEditedWorkingCopy(
  baselineHash: string | null,
  plan: TrackedPlanData,
  fileText: string | null,
): fileText is string {
  if (fileText === null || fileText === plan.content) {
    return false;
  }
  if (baselineHash !== null) {
    return hash(fileText) !== baselineHash;
  }
  return !plan.revisions.some((revision) => revision.content === fileText);
}

function describePlanFile(
  filePath: string,
  plan: TrackedPlanData,
): MaterializedPlanFile {
  return {
    filePath,
    title: plan.title,
    latestRevisionNumber: plan.latestRevisionNumber,
  };
}

/**
 * Keeps each tracked plan's materialized `plan.md` working copy
 * (`worktree-data/<worktreeId>/plan-explore/<planId>/plan.md`) and the tracked
 * plan in step, by checksum comparison (no `fs.watch`). An edited working copy
 * reaches the plan through one {@link updateTrackedPlan} (revision snapshot,
 * stale diagrams, anchor re-evaluation) with `lastEditSource: 'agent'`, and
 * the renderer hears about it through `trackedPlansUpdated`.
 *
 * Everything is keyed by the owning `(projectId, worktreeId, planId)`; no path
 * here reads the plan-explore registry (only {@link resolvePlanTurnScope}
 * maps the sentinel for callers).
 *
 * - Turn exposure is per scope: while any {@link PlanTurnLease} in a scope is
 *   live, checks and flushes for its plans park (no timer is armed), and the
 *   last lease to end checks every known plan file in the scope.
 * - Materialization and applying are serialized per plan and never overwrite
 *   an edited working copy.
 * - A working copy that exists but cannot be read (anything but `ENOENT`) is
 *   left alone: nothing is written over it and no revision is created from
 *   it. Materialization resolves null and logs; background checks and
 *   refreshes log.
 * - Visibility owners keep one shared slow poll running for the plans they
 *   show.
 *
 * Revision guarantee: a working copy becomes a revision only through
 * {@link PlanFileSyncService.applyEditUnlessTurnRunning}, which checks the
 * scope's leases and requests {@link updateTrackedPlan} in one synchronous
 * step, after the caller's last read of the file. So a revision holds only
 * bytes whose read completed while no turn in the scope was live, and an edit
 * read after a turn began stays pending until the scope's last lease ends. A
 * turn may begin while a requested update is still persisting; that revision
 * still holds only edits made before the turn began. Any materialization of
 * the plan for that turn waits behind the per-plan lock, so it sees that
 * revision as its baseline and neither rewrites the working copy nor applies
 * the edit again, and edits the turn makes stay pending until the scope's
 * last lease ends.
 *
 * Loop safety: every write or apply records the content's hash as the
 * baseline, so a later check of the same bytes is a no-op.
 */
export class PlanFileSyncService {
  private getWindow: PlanFileWindowGetter;
  private readonly states = new Map<string, PlanFileState>();
  private readonly leasesByTurn = new Map<string, TurnLeaseRecord>();
  private readonly liveLeaseCounts = new Map<string, number>();
  private readonly planLocks = new Map<string, Promise<void>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { getWindow?: PlanFileWindowGetter }) {
    this.getWindow = options?.getWindow ?? ((): null => null);
  }

  /** Supply the window that receives `trackedPlansUpdated` events. */
  configure(options: { getWindow: PlanFileWindowGetter }): void {
    this.getWindow = options.getWindow;
  }

  /**
   * Bring the plan's working copy up to date and describe it. A missing or
   * unedited file is (re)written from the latest content when its bytes
   * differ. An edited file is never overwritten: with `flush` and no turn
   * running in the scope it becomes a new revision first; otherwise it is left
   * for the scope's next check. Null when the scope has no tracked plans, the
   * plan does not exist, or the working copy exists but cannot be read (it is
   * left untouched and the failure is logged).
   */
  async materializePlanFile(
    ref: PlanFileRef,
    options: MaterializePlanFileOptions,
  ): Promise<MaterializedPlanFile | null> {
    const filePath = resolvePlanFilePath(ref);
    if (filePath === null) {
      return null;
    }
    try {
      return await this.withPlanLock(planFileKey(ref), () =>
        this.materializeLocked(ref, filePath, options.flush),
      );
    } catch (error) {
      if (error instanceof PlanFileReadError) {
        this.logFailure(error, ref);
        return null;
      }
      throw error;
    }
  }

  /**
   * Begin a turn that exposes every plan file in `scope`. A lease already live
   * under `turnKey` is superseded (reload, resume, and queue pickup restarts);
   * its `end()` becomes a no-op. Scopes without tracked plans get a no-op
   * lease.
   */
  beginTurn(turnKey: string, scope: PlanFileScope): PlanTurnLease {
    if (!hasTrackedPlanStorage(scope.projectId)) {
      return NOOP_LEASE;
    }
    const record: TurnLeaseRecord = {
      turnKey,
      scope: { projectId: scope.projectId, worktreeId: scope.worktreeId },
      scopeKey: planScopeKey(scope),
      live: true,
    };
    const superseded = this.leasesByTurn.get(turnKey);
    this.leasesByTurn.set(turnKey, record);
    this.liveLeaseCounts.set(
      record.scopeKey,
      (this.liveLeaseCounts.get(record.scopeKey) ?? 0) + 1,
    );
    if (superseded?.live) {
      // Counted after the new lease so a same-scope restart never lets the
      // scope go idle in between.
      superseded.live = false;
      this.releaseScopeLease(superseded);
    }
    return { end: (): void => this.endTurn(record) };
  }

  /** Whether any turn lease in `scope` is live. */
  isScopeActive(scope: PlanFileScope): boolean {
    return (this.liveLeaseCounts.get(planScopeKey(scope)) ?? 0) > 0;
  }

  /**
   * Mark the plan visible to `ownerId`: check it now and keep the shared slow
   * poll running while any plan is visible.
   */
  acquireVisibility(ref: PlanFileRef, ownerId: string): void {
    if (resolvePlanFilePath(ref) === null) {
      return;
    }
    this.stateFor(ref).visibilityOwners.add(ownerId);
    this.runDetached(this.checkPlanFileForChange(ref), ref);
    this.startPoll();
  }

  /** Drop `ownerId`'s visibility; the poll stops once no plan is visible. */
  releaseVisibility(ref: PlanFileRef, ownerId: string): void {
    const state = this.states.get(planFileKey(ref));
    if (!state) {
      return;
    }
    state.visibilityOwners.delete(ownerId);
    this.stopPollIfIdle();
  }

  /**
   * Read the plan file and, when it differs from the baseline, schedule a
   * debounced refresh, or park it (no timer) while a turn runs in its scope.
   * Rejects, changing nothing, when the file exists but cannot be read.
   */
  async checkPlanFileForChange(ref: PlanFileRef): Promise<void> {
    const filePath = resolvePlanFilePath(ref);
    if (filePath === null) {
      return;
    }
    const fileText = await readPlanFile(filePath);
    if (fileText === null) {
      return;
    }
    const state = this.stateFor(ref);
    if (hash(fileText) === state.baselineHash) {
      return;
    }
    if (this.isScopeActive(ref)) {
      this.clearDebounce(state);
      return;
    }
    this.scheduleRefresh(state);
  }

  /** Forget one plan file: its pending refresh, baseline, and visibility. */
  forgetPlanFile(ref: PlanFileRef): void {
    const key = planFileKey(ref);
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    this.clearDebounce(state);
    this.states.delete(key);
    this.stopPollIfIdle();
  }

  /** Forget every plan file in `scope`. Live turn leases stay with their chats. */
  forgetScope(scope: PlanFileScope): void {
    const scopeKey = planScopeKey(scope);
    for (const state of Array.from(this.states.values())) {
      if (state.scopeKey === scopeKey) {
        this.forgetPlanFile(state.ref);
      }
    }
  }

  private stateFor(ref: PlanFileRef): PlanFileState {
    const key = planFileKey(ref);
    let state = this.states.get(key);
    if (!state) {
      state = {
        ref: {
          projectId: ref.projectId,
          worktreeId: ref.worktreeId,
          planId: ref.planId,
        },
        scopeKey: planScopeKey(ref),
        baselineHash: null,
        debounce: null,
        visibilityOwners: new Set(),
      };
      this.states.set(key, state);
    }
    return state;
  }

  /** Run `operation` after every earlier operation on the same plan settles. */
  private withPlanLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.planLocks.get(key) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.planLocks.set(key, settled);
    void settled.then(() => {
      if (this.planLocks.get(key) === settled) {
        this.planLocks.delete(key);
      }
    });
    return run;
  }

  private async materializeLocked(
    ref: PlanFileRef,
    filePath: string,
    flush: boolean,
  ): Promise<MaterializedPlanFile | null> {
    const plan = await getTrackedPlan(
      ref.projectId,
      ref.worktreeId,
      ref.planId,
    );
    if (!plan) {
      return null;
    }
    const state = this.stateFor(ref);
    const fileText = await readPlanFile(filePath);
    if (isEditedWorkingCopy(state.baselineHash, plan, fileText)) {
      const applied = flush
        ? await this.applyEditUnlessTurnRunning(ref, state, fileText)
        : PARKED;
      if (applied === PARKED) {
        // The working copy keeps the edit until the scope's next check.
        return describePlanFile(filePath, plan);
      }
      return applied ? describePlanFile(filePath, applied) : null;
    }
    if (fileText !== plan.content) {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, plan.content, 'utf8');
    }
    state.baselineHash = hash(plan.content);
    this.clearDebounce(state);
    return describePlanFile(filePath, plan);
  }

  /** Debounced refresh: apply an edited working copy unless a turn runs. */
  private async refreshLocked(ref: PlanFileRef): Promise<void> {
    const state = this.states.get(planFileKey(ref));
    const filePath = resolvePlanFilePath(ref);
    if (!state || filePath === null || this.isScopeActive(ref)) {
      // Forgotten, or parked until the scope's last lease ends.
      return;
    }
    const fileText = await readPlanFile(filePath);
    if (fileText === null) {
      return;
    }
    const plan = await getTrackedPlan(
      ref.projectId,
      ref.worktreeId,
      ref.planId,
    );
    if (!plan) {
      return;
    }
    if (isEditedWorkingCopy(state.baselineHash, plan, fileText)) {
      // Parked when a turn began while the file was read: the lease's end
      // checks the scope again.
      await this.applyEditUnlessTurnRunning(ref, state, fileText);
      return;
    }
    // In sync, or a stale copy the next materialize rewrites.
    state.baselineHash = hash(fileText);
  }

  /**
   * The only path that turns a working copy into a revision. Call it only
   * after the last read of the file: the lease check and the update request
   * run in one synchronous step, so a turn that began before the read
   * completed parks the edit, and a turn that begins while the update
   * persists cannot add its own edits to it (see the class doc).
   * Returns {@link PARKED} without touching anything while a turn runs in the
   * plan's scope; otherwise the updated plan, or null when it no longer
   * exists.
   */
  private async applyEditUnlessTurnRunning(
    ref: PlanFileRef,
    state: PlanFileState,
    content: string,
  ): Promise<TrackedPlanData | null | typeof PARKED> {
    if (this.isScopeActive(ref)) {
      return PARKED;
    }
    const updated = await updateTrackedPlan({
      projectId: ref.projectId,
      worktreeId: ref.worktreeId,
      planId: ref.planId,
      content,
      lastEditSource: 'agent',
    });
    state.baselineHash = hash(content);
    this.clearDebounce(state);
    if (updated) {
      sendToWindow(this.getWindow(), IPC_CHANNELS.trackedPlansUpdated, {
        projectId: ref.projectId,
        worktreeId: ref.worktreeId,
        plan: updated,
      });
    }
    return updated;
  }

  private scheduleRefresh(state: PlanFileState): void {
    this.clearDebounce(state);
    const timer = setTimeout(() => {
      if (state.debounce === timer) {
        state.debounce = null;
      }
      this.runDetached(
        this.withPlanLock(planFileKey(state.ref), () =>
          this.refreshLocked(state.ref),
        ),
        state.ref,
      );
    }, REFRESH_DEBOUNCE_MS);
    timer.unref?.();
    state.debounce = timer;
  }

  private clearDebounce(state: PlanFileState): void {
    if (state.debounce) {
      clearTimeout(state.debounce);
      state.debounce = null;
    }
  }

  private endTurn(record: TurnLeaseRecord): void {
    if (!record.live) {
      return;
    }
    record.live = false;
    if (this.leasesByTurn.get(record.turnKey) === record) {
      this.leasesByTurn.delete(record.turnKey);
    }
    this.releaseScopeLease(record);
  }

  private releaseScopeLease(record: TurnLeaseRecord): void {
    const remaining = (this.liveLeaseCounts.get(record.scopeKey) ?? 1) - 1;
    if (remaining > 0) {
      this.liveLeaseCounts.set(record.scopeKey, remaining);
      return;
    }
    this.liveLeaseCounts.delete(record.scopeKey);
    this.runDetached(this.checkScope(record.scope), record.scope);
  }

  /**
   * Check every known plan file in `scope`: plans with in-memory state plus
   * every plan directory under the scope's plan-file root.
   */
  private async checkScope(scope: PlanFileScope): Promise<void> {
    const scopeKey = planScopeKey(scope);
    const planIds = new Set<string>();
    for (const state of Array.from(this.states.values())) {
      if (state.scopeKey === scopeKey) {
        planIds.add(state.ref.planId);
      }
    }
    for (const planId of await listScopePlanIds(scope)) {
      planIds.add(planId);
    }
    // One unreadable plan file must not hide a failure, or skip a check, of
    // another.
    await Promise.all(
      Array.from(planIds, (planId) => {
        const ref: PlanFileRef = { ...scope, planId };
        return this.checkPlanFileForChange(ref).catch((error: unknown) => {
          this.logFailure(error, ref);
        });
      }),
    );
  }

  private startPoll(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      for (const state of Array.from(this.states.values())) {
        if (state.visibilityOwners.size > 0) {
          this.runDetached(this.checkPlanFileForChange(state.ref), state.ref);
        }
      }
    }, VISIBILITY_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  private stopPollIfIdle(): void {
    const anyVisible = Array.from(this.states.values()).some(
      (state) => state.visibilityOwners.size > 0,
    );
    if (!anyVisible && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private runDetached(
    operation: Promise<unknown>,
    scope: PlanFileScope | PlanFileRef,
  ): void {
    void operation.catch((error: unknown) => {
      this.logFailure(error, scope);
    });
  }

  private logFailure(error: unknown, scope: PlanFileScope | PlanFileRef): void {
    const planId = 'planId' in scope ? ` plan ${scope.planId}` : '';
    logMainProcessError(
      `Plan file sync failed for ${scope.worktreeId}${planId}`,
      error,
    );
  }
}

let service: PlanFileSyncService | null = null;

export function getPlanFileSyncService(): PlanFileSyncService {
  if (!service) {
    service = new PlanFileSyncService();
  }
  return service;
}
