import {
  DEFAULT_APPROVAL_DEFAULTS,
  FAIL_CLOSED_APPROVAL_MODE,
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ApprovalDefaults,
  type ApprovalMode,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import { readWorkspaceApprovals } from './approvals-persistence';
import {
  peekPreferencesLoadError,
  readPreferencesFile,
} from './preferences-store';
import { isCoworkWorkspace } from './workspace-registry';
import { readWorkspaceApprovalsManifest } from './workspace-approvals-manifest';
import { resolveWorktreeTargetIds } from './resolve-worktree';
import { markApprovalDefaultsChanged } from '../approvals/rule-revisions';

/**
 * The three chat contexts that carry independent approval-mode defaults.
 * See `ApprovalDefaults` (`worktree` | `cowork` | `appAdvisor`) for the
 * matching persisted preference shape.
 */
export type ApprovalSurface = 'worktree' | 'cowork' | 'app-advisor';

export interface ResolveApprovalModeInput {
  /** Per-tab explicit mode override, set directly by the user for one chat tab. */
  tabMode?: ApprovalMode;
  /** Hook/automation-provided mode override for the current turn. */
  hookMode?: ApprovalMode;
  /** Workspace-local `approvals.json` default mode. */
  workspaceDefault?: ApprovalMode;
  /**
   * Repo-committed `canopy.json` `approvals.defaultMode`, already
   * de-escalated at parse time (see `parseManifestApprovals` in
   * `packages/desktop-shared/src/node/lib/canopy-json.ts` — `'full-access'`
   * can never reach this field).
   */
  canopyJsonDefault?: ApprovalMode;
  surface: ApprovalSurface;
  defaults: ApprovalDefaults;
}

/**
 * The product default a fresh profile gets when a surface key is missing from
 * `approvalDefaults`. Deliberately separate from
 * {@link UNRESOLVABLE_TARGET_APPROVAL_MODE}: this one tracks the shipped
 * product posture, that one is a fail-closed fallback for a read that failed.
 * Do not collapse them back into a single constant.
 */
export const PRODUCT_DEFAULT_APPROVAL_MODE: ApprovalMode =
  DEFAULT_APPROVAL_DEFAULTS.worktree;

/**
 * Fail-closed fallback for an approval decision made on evidence we do not
 * actually have: an unresolvable target (see
 * {@link resolvePersistedApprovalMode}) or a degraded preferences read (see
 * {@link approvalDefaultsFromPreferences}). Neither is a user default, and a
 * main-owned send must never silently run unrestricted because a read failed,
 * so this stays `'ask'` regardless of what the product default is.
 */
export const UNRESOLVABLE_TARGET_APPROVAL_MODE: ApprovalMode =
  FAIL_CLOSED_APPROVAL_MODE;

/**
 * Surface defaults substituted when the preferences read was degraded.
 *
 * `readPreferencesFile()` silently returns `DEFAULT_PREFERENCES` when the file
 * is corrupt/unreadable/unsupported AND recovery also failed — and those
 * defaults are now all Full Access. Without this substitution an unreadable
 * preferences file would grant unrestricted execution, which is the opposite of
 * the intended posture. It cannot be caught downstream either: `full-access`
 * sets `allowDangerouslySkipPermissions` and omits the `canUseTool` hook, so
 * `approval-service`'s degraded-read `forcePrompt` safeguard never runs.
 */
const DEGRADED_READ_APPROVAL_DEFAULTS: ApprovalDefaults = {
  worktree: UNRESOLVABLE_TARGET_APPROVAL_MODE,
  cowork: UNRESOLVABLE_TARGET_APPROVAL_MODE,
  appAdvisor: UNRESOLVABLE_TARGET_APPROVAL_MODE,
};

/**
 * Selects the approval defaults to resolve against, failing closed when the
 * preferences read that produced `preferences` was degraded.
 *
 * A genuinely fresh install (no preferences file and no last-known-good file)
 * leaves no pending load error, so it correctly keeps the Full Access product
 * default. Only an actual read/parse/version failure downgrades to Ask.
 *
 * Every main-process caller that resolves an approval mode from persisted
 * preferences must route through this rather than reading `approvalDefaults`
 * directly.
 */
export function approvalDefaultsFromPreferences(
  preferences: { approvalDefaults: ApprovalDefaults } | null | undefined,
): ApprovalDefaults {
  if (!preferences || peekPreferencesLoadError() !== null) {
    return DEGRADED_READ_APPROVAL_DEFAULTS;
  }
  return preferences.approvalDefaults;
}

/**
 * Chat project ids that are sentinels rather than real workspace ids. Their
 * owning workspace is resolved through {@link resolveApprovalProjectId}.
 */
const SENTINEL_CHAT_PROJECT_IDS: ReadonlySet<string> = new Set([
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  STANDALONE_CHAT_PROJECT_ID,
]);
const APPROVAL_MODE_RANK: Readonly<Record<ApprovalMode, number>> = {
  ask: 0,
  auto: 1,
  'full-access': 2,
};
const pendingApprovalDefaultWrites = new Map<
  keyof ApprovalDefaults,
  Set<Promise<void>>
>();
const approvalDefaultIntentGenerations = new Map<
  keyof ApprovalDefaults,
  number
>();
const committedApprovalDefaultIntentGenerations = new Map<
  keyof ApprovalDefaults,
  number
>();

/**
 * Registers a surface-default write before it waits for the serialized
 * preferences queue. Resolved-default reads wait for these barriers so they
 * cannot permanently stamp the previous disk value onto a newly created tab.
 */
export function beginPendingApprovalDefaultWrite(
  surface: keyof ApprovalDefaults,
): () => void {
  let resolveWrite: (() => void) | undefined;
  const completion = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  const writes = pendingApprovalDefaultWrites.get(surface) ?? new Set();
  writes.add(completion);
  pendingApprovalDefaultWrites.set(surface, writes);
  markApprovalDefaultsChanged();
  let active = true;

  return (): void => {
    if (!active) {
      return;
    }
    active = false;
    markApprovalDefaultsChanged();
    writes.delete(completion);
    if (writes.size === 0) {
      pendingApprovalDefaultWrites.delete(surface);
    }
    resolveWrite?.();
  };
}

/**
 * Orders user choices that target the same persisted surface default, even
 * when their per-chat runtime transitions complete out of order.
 */
export function beginApprovalDefaultIntent(
  surface: keyof ApprovalDefaults,
): number {
  const generation = (approvalDefaultIntentGenerations.get(surface) ?? 0) + 1;
  approvalDefaultIntentGenerations.set(surface, generation);
  return generation;
}

/**
 * Publishes a fully committed choice as the newest authoritative intent for
 * its surface. Failed newer requests never reach this point, so they cannot
 * suppress an older transition that eventually succeeds.
 */
export function commitApprovalDefaultIntent(
  surface: keyof ApprovalDefaults,
  generation: number,
): void {
  const committedGeneration =
    committedApprovalDefaultIntentGenerations.get(surface) ?? 0;
  if (generation > committedGeneration) {
    committedApprovalDefaultIntentGenerations.set(surface, generation);
  }
}

export function isApprovalDefaultIntentCurrent(
  surface: keyof ApprovalDefaults,
  generation: number,
): boolean {
  return (
    (committedApprovalDefaultIntentGenerations.get(surface) ?? 0) <= generation
  );
}

export interface ApprovalPreferencesRead {
  preferences: PreferencesData;
  defaults: ApprovalDefaults;
}

/** Drains same-surface writes, including writes registered while waiting. */
export function waitForPendingApprovalDefaultWrites(
  surface: keyof ApprovalDefaults,
): Promise<void> {
  const pendingWrites = pendingApprovalDefaultWrites.get(surface);
  if (!pendingWrites) {
    return Promise.resolve();
  }
  return Promise.all(Array.from(pendingWrites)).then(() =>
    waitForPendingApprovalDefaultWrites(surface),
  );
}

/**
 * Drains every same-surface write that joins before the committed read starts.
 * The defaults are derived as soon as that read completes so acknowledging a
 * recovery notification cannot retroactively make a degraded result trusted.
 */
export function readApprovalPreferencesForSurface(
  surface: ApprovalSurface,
): Promise<ApprovalPreferencesRead> {
  const surfaceKey = defaultsKeyForSurface(surface);
  const pendingWrites = pendingApprovalDefaultWrites.get(surfaceKey);
  if (pendingWrites) {
    return Promise.all(Array.from(pendingWrites)).then(() =>
      readApprovalPreferencesForSurface(surface),
    );
  }
  return readPreferencesFile().then((preferences) => ({
    preferences,
    defaults: approvalDefaultsFromPreferences(preferences),
  }));
}

/**
 * Maps an `ApprovalSurface` onto its `ApprovalDefaults` property name. Exported
 * so the in-chat sticky-default write-back persists to the same key that
 * {@link resolveApprovalMode} reads back.
 */
export function defaultsKeyForSurface(
  surface: ApprovalSurface,
): keyof ApprovalDefaults {
  if (surface === 'cowork') {
    return 'cowork';
  }
  if (surface === 'app-advisor') {
    return 'appAdvisor';
  }
  return 'worktree';
}

/**
 * Resolves the effective approval mode for a chat turn. An explicit local tab
 * choice is authoritative. Repository-owned canopy.json and hook modes can
 * only make the workspace/surface default less permissive.
 */
export function resolveApprovalMode(
  input: ResolveApprovalModeInput,
): ApprovalMode {
  if (input.tabMode !== undefined) {
    return input.tabMode;
  }
  const surfaceDefault =
    input.workspaceDefault ??
    input.defaults[defaultsKeyForSurface(input.surface)] ??
    PRODUCT_DEFAULT_APPROVAL_MODE;
  const repositoryClampedDefault =
    input.canopyJsonDefault === undefined
      ? surfaceDefault
      : lessPermissiveApprovalMode(input.canopyJsonDefault, surfaceDefault);
  if (input.hookMode !== undefined) {
    return lessPermissiveApprovalMode(input.hookMode, repositoryClampedDefault);
  }
  return repositoryClampedDefault;
}

/**
 * Resolves a main-process-owned chat's effective mode from the same persisted
 * sources used by the renderer. Portal sends have no renderer available to
 * pre-resolve and stamp this value onto a newly created tab.
 */
export async function resolvePersistedApprovalMode(
  projectId: string,
  worktreeId: string,
  tabMode?: ApprovalMode,
): Promise<ApprovalMode> {
  if (tabMode !== undefined) {
    return tabMode;
  }
  const target = resolveWorktreeTargetIds(projectId, worktreeId);
  if (!target) {
    // A read failure, not a user default: stay fail-closed.
    return UNRESOLVABLE_TARGET_APPROVAL_MODE;
  }
  const resolvedProjectId = target.projectId;
  const surface = surfaceForChat(resolvedProjectId);
  const [workspaceApprovals, manifest, approvalPreferences] = await Promise.all(
    [
      readWorkspaceApprovals(resolvedProjectId),
      readWorkspaceApprovalsManifest(resolvedProjectId),
      readApprovalPreferencesForSurface(surface),
    ],
  );
  return resolveApprovalMode({
    tabMode,
    workspaceDefault: workspaceApprovals.defaultMode,
    canopyJsonDefault: manifest.defaultMode,
    surface,
    defaults: approvalPreferences.defaults,
  });
}

export function lessPermissiveApprovalMode(
  first: ApprovalMode,
  second: ApprovalMode,
): ApprovalMode {
  return APPROVAL_MODE_RANK[first] <= APPROVAL_MODE_RANK[second]
    ? first
    : second;
}

/**
 * Maps a chat's `(projectId, worktreeId)` pair onto the workspace id that owns
 * its approval settings, collapsing the code-review, plan-explore, and legacy
 * cowork sentinels onto their real workspace. Returns `undefined` when the
 * sentinel cannot be resolved, so callers fail closed rather than writing or
 * reading approval state against a sentinel id.
 *
 * Shared by the `approval:resolved-default` IPC handler and the in-chat
 * sticky-default write-back so both classify a surface identically.
 */
export function resolveApprovalProjectId(
  projectId: string,
  worktreeId?: string,
): string | undefined {
  if (!SENTINEL_CHAT_PROJECT_IDS.has(projectId)) {
    return projectId;
  }
  if (!worktreeId) {
    return undefined;
  }
  return resolveWorktreeTargetIds(projectId, worktreeId)?.projectId;
}

/**
 * Whether a chat project id is an ephemeral, Canopy-owned scratch surface
 * rather than a surface the user thinks of as "their chats".
 *
 * Code-review and plan-explore chats resolve to their OWNING worktree's
 * projectId, so they classify as `'worktree'`. That is right for *reading* a
 * default, but wrong for *writing* one: changing the mode inside a throwaway
 * side chat would silently repoint the default for every worktree chat the
 * user has — a surface they think of as "my project chats".
 *
 * Two ids are deliberately NOT in this set, both for the same reason — they
 * write back to a surface that is genuinely their own, not a borrowed one:
 *
 * - `STANDALONE_CHAT_PROJECT_ID` (legacy cowork) maps to a real cowork
 *   workspace the user owns.
 * - `PIPELINE_EDITOR_PROJECT_ID` maps to `'app-advisor'`, which is the shared
 *   surface for Canopy's own assistant chats. Settings exposes exactly one
 *   App Advisor default covering both, so a change made in the Pipeline Editor
 *   updating that default is the intended behavior, not leakage into the
 *   user's project chats. Reviewed and kept deliberately (CAN-3055); if the
 *   two ever need independent defaults, split the surface rather than adding
 *   Pipeline Editor here.
 */
export function isEphemeralApprovalSurface(projectId: string): boolean {
  return (
    projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
    projectId === PLAN_EXPLORE_CHAT_PROJECT_ID
  );
}

/**
 * Classifies a chat's owning project/workspace id into an `ApprovalSurface`.
 * Plan-explore and code-review chats run under their owning worktree's
 * projectId, so they fall through to `'worktree'` with no special casing.
 */
export function surfaceForChat(projectId: string): ApprovalSurface {
  if (
    projectId === APP_ADVISOR_PROJECT_ID ||
    projectId === PIPELINE_EDITOR_PROJECT_ID
  ) {
    return 'app-advisor';
  }
  if (isCoworkWorkspace(projectId)) {
    return 'cowork';
  }
  return 'worktree';
}
