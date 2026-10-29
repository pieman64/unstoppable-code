import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  SharedContainerPreferredLayoutRequest,
  SharedContainerPreferredLayoutState,
  SharedContainerSharePreview,
} from '@canopy/desktop-shared/types';
import {
  MAX_SHARED_CONTAINER_RUN_COMMANDS,
  type SharedContainerType,
} from '@canopy/protocol/shared-containers';
import {
  fileScopeIsAllowlist as resolveFileScopeIsAllowlist,
  selectDefaultRunScripts,
} from '@canopy/desktop-shared/lib/shared-container-scope-mode';
import { flushPanelLayoutSaveForWorktree } from '@/lib/panels/persistence-bridge';
import { makeWorktreePanelKey } from '@/stores/panelLayoutStore';
import { SCOPE_SAVE_ERROR_LABEL, buildShareSummaryLines } from './shareCopy';
import {
  organizationFieldsForOwnerKey,
  type ShareRequestScope,
} from './shareRequestScope';

/** The owner-approved share scope, exactly as it is persisted. */
export interface ApprovedShareScope {
  /** Legacy Cowork allowlist. Ignored for code worktrees. */
  includedPaths: string[];
  /**
   * File opt-outs. `undefined` is not "none" for Cowork: it is what preserves
   * a legacy Cowork scope that was narrowed under the old allowlist semantics,
   * so every handler carries the field through untouched rather than
   * defaulting it. Code worktrees are always opt-out.
   */
  excludedPaths?: string[];
  /** Explicit marker for a legacy Cowork allowlist with no remaining paths. */
  legacyAllowlist?: boolean;
  /** Notes are shared unless their id is listed here. */
  excludedNoteIds: string[];
  /** Prompts are shared unless their id is listed here. */
  excludedPromptIds: string[];
  /** Run sharing (CAN-2831) is on unless the owner turned it off. */
  runSharingDisabled: boolean;
  /**
   * Scripts the owner unticked. Kept while run sharing is off, so turning it
   * back on restores the owner's choices.
   */
  excludedRunScripts: string[];
  /**
   * What this save does to the preferred layout. Absent is `keep`, which is
   * what every other scope change sends.
   */
  preferredLayout?: SharedContainerPreferredLayoutRequest;
}

/**
 * Commits the shared worktree's pending layout save, so a pin taken by main
 * matches what is on screen. A failed flush does not stop the caller: main
 * then pins the last saved layout, as it does for a share created outside the
 * dialog. Browser sessions are persisted by main and need no flush.
 */
export async function flushShareLayoutSave(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  try {
    await flushPanelLayoutSaveForWorktree(
      makeWorktreePanelKey(projectId, worktreeId),
    );
  } catch {
    // Falls back to the last saved layout.
  }
}

function withPreferredLayout(
  preview: SharedContainerSharePreview,
  preferredLayout: SharedContainerPreferredLayoutState | undefined,
): SharedContainerSharePreview {
  return {
    ...preview,
    approvedFileScope: { ...preview.approvedFileScope, preferredLayout },
  };
}

/**
 * How many scripts a publisher may tick for one share.
 *
 * Mirrors the wire contract's command cap. The picker offers every script the
 * publisher can see in their own Scripts panel, so a repo like canopy's (12
 * scripts) can exceed what one revision may carry; the publisher chooses which
 * handful matter rather than having the list silently truncated at publish.
 * The scope normalizer in main enforces the same cap, so this is presentation.
 */
export const MAX_PUBLISHABLE_RUN_SCRIPTS = MAX_SHARED_CONTAINER_RUN_COMMANDS;

/** A directory offered as a single "select all" tick over the files beneath it. */
export interface CandidateDirectoryGroup {
  directory: string;
  paths: string[];
}

export function toggleScopeValue(
  values: readonly string[],
  value: string,
  included: boolean,
): string[] {
  return Array.from(
    new Set(
      included
        ? [...values, value]
        : values.filter((candidate) => candidate !== value),
    ),
  ).sort();
}

/**
 * The files this share will carry, in the preview's ranked order.
 *
 * Mirrors `selectSharedContainerCandidatePaths` in main, which stays
 * authoritative:
 * this exists so a tick reflects the owner's decision immediately instead of
 * waiting a round trip for the refreshed preview to agree. Ranked order is
 * load-bearing — `limit` is the artifact budget left for files, so the files
 * the ranking put last are the ones that fall outside it and render un-ticked.
 */
export function selectIncludedFilePaths(
  containerType: SharedContainerType,
  candidates: readonly string[],
  includedPaths: readonly string[],
  excludedPaths: readonly string[] | undefined,
  limit: number,
  legacyAllowlist = false,
): string[] {
  const legacy = resolveFileScopeIsAllowlist(containerType, {
    includedPaths: [...includedPaths],
    ...(excludedPaths !== undefined
      ? { excludedPaths: [...excludedPaths] }
      : {}),
    ...(legacyAllowlist ? { legacyAllowlist: true } : {}),
  });
  const included = new Set(includedPaths);
  const excluded = new Set(excludedPaths ?? []);
  const selected = candidates.filter((path) =>
    legacy ? included.has(path) : !excluded.has(path),
  );
  return legacy ? selected : selected.slice(0, Math.max(0, limit));
}

/**
 * Groups candidate files under every ancestor directory so the owner can
 * approve a whole subtree in one tick. The group is only an affordance: it is
 * expanded to its concrete paths when ticked, so files added to the folder
 * afterwards are never shared implicitly.
 */
export function groupCandidateDirectories(
  candidates: readonly string[],
): CandidateDirectoryGroup[] {
  const groups = new Map<string, string[]>();
  for (const path of candidates) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join('/');
      const existing = groups.get(directory);
      if (existing) existing.push(path);
      else groups.set(directory, [path]);
    }
  }
  return Array.from(groups.entries())
    .filter(([, paths]) => paths.length > 1)
    .map(([directory, paths]) => ({
      directory,
      paths: paths.slice().sort(),
    }))
    .sort((left, right) => left.directory.localeCompare(right.directory));
}

export interface UseSharePreviewOptions {
  projectId: string;
  worktreeId: string;
  /** Owner key of the container, or `''` while ownership is unknown. */
  ownerKey: string;
  containerType: SharedContainerType;
  newInvitesEnabled: boolean;
  eligible: boolean;
  scope: ShareRequestScope;
  onScopeError: (message: string | null) => void;
  /** Bumped by the shell on organization switch so the scope resets whole. */
  resetToken: number;
}

/**
 * Lifecycle of the artifact-budget remedy's push. `push-blocked` is a branch a
 * plain push cannot update; `push-error` is a retryable transport failure.
 */
export type ShareBudgetPushState =
  | 'idle'
  | 'pushing'
  | 'push-error'
  | 'push-blocked';

/**
 * The one place sharing still offers a push: a revision over its item budget
 * cannot publish at all, and pushing moves the share's base forward so the
 * overlay shrinks. Never a precondition for inviting.
 */
export interface ShareBudgetPush {
  /** A code share with commits GitHub does not have yet, so a push can help. */
  available: boolean;
  state: ShareBudgetPushState;
  push: () => void;
}

export interface UseSharePreviewResult {
  projectId: string;
  worktreeId: string;
  preview: SharedContainerSharePreview | null;
  /**
   * The preview request rejected. Not a gate — the invite still proceeds — but
   * the panel that would have carried the blockers needs to say why it is
   * empty rather than disappear.
   */
  previewFailed: boolean;
  approvedFilePaths: string[];
  approvedExcludedPaths: string[] | undefined;
  /** The files this share carries, already resolved against scope and budget. */
  includedFilePaths: string[];
  /** Every file the preview offered, before exclusions. */
  candidateFileCount: number;
  /**
   * Whether ticking a file means "add it" rather than "keep it". Only a legacy
   * Cowork allowlist; every code worktree is opt-out.
   */
  fileScopeIsAllowlist: boolean;
  /** Notes this share carries: every offered note the owner did not untick. */
  includedNoteIds: string[];
  /** Prompts this share carries: every offered prompt the owner did not untick. */
  includedPromptIds: string[];
  fileScopeSaving: boolean;
  summaryLines: string[];
  candidateDirectories: CandidateDirectoryGroup[];
  selectableFilePaths: string[];
  artifactBudgetUsed: number;
  artifactBudgetLimit: number;
  artifactBudgetExceeded: boolean;
  undisclosedRepositoryCount: number;
  /** Repositories whose code travels through the cloud, not GitHub. */
  snapshotRepositoryCount: number;
  snapshotRepositoryNames: string[];
  withheldFileCount: number;
  withheldFilePaths: string[];
  withheldSymlinkPaths: string[];
  budgetPush: ShareBudgetPush;
  /** Re-saves the approved scope, which forces main to schedule publication. */
  retryPublication: () => void;
  /** Run sharing is on by default; the owner can turn it off. */
  runSharingEnabled: boolean;
  /** The scripts that publish: the first eight the owner did not untick. */
  includedRunScripts: string[];
  /** Receivers open to the publisher's layout. On unless turned off. */
  preferredLayoutEnabled: boolean;
  /** ISO timestamp of the saved layout, or null when none is saved yet. */
  preferredLayoutPinnedAt: string | null;
  /** On saves the layout on screen; off stops shipping a layout. */
  handlePreferredLayoutToggle: (enabled: boolean) => void;
  /** Replaces the saved layout with the layout on screen. */
  handlePreferredLayoutUpdate: () => void;
  /**
   * Re-reads the preview after a share was created, because main saves the
   * layout then. A no-op once a layout is saved or while the layout is off.
   */
  refreshPreferredLayoutAfterShare: () => void;
  handleRunSharingChange: (enabled: boolean) => void;
  handleRunScriptScopeChange: (scriptName: string, included: boolean) => void;
  handleFileScopeChange: (path: string, included: boolean) => void;
  handleDirectoryScopeChange: (
    paths: readonly string[],
    included: boolean,
  ) => void;
  handleNoteScopeChange: (noteId: string, included: boolean) => void;
  handlePromptScopeChange: (promptId: string, included: boolean) => void;
}

/**
 * Owns the share preview and the owner-approved scope derived from it.
 *
 * The preview is supporting detail, never a gate: its absence must not block
 * the invite, so every failure here is swallowed rather than surfaced as a
 * refusal. The one exception is a failed scope *save*, which is a decision the
 * owner made that did not stick, so it rolls back and reports.
 */
export function useSharePreview({
  projectId,
  worktreeId,
  ownerKey,
  containerType,
  newInvitesEnabled,
  eligible,
  scope,
  onScopeError,
  resetToken,
}: UseSharePreviewOptions): UseSharePreviewResult {
  const [preview, setPreview] = useState<SharedContainerSharePreview | null>(
    null,
  );
  const [previewFailed, setPreviewFailed] = useState(false);
  const [approvedFilePaths, setApprovedFilePaths] = useState<string[]>([]);
  const [approvedExcludedPaths, setApprovedExcludedPaths] = useState<
    string[] | undefined
  >(undefined);
  const [approvedLegacyAllowlist, setApprovedLegacyAllowlist] = useState(false);
  const [excludedNoteIds, setExcludedNoteIds] = useState<string[]>([]);
  const [excludedPromptIds, setExcludedPromptIds] = useState<string[]>([]);
  const [runSharingDisabled, setRunSharingDisabled] = useState(false);
  const [excludedRunScripts, setExcludedRunScripts] = useState<string[]>([]);
  const [fileScopeSaving, setFileScopeSaving] = useState(false);
  const [budgetPushState, setBudgetPushState] =
    useState<ShareBudgetPushState>('idle');
  // Bumped after a successful budget push so the preview re-answers against
  // the moved base without clearing what is on screen.
  const [reloadToken, setReloadToken] = useState(0);
  const previewRequestRef = useRef(0);

  // The approved scope is one unit, so all three lists reset together with the
  // preview that hydrates them. A half-cleared scope is exactly the state
  // `persistFileScope` would write back for the newly selected target.
  useEffect(() => {
    previewRequestRef.current += 1;
    setPreview(null);
    setPreviewFailed(false);
    setApprovedFilePaths([]);
    setApprovedExcludedPaths(undefined);
    setApprovedLegacyAllowlist(false);
    setExcludedNoteIds([]);
    setExcludedPromptIds([]);
    setRunSharingDisabled(false);
    setExcludedRunScripts([]);
    setFileScopeSaving(false);
    setBudgetPushState('idle');
  }, [resetToken]);

  useEffect(() => {
    if (!newInvitesEnabled || !eligible || !ownerKey) return;
    const requestId = ++previewRequestRef.current;
    const requestOwnerKey = ownerKey;
    void (async (): Promise<void> => {
      try {
        const next = await window.api.sharedContainers.preview({
          projectId,
          worktreeId,
          ...organizationFieldsForOwnerKey(requestOwnerKey),
          containerType,
        });
        if (
          !scope.isStale(requestOwnerKey) &&
          previewRequestRef.current === requestId
        ) {
          setPreview(next);
          setPreviewFailed(false);
          setApprovedFilePaths(next.approvedFileScope.includedPaths);
          setApprovedExcludedPaths(next.approvedFileScope.excludedPaths);
          setApprovedLegacyAllowlist(
            next.approvedFileScope.legacyAllowlist === true,
          );
          setExcludedNoteIds(next.approvedFileScope.excludedNoteIds ?? []);
          setExcludedPromptIds(next.approvedFileScope.excludedPromptIds ?? []);
          setRunSharingDisabled(
            next.approvedFileScope.runSharingDisabled === true,
          );
          setExcludedRunScripts(
            next.approvedFileScope.excludedRunScripts ?? [],
          );
        }
      } catch {
        // The preview is supporting detail, not a gate, so this still fails
        // open and leaves the invite available. It is recorded rather than
        // swallowed because the blockers render from this same object: a
        // silent failure used to take the whole panel off screen, which read
        // as "this share has nothing to review" instead of "we could not
        // check".
        if (
          !scope.isStale(requestOwnerKey) &&
          previewRequestRef.current === requestId
        ) {
          setPreviewFailed(true);
        }
      }
    })();
  }, [
    eligible,
    projectId,
    worktreeId,
    ownerKey,
    containerType,
    newInvitesEnabled,
    scope,
    reloadToken,
  ]);

  const isCoworkContainer = containerType === 'COWORK_WORK_ENTRY';
  const candidateFilePaths = useMemo(
    () => preview?.untrackedCandidates ?? [],
    [preview?.untrackedCandidates],
  );
  // The rows are bounded; the count is not. `untrackedCandidates` is truncated
  // for rendering, so counting it would report "195 of 200 files" on a folder
  // main already told us holds 500 — and the details expander says 500 two
  // lines below. The denominator is the total main reported.
  const candidateFileCount =
    preview?.untrackedCandidateCount ?? candidateFilePaths.length;
  const fileScopeIsAllowlist = resolveFileScopeIsAllowlist(containerType, {
    includedPaths: approvedFilePaths,
    ...(approvedExcludedPaths !== undefined
      ? { excludedPaths: approvedExcludedPaths }
      : {}),
    ...(approvedLegacyAllowlist ? { legacyAllowlist: true } : {}),
  });

  const artifactBudgetLimit = preview?.artifactBudget.limit ?? 0;
  // How much of the budget the *non-file* part of this share already uses.
  // The preview's `used` counts the files main selected, so backing those out
  // gives a figure that holds still while the owner ticks, and the difference
  // is exactly the room left for files.
  const nonFileArtifactUsed =
    (preview?.artifactBudget.used ?? 0) -
    (preview?.defaultIncludedFilePaths?.length ?? 0);
  // Main applies both the artifact-count and revision-byte ceilings. The
  // selected count it returns is therefore the authoritative optimistic limit;
  // re-deriving this from artifact count alone would tick byte-capped files.
  const defaultFileLimit = preview?.defaultIncludedFilePaths?.length ?? 0;

  /**
   * Which files this share carries: every candidate the owner has not opted
   * out of, capped at the budget so the default alone can never trip the
   * refusal that would disable Invite. A legacy Cowork allowlist is the
   * exception, and carries exactly what the owner ticked.
   */
  const includedFilePaths = useMemo(
    () =>
      fileScopeIsAllowlist
        ? // An allowlist *is* the answer, including entries that have stopped
          // being candidates: those are still approved, and the owner needs
          // the row to stay ticked so they can untick it.
          approvedFilePaths
        : selectIncludedFilePaths(
            containerType,
            candidateFilePaths,
            approvedFilePaths,
            approvedExcludedPaths,
            defaultFileLimit,
            approvedLegacyAllowlist,
          ),
    [
      approvedExcludedPaths,
      approvedFilePaths,
      approvedLegacyAllowlist,
      candidateFilePaths,
      containerType,
      defaultFileLimit,
      fileScopeIsAllowlist,
    ],
  );

  // Every artifact in a revision is signed and uploaded individually, so a
  // revision has a hard per-revision ceiling. The publisher refuses rather
  // than truncating, which makes the remaining budget owner-facing detail.
  const artifactBudgetUsed = fileScopeIsAllowlist
    ? (preview?.artifactBudget.used ?? 0)
    : nonFileArtifactUsed + includedFilePaths.length;
  const artifactBudgetExceeded =
    artifactBudgetLimit > 0 && artifactBudgetUsed > artifactBudgetLimit;
  const undisclosedRepositoryCount = preview?.undisclosedRepositoryCount ?? 0;
  const snapshotRepositoryCount = preview?.snapshotRepositoryCount ?? 0;
  const snapshotRepositoryNames = preview?.snapshotRepositoryNames ?? [];
  const withheldFileCount = preview?.withheldFileCount ?? 0;
  const withheldFilePaths = preview?.withheldFilePaths ?? [];
  // Owner-side only. The wire revision layout stays path-free by design, but
  // the owner already has this repository checked out, so naming their own
  // escaping symlinks discloses nothing and is the only way the warning is
  // actionable. The preview bounds this list.
  const withheldSymlinkPaths = preview?.withheldSymlinkPaths ?? [];

  // Notes and prompts are opt-out for both container types: the share
  // carries every offered one the owner did not untick.
  const includedNoteIds = useMemo(() => {
    const excluded = new Set(excludedNoteIds);
    return (preview?.notes ?? [])
      .map((note) => note.id)
      .filter((id) => !excluded.has(id));
  }, [excludedNoteIds, preview?.notes]);
  const includedPromptIds = useMemo(() => {
    const excluded = new Set(excludedPromptIds);
    return (preview?.prompts ?? [])
      .map((prompt) => prompt.id)
      .filter((id) => !excluded.has(id));
  }, [excludedPromptIds, preview?.prompts]);
  const runSharingEnabled = !runSharingDisabled;
  // Resolved through the same helper main publishes with, so a tick here
  // agrees with what the recipient receives.
  const includedRunScripts = useMemo(
    () =>
      selectDefaultRunScripts(preview?.availableRunScripts ?? [], {
        includedPaths: [],
        runSharingDisabled,
        excludedRunScripts,
      }),
    [excludedRunScripts, preview?.availableRunScripts, runSharingDisabled],
  );

  const summaryLines = useMemo(
    () =>
      buildShareSummaryLines(preview, isCoworkContainer, {
        approvedFileCount: includedFilePaths.length,
        candidateFileCount,
        fileScopeIsAllowlist,
        approvedNoteCount: includedNoteIds.length,
        approvedPromptCount: includedPromptIds.length,
      }),
    [
      preview,
      isCoworkContainer,
      includedNoteIds.length,
      includedPromptIds.length,
      candidateFileCount,
      fileScopeIsAllowlist,
      includedFilePaths.length,
    ],
  );
  const candidateDirectories = useMemo(
    () => groupCandidateDirectories(preview?.untrackedCandidates ?? []),
    [preview?.untrackedCandidates],
  );
  /**
   * The rows the owner can tick. Under opt-out semantics that is the candidate
   * list alone: an `includedPaths` entry is not an opt-out concept, and
   * folding one in would render a row whose tick had no effect. Allowlist
   * Cowork scopes keep the union so an already-approved path stays revocable even
   * after it stops being a candidate.
   */
  const selectableFilePaths = useMemo(
    () =>
      fileScopeIsAllowlist
        ? Array.from(
            new Set([...candidateFilePaths, ...approvedFilePaths]),
          ).sort()
        : candidateFilePaths.slice().sort(),
    [approvedFilePaths, candidateFilePaths, fileScopeIsAllowlist],
  );

  // The checkbox is itself the explicit "Approve" action. Persisting here
  // intentionally retains that decision if the user closes and reopens the
  // invite modal; clearing a checkbox revokes that part of the approval.
  const persistFileScope = useCallback(
    (next: ApprovedShareScope): void => {
      // The worktree model is permanently opt-out. Sanitize legacy preview
      // state here so changing any other scope control also removes the old
      // allowlist fields instead of carrying them back across IPC.
      const nextScope: ApprovedShareScope =
        containerType === 'COWORK_WORK_ENTRY'
          ? next
          : { ...next, includedPaths: [], legacyAllowlist: undefined };
      const previous: ApprovedShareScope = {
        includedPaths: approvedFilePaths,
        excludedPaths: approvedExcludedPaths,
        legacyAllowlist: approvedLegacyAllowlist || undefined,
        excludedNoteIds,
        excludedPromptIds,
        runSharingDisabled,
        excludedRunScripts,
      };
      const requestOwnerKey = ownerKey;
      const preferredLayoutRequest = nextScope.preferredLayout ?? 'keep';
      const previousPreferredLayout =
        preview?.approvedFileScope.preferredLayout;
      if (preferredLayoutRequest !== 'keep') {
        // A pin keeps the earlier saved-at time until main answers with the
        // new one, so the row never claims a save that has not happened.
        const optimistic: SharedContainerPreferredLayoutState =
          preferredLayoutRequest === 'clear'
            ? { enabled: false }
            : {
                enabled: true,
                ...(previousPreferredLayout?.enabled === true &&
                previousPreferredLayout.pinnedAt !== undefined
                  ? { pinnedAt: previousPreferredLayout.pinnedAt }
                  : {}),
              };
        setPreview((current) =>
          current ? withPreferredLayout(current, optimistic) : current,
        );
      }
      setApprovedFilePaths(nextScope.includedPaths);
      setApprovedExcludedPaths(nextScope.excludedPaths);
      setApprovedLegacyAllowlist(nextScope.legacyAllowlist === true);
      setExcludedNoteIds(nextScope.excludedNoteIds);
      setExcludedPromptIds(nextScope.excludedPromptIds);
      setRunSharingDisabled(nextScope.runSharingDisabled);
      setExcludedRunScripts(nextScope.excludedRunScripts);
      setFileScopeSaving(true);
      onScopeError(null);
      void (async (): Promise<void> => {
        try {
          if (preferredLayoutRequest === 'pin-current') {
            await flushShareLayoutSave(projectId, worktreeId);
          }
          const result = await window.api.sharedContainers.saveFileScope({
            projectId,
            worktreeId,
            includedPaths: nextScope.includedPaths,
            // Omitted rather than sent empty: an absent field is what keeps a
            // legacy Cowork allowlist reading as an allowlist in main.
            ...(nextScope.excludedPaths !== undefined
              ? { excludedPaths: nextScope.excludedPaths }
              : {}),
            ...(nextScope.legacyAllowlist === true
              ? { legacyAllowlist: true }
              : {}),
            excludedNoteIds: nextScope.excludedNoteIds,
            excludedPromptIds: nextScope.excludedPromptIds,
            runSharingDisabled: nextScope.runSharingDisabled,
            excludedRunScripts: nextScope.excludedRunScripts,
            ...(preferredLayoutRequest !== 'keep'
              ? { preferredLayout: preferredLayoutRequest }
              : {}),
          });
          if (scope.isStale(requestOwnerKey)) return;
          setApprovedFilePaths(result.fileScope.includedPaths);
          setApprovedExcludedPaths(result.fileScope.excludedPaths);
          setApprovedLegacyAllowlist(result.fileScope.legacyAllowlist === true);
          setExcludedNoteIds(result.fileScope.excludedNoteIds ?? []);
          setExcludedPromptIds(result.fileScope.excludedPromptIds ?? []);
          setRunSharingDisabled(result.fileScope.runSharingDisabled === true);
          setExcludedRunScripts(result.fileScope.excludedRunScripts ?? []);
          setPreview((current) =>
            current
              ? { ...current, approvedFileScope: result.fileScope }
              : current,
          );
          const requestId = ++previewRequestRef.current;
          try {
            const refreshed = await window.api.sharedContainers.preview({
              projectId,
              worktreeId,
              ...organizationFieldsForOwnerKey(requestOwnerKey),
              containerType,
            });
            if (
              !scope.isStale(requestOwnerKey) &&
              previewRequestRef.current === requestId
            ) {
              setPreview({
                ...refreshed,
                // The save response is newer than a concurrently computed
                // preview and remains authoritative for the selected scope.
                approvedFileScope: result.fileScope,
              });
            }
          } catch {
            // The saved scope is authoritative, but the old candidate ranking
            // and budget are not. Hide those controls rather than showing a
            // checked set that publication may omit under the new scope.
            if (
              !scope.isStale(requestOwnerKey) &&
              previewRequestRef.current === requestId
            ) {
              setPreview(null);
              setPreviewFailed(true);
            }
          }
        } catch {
          if (scope.isStale(requestOwnerKey)) return;
          setApprovedFilePaths(previous.includedPaths);
          setApprovedExcludedPaths(previous.excludedPaths);
          setApprovedLegacyAllowlist(previous.legacyAllowlist === true);
          setExcludedNoteIds(previous.excludedNoteIds);
          setExcludedPromptIds(previous.excludedPromptIds);
          setRunSharingDisabled(previous.runSharingDisabled);
          setExcludedRunScripts(previous.excludedRunScripts);
          if (preferredLayoutRequest !== 'keep') {
            setPreview((current) =>
              current
                ? withPreferredLayout(current, previousPreferredLayout)
                : current,
            );
          }
          onScopeError(SCOPE_SAVE_ERROR_LABEL);
        } finally {
          if (!scope.cancelledRef.current) setFileScopeSaving(false);
        }
      })();
    },
    [
      approvedFilePaths,
      approvedLegacyAllowlist,
      approvedExcludedPaths,
      excludedNoteIds,
      excludedPromptIds,
      runSharingDisabled,
      excludedRunScripts,
      containerType,
      ownerKey,
      projectId,
      worktreeId,
      scope,
      onScopeError,
      preview?.approvedFileScope.preferredLayout,
    ],
  );

  /** The scope fields every handler carries through unchanged. */
  const currentScope = useMemo<ApprovedShareScope>(
    () => ({
      includedPaths: approvedFilePaths,
      excludedPaths: approvedExcludedPaths,
      legacyAllowlist: approvedLegacyAllowlist || undefined,
      excludedNoteIds,
      excludedPromptIds,
      runSharingDisabled,
      excludedRunScripts,
    }),
    [
      approvedFilePaths,
      approvedLegacyAllowlist,
      approvedExcludedPaths,
      excludedNoteIds,
      excludedPromptIds,
      excludedRunScripts,
      runSharingDisabled,
    ],
  );

  // Absent means on and not saved yet; only an explicit off turns it off.
  const preferredLayout = preview?.approvedFileScope.preferredLayout;
  const preferredLayoutEnabled = preferredLayout?.enabled !== false;
  const preferredLayoutPinnedAt =
    preferredLayoutEnabled && preferredLayout?.pinnedAt !== undefined
      ? preferredLayout.pinnedAt
      : null;

  const handlePreferredLayoutToggle = useCallback(
    (enabled: boolean): void => {
      // Turning it on always saves the layout on screen: there is no "on, to
      // be saved later" request.
      persistFileScope({
        ...currentScope,
        preferredLayout: enabled ? 'pin-current' : 'clear',
      });
    },
    [currentScope, persistFileScope],
  );

  const handlePreferredLayoutUpdate = useCallback((): void => {
    persistFileScope({ ...currentScope, preferredLayout: 'pin-current' });
  }, [currentScope, persistFileScope]);

  const refreshPreferredLayoutAfterShare = useCallback((): void => {
    if (!preferredLayoutEnabled || preferredLayoutPinnedAt !== null) return;
    setReloadToken((current) => current + 1);
  }, [preferredLayoutEnabled, preferredLayoutPinnedAt]);

  const handleRunSharingChange = useCallback(
    (enabled: boolean): void => {
      // The exclusions are kept while sharing is off, so turning it back on
      // restores the scripts the owner had unticked rather than resetting them.
      persistFileScope({
        ...currentScope,
        runSharingDisabled: !enabled,
      });
    },
    [currentScope, persistFileScope],
  );

  const handleRunScriptScopeChange = useCallback(
    (scriptName: string, included: boolean): void => {
      // Unticking records an exclusion; the next script in lifecycle-first
      // order then fills the freed slot, the same way files do.
      persistFileScope({
        ...currentScope,
        excludedRunScripts: toggleScopeValue(
          currentScope.excludedRunScripts,
          scriptName,
          !included,
        ),
      });
    },
    [currentScope, persistFileScope],
  );

  const handleFileScopeChange = useCallback(
    (path: string, included: boolean): void => {
      // Same checkbox, inverted meaning. Under opt-out semantics the owner is
      // recording what to leave behind, so clearing a tick writes an
      // exclusion rather than removing an approval that was never there.
      if (!fileScopeIsAllowlist) {
        persistFileScope({
          ...currentScope,
          excludedPaths: toggleScopeValue(
            approvedExcludedPaths ?? [],
            path,
            !included,
          ),
        });
        return;
      }
      const nextIncludedPaths = toggleScopeValue(
        approvedFilePaths,
        path,
        included,
      );
      persistFileScope({
        ...currentScope,
        includedPaths: nextIncludedPaths,
        legacyAllowlist:
          approvedLegacyAllowlist || nextIncludedPaths.length === 0
            ? true
            : undefined,
      });
    },
    [
      approvedExcludedPaths,
      approvedFilePaths,
      approvedLegacyAllowlist,
      currentScope,
      fileScopeIsAllowlist,
      persistFileScope,
    ],
  );

  const handleDirectoryScopeChange = useCallback(
    (paths: readonly string[], included: boolean): void => {
      // Folder selection is a UX affordance, not a protocol shape: it expands
      // to concrete file paths here, so the saved scope stays a flat file list
      // and a file added to the folder later is not shared until the owner
      // re-shares.
      if (!fileScopeIsAllowlist) {
        const nextExclusions = new Set(approvedExcludedPaths ?? []);
        for (const path of paths) {
          if (included) nextExclusions.delete(path);
          else nextExclusions.add(path);
        }
        persistFileScope({
          ...currentScope,
          excludedPaths: Array.from(nextExclusions).sort(),
        });
        return;
      }
      const nextPaths = new Set(approvedFilePaths);
      for (const path of paths) {
        if (included) nextPaths.add(path);
        else nextPaths.delete(path);
      }
      persistFileScope({
        ...currentScope,
        includedPaths: Array.from(nextPaths).sort(),
        legacyAllowlist:
          approvedLegacyAllowlist || nextPaths.size === 0 ? true : undefined,
      });
    },
    [
      approvedExcludedPaths,
      approvedFilePaths,
      approvedLegacyAllowlist,
      currentScope,
      fileScopeIsAllowlist,
      persistFileScope,
    ],
  );

  const handleNoteScopeChange = useCallback(
    (noteId: string, included: boolean): void => {
      persistFileScope({
        ...currentScope,
        excludedNoteIds: toggleScopeValue(excludedNoteIds, noteId, !included),
      });
    },
    [excludedNoteIds, currentScope, persistFileScope],
  );

  const handlePromptScopeChange = useCallback(
    (promptId: string, included: boolean): void => {
      persistFileScope({
        ...currentScope,
        excludedPromptIds: toggleScopeValue(
          excludedPromptIds,
          promptId,
          !included,
        ),
      });
    },
    [excludedPromptIds, currentScope, persistFileScope],
  );

  const retryPublication = useCallback((): void => {
    persistFileScope(currentScope);
  }, [currentScope, persistFileScope]);

  const pushForBudget = useCallback((): void => {
    if (!ownerKey) return;
    const requestOwnerKey = ownerKey;
    setBudgetPushState('pushing');
    void (async (): Promise<void> => {
      try {
        const response = await window.api.sharedContainers.prepareGithub({
          projectId,
          worktreeId,
          ...organizationFieldsForOwnerKey(requestOwnerKey),
          containerType,
        });
        // Always leave `pushing`: it feeds the modal's busy flag. The push
        // itself is safe and idempotent even when this answer is stale.
        if (scope.isStale(requestOwnerKey)) {
          setBudgetPushState('idle');
          return;
        }
        if (response.status === 'ready') {
          setBudgetPushState('idle');
          // Main already scheduled a republish; re-read the preview so the
          // smaller overlay (and the cleared blocker) shows now.
          setReloadToken((current) => current + 1);
          return;
        }
        setBudgetPushState(
          response.status === 'blocked' ? 'push-blocked' : 'push-error',
        );
      } catch {
        setBudgetPushState(
          scope.isStale(requestOwnerKey) ? 'idle' : 'push-error',
        );
      }
    })();
  }, [ownerKey, projectId, worktreeId, containerType, scope]);

  const budgetPush = useMemo(
    (): ShareBudgetPush => ({
      available: !isCoworkContainer && (preview?.unpushedCommitCount ?? 0) > 0,
      state: budgetPushState,
      push: pushForBudget,
    }),
    [
      isCoworkContainer,
      preview?.unpushedCommitCount,
      budgetPushState,
      pushForBudget,
    ],
  );

  return {
    projectId,
    worktreeId,
    preview,
    previewFailed,
    approvedFilePaths,
    approvedExcludedPaths,
    includedFilePaths,
    candidateFileCount,
    fileScopeIsAllowlist,
    includedNoteIds,
    includedPromptIds,
    fileScopeSaving,
    summaryLines,
    candidateDirectories,
    selectableFilePaths,
    artifactBudgetUsed,
    artifactBudgetLimit,
    artifactBudgetExceeded,
    undisclosedRepositoryCount,
    snapshotRepositoryCount,
    snapshotRepositoryNames,
    withheldFileCount,
    withheldFilePaths,
    withheldSymlinkPaths,
    budgetPush,
    retryPublication,
    runSharingEnabled,
    includedRunScripts,
    preferredLayoutEnabled,
    preferredLayoutPinnedAt,
    handlePreferredLayoutToggle,
    handlePreferredLayoutUpdate,
    refreshPreferredLayoutAfterShare,
    handleRunSharingChange,
    handleRunScriptScopeChange,
    handleFileScopeChange,
    handleDirectoryScopeChange,
    handleNoteScopeChange,
    handlePromptScopeChange,
  };
}
