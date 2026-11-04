import {
  DesktopOrgSharedMultiRepoSetup,
  useSharedMultiRepoRequired,
} from './DesktopOrgSharedMultiRepoSetup';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  AdhocMultiRepoMode,
  AdhocMultiRepoJoinOption,
  ExistingWorktreeJoinCandidate,
  ExistingWorktreeJoinWorkspaceGroup,
} from '@canopy/desktop-shared/types';
import {
  Button,
  Heading,
  Notice,
  SegmentedControl,
  type SegmentedControlOption,
} from '@canopy/ui-shared/components';
import { RefreshSpinnerIcon } from '@canopy/ui-shared/icons';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { brandText } from '@/lib/brand';
import { switchContextForWorkspace } from '@/lib/contextScope';
import { DialogModal } from '../shared';
import {
  ExistingWorktreePicker,
  getCandidateWarnings,
} from './ExistingWorktreePicker';
import { WorkspaceMultiSelectPicker } from './WorkspaceMultiSelectPicker';
import { Tooltip } from '@canopy/ui-shared';

/**
 * Which join flow the modal is showing: combine with other workspaces by
 * creating new worktrees for their repos (current default), or consume an
 * existing worktree from another workspace.
 */
type PickerMode = 'new-worktrees' | 'existing-worktrees';

const PICKER_MODE_OPTIONS: readonly SegmentedControlOption<PickerMode>[] = [
  {
    value: 'new-worktrees',
    label: 'New worktrees',
    dataTestId: 'add-repo-to-worktree-modal-pill-new',
  },
  {
    value: 'existing-worktrees',
    label: 'Existing worktrees',
    dataTestId: 'add-repo-to-worktree-modal-pill-existing',
  },
];

interface AddRepoToWorktreeModalProps {
  onOpenSharedDestination?: (workspaceId: string) => void;
  /** Workspace that owns the source worktree the user just acted on. */
  sourceWorkspaceId: string;
  /** Worktree the user wants to combine into a multi-repo destination. */
  sourceWorktreeId: string;
  onClose: () => void;
}

/**
 * Lands in the navigation context that owns a freshly joined destination, so
 * the sidebar shows its row before the worktree is selected. Resolves `false`
 * when the switch was refused or the owner cannot be resolved. The join is
 * already committed by then, so a navigation failure is contained here
 * instead of being reported as a failed join.
 */
async function showDestinationContext(
  destinationWorkspaceId: string,
): Promise<boolean> {
  try {
    return await switchContextForWorkspace(destinationWorkspaceId);
  } catch {
    return false;
  }
}

/**
 * Clear the selection only while it still points at a worktree this join
 * consumed, so tab migration cannot activate a row the sidebar is hiding.
 * A selection the user changed meanwhile is left alone.
 */
function clearConsumedWorktreeSelection(
  projectId: string,
  worktreeId: string,
): void {
  const { selectedWorktree, deselectWorktree } = useChatStore.getState();
  if (
    selectedWorktree?.projectId === projectId &&
    selectedWorktree.worktreeId === worktreeId
  ) {
    deselectWorktree();
  }
}

/**
 * "Add repo" modal that combines an existing worktree with another workspace
 * into an adhoc multi-repo destination worktree. Calls
 * `projectsStore.combineWorktreeWithWorkspace`, and on success threads chat
 * and file tabs onto the destination via
 * `chatStore.migrateWorktreeTabsToAdhocWorkspace`. Once the projects store has
 * registered the destination, the modal switches to the context that owns it
 * (its organization, or Personal when it is unowned) and then selects it, with
 * generic tab hydration deferred so migration can safely stage the destination
 * tabs. If that switch is refused the join still completes and its tabs still
 * migrate; the destination is just not selected, because the sidebar would be
 * hiding it. The picker is
 * loaded from the main process so workspaces that add no new repo are filtered
 * using the same repo identity rules as the combine flow.
 *
 * For non-temporary multi-repo source workspaces, the user can choose
 * whether to land in a brand-new temporary destination workspace or to
 * extend the source workspace itself (the "Update project" mode). For
 * single-repo and temporary multi-repo sources, the mode is locked to
 * temporary.
 */
export function AddRepoToWorktreeModal({
  onOpenSharedDestination,
  sourceWorkspaceId,
  sourceWorktreeId,
  onClose,
}: AddRepoToWorktreeModalProps): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);
  const combineWorktreeWithWorkspace = useProjectsStore(
    (state) => state.combineWorktreeWithWorkspace,
  );
  const combineWorktreeWithExistingWorktree = useProjectsStore(
    (state) => state.combineWorktreeWithExistingWorktree,
  );
  const migrateWorktreeTabsToAdhocWorkspace = useChatStore(
    (state) => state.migrateWorktreeTabsToAdhocWorkspace,
  );
  const flushWorktreeTabs = useChatStore((state) => state.flushWorktreeTabs);
  const selectWorktree = useChatStore((state) => state.selectWorktree);
  const addToast = useGitHubStore((state) => state.addToast);

  const sourceWorkspace = useMemo(
    () => projects.find((p) => p.id === sourceWorkspaceId),
    [projects, sourceWorkspaceId],
  );

  const sourceIsNonTempMultiRepo =
    sourceWorkspace?.type === 'multi-repo' &&
    sourceWorkspace.temporary !== true;

  const [workspaceOptions, setWorkspaceOptions] = useState<
    AdhocMultiRepoJoinOption[]
  >([]);
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>(
    [],
  );
  const [mode, setMode] = useState<AdhocMultiRepoMode>('temporary');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [pickerMode, setPickerMode] = useState<PickerMode>('new-worktrees');
  const [existingGroups, setExistingGroups] = useState<
    ExistingWorktreeJoinWorkspaceGroup[]
  >([]);
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [hasLoadedExisting, setHasLoadedExisting] = useState(false);
  const [selectedExisting, setSelectedExisting] =
    useState<ExistingWorktreeJoinCandidate | null>(null);
  const [existingSearchQuery, setExistingSearchQuery] = useState('');
  const selectedExistingGroup = useMemo(
    () =>
      selectedExisting
        ? existingGroups.find(
            (group) => group.workspaceId === selectedExisting.workspaceId,
          )
        : undefined,
    [existingGroups, selectedExisting],
  );

  const sharedRequired = useSharedMultiRepoRequired([
    sourceWorkspaceId,
    ...(pickerMode === 'existing-worktrees' && selectedExisting
      ? [selectedExisting.workspaceId]
      : selectedWorkspaceIds),
  ]);

  useCurrentUiStateReporter('worktree.adhocJoinModal', {
    open: true,
    sourceWorkspaceId,
    sourceWorktreeId,
    pickerMode,
    mode,
    workspaceOptionCount: workspaceOptions.length,
    selectedWorkspaceCount: selectedWorkspaceIds.length,
    existingWorkspaceGroupCount: existingGroups.length,
    existingCandidateCount: existingGroups.reduce(
      (sum, group) => sum + group.candidates.length,
      0,
    ),
    ...(selectedExisting
      ? {
          selectedExisting: {
            workspaceId: selectedExisting.workspaceId,
            worktreeId: selectedExisting.worktreeId,
            ...(selectedExistingGroup
              ? { workspaceName: selectedExistingGroup.workspaceName }
              : {}),
            worktreeName: selectedExisting.branchName,
          },
        }
      : {}),
    loading: pickerMode === 'new-worktrees' ? loadingOptions : loadingExisting,
    submitting,
    errorVisible: errorMessage !== null,
  });

  // Track the modal's mounted lifetime and the latest in-flight existing-load
  // request so a superseded or post-unmount response is ignored. Loads run
  // imperatively (mount, first switch, manual refresh) rather than as an
  // effect so switching pills never re-fetches.
  const mountedRef = useRef(true);
  const existingRequestIdRef = useRef(0);
  useEffect(() => {
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const loadWorkspaceOptions = useCallback(async (): Promise<void> => {
    setLoadingOptions(true);
    setErrorMessage(null);
    setSelectedWorkspaceIds([]);
    try {
      const response = await window.api.listAdhocMultiRepoJoinOptions({
        sourceWorkspaceId,
      });
      if (!mountedRef.current) return;
      setWorkspaceOptions(response.options);
    } catch (cause: unknown) {
      if (!mountedRef.current) return;
      setWorkspaceOptions([]);
      setErrorMessage(
        cause instanceof Error ? cause.message : 'Failed to load projects.',
      );
    } finally {
      if (mountedRef.current) {
        setLoadingOptions(false);
      }
    }
  }, [sourceWorkspaceId]);

  useEffect(() => {
    void loadWorkspaceOptions();
  }, [loadWorkspaceOptions]);

  const loadExistingOptions = useCallback(async (): Promise<void> => {
    const requestId = ++existingRequestIdRef.current;
    setLoadingExisting(true);
    setErrorMessage(null);
    setSelectedExisting(null);
    try {
      const response = await window.api.listExistingWorktreeJoinOptions({
        sourceWorkspaceId,
        sourceWorktreeId,
      });
      if (!mountedRef.current || existingRequestIdRef.current !== requestId) {
        return;
      }
      setExistingGroups(response.groups);
    } catch (cause: unknown) {
      if (!mountedRef.current || existingRequestIdRef.current !== requestId) {
        return;
      }
      setExistingGroups([]);
      setErrorMessage(
        cause instanceof Error ? cause.message : 'Failed to load worktrees.',
      );
    } finally {
      if (mountedRef.current && existingRequestIdRef.current === requestId) {
        setLoadingExisting(false);
        setHasLoadedExisting(true);
      }
    }
  }, [sourceWorkspaceId, sourceWorktreeId]);

  // Lazily load the existing-worktree picker the first time it is shown, then
  // keep the result for the modal's lifetime. Switching pills never refetches;
  // the Refresh button is the only way to repopulate.
  const showExistingPicker = useCallback((): void => {
    setPickerMode('existing-worktrees');
    setErrorMessage(null);
    if (!hasLoadedExisting && !loadingExisting) {
      void loadExistingOptions();
    }
  }, [hasLoadedExisting, loadingExisting, loadExistingOptions]);

  const handleRefreshPicker = useCallback((): void => {
    if (pickerMode === 'new-worktrees') {
      void loadWorkspaceOptions();
    } else {
      void loadExistingOptions();
    }
  }, [pickerMode, loadWorkspaceOptions, loadExistingOptions]);

  const showModeToggle = sourceIsNonTempMultiRepo;
  const hasSelection =
    pickerMode === 'new-worktrees'
      ? selectedWorkspaceIds.length > 0
      : selectedExisting !== null;
  const selectedExistingWarnings = useMemo<string[]>(
    () => (selectedExisting ? getCandidateWarnings(selectedExisting) : []),
    [selectedExisting],
  );

  const handleToggleWorkspace = useCallback((workspaceId: string): void => {
    setSelectedWorkspaceIds((current) =>
      current.includes(workspaceId)
        ? current.filter((id) => id !== workspaceId)
        : [...current, workspaceId],
    );
  }, []);

  const handleCombine = useCallback(async (): Promise<void> => {
    if (submitting) return;
    if (selectedWorkspaceIds.length === 0) {
      setErrorMessage('Choose at least one project to combine with.');
      return;
    }
    setErrorMessage(null);
    setSubmitting(true);
    try {
      if (sharedRequired) return;
      // Flush any pending chat-tab persistence on the source so the migration
      // sees the latest state. Mirrors the chatStore migration contract.
      await flushWorktreeTabs(sourceWorkspaceId, sourceWorktreeId);

      const effectiveMode: AdhocMultiRepoMode = showModeToggle
        ? mode
        : 'temporary';

      const response = await combineWorktreeWithWorkspace({
        sourceWorkspaceId,
        sourceWorktreeId,
        joinWorkspaceIds: selectedWorkspaceIds,
        mode: effectiveMode,
      });

      if (!response) {
        // projectsStore set `worktreeError`; read it directly so we keep the
        // modal-local error area in sync with whatever the backend reported.
        const worktreeError = useProjectsStore.getState().worktreeError;
        setErrorMessage(worktreeError ?? 'Failed to combine projects.');
        return;
      }

      // `combineWorktreeWithWorkspace` has already refreshed projects, so the
      // destination row and its persisted owner are now known. Land in its
      // context, then activate it before potentially slow tab migration; defer
      // generic hydration so it cannot race and overwrite the migrated
      // destination state.
      const destinationVisible = await showDestinationContext(
        response.destinationWorkspaceId,
      );
      if (destinationVisible) {
        selectWorktree(
          response.destinationWorkspaceId,
          response.destinationWorktreeId,
          { deferTabLoad: true },
        );
      }

      if (response.removedSourceWorktree) {
        if (!destinationVisible) {
          clearConsumedWorktreeSelection(
            response.sourceWorkspaceId,
            response.sourceWorktreeId,
          );
        }
        await migrateWorktreeTabsToAdhocWorkspace(response);
      }

      addToast(
        effectiveMode === 'update-source-workspace'
          ? 'Project updated'
          : 'Created multi-repo worktree',
        'success',
        undefined,
        {
          projectId: response.destinationWorkspaceId,
          worktreeId: response.destinationWorktreeId,
        },
      );
      onClose();
    } catch (cause: unknown) {
      setErrorMessage(
        cause instanceof Error ? cause.message : 'Failed to combine projects.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    addToast,
    combineWorktreeWithWorkspace,
    flushWorktreeTabs,
    migrateWorktreeTabsToAdhocWorkspace,
    mode,
    sharedRequired,
    onClose,
    selectWorktree,
    selectedWorkspaceIds,
    showModeToggle,
    sourceWorkspaceId,
    sourceWorktreeId,
    submitting,
  ]);

  const handleJoinExisting = useCallback(async (): Promise<void> => {
    if (submitting || !selectedExisting) return;
    setErrorMessage(null);
    setSubmitting(true);
    try {
      // Flush pending chat-tab persistence on both consumed worktrees so the
      // migrations below see the latest state.
      await flushWorktreeTabs(sourceWorkspaceId, sourceWorktreeId);
      await flushWorktreeTabs(
        selectedExisting.workspaceId,
        selectedExisting.worktreeId,
      );

      const effectiveMode: AdhocMultiRepoMode = showModeToggle
        ? mode
        : 'temporary';
      const response = await combineWorktreeWithExistingWorktree({
        sourceWorkspaceId,
        sourceWorktreeId,
        joinWorkspaceId: selectedExisting.workspaceId,
        joinWorktreeId: selectedExisting.worktreeId,
        mode: effectiveMode,
      });
      if (!response) {
        const worktreeError = useProjectsStore.getState().worktreeError;
        setErrorMessage(worktreeError ?? 'Failed to join worktree.');
        return;
      }

      // Land in the destination's context, then make the resulting worktree
      // active as soon as it is visible there. The two source migrations can
      // hydrate and fork tabs afterward without delaying the visible selection.
      const destinationVisible = await showDestinationContext(
        response.destinationWorkspaceId,
      );
      if (destinationVisible) {
        selectWorktree(
          response.destinationWorkspaceId,
          response.destinationWorktreeId,
          { deferTabLoad: true },
        );
      }

      if (response.removedSourceWorktree) {
        if (!destinationVisible) {
          clearConsumedWorktreeSelection(
            response.sourceWorkspaceId,
            response.sourceWorktreeId,
          );
        }
        await migrateWorktreeTabsToAdhocWorkspace(response);
      }
      // The joined worktree is always consumed: run the same migration with
      // the joined side substituted in as the "source" of the move.
      const joined = response.joinedWorktree;
      if (!destinationVisible) {
        clearConsumedWorktreeSelection(joined.workspaceId, joined.worktreeId);
      }
      await migrateWorktreeTabsToAdhocWorkspace({
        ...response,
        sourceWorkspaceId: joined.workspaceId,
        sourceWorktreeId: joined.worktreeId,
        repoMappings: joined.repoMappings,
        selectedRepoIdRewrites: joined.selectedRepoIdRewrites,
        sourceRootRepoIdRewrite: joined.sourceRootRepoIdRewrite,
        filePathRewrites: joined.filePathRewrites,
        compatibilitySymlinks: joined.compatibilitySymlinks,
        removedTemporaryWorkspaceId: joined.removedTemporaryWorkspaceId,
      });
      addToast(
        effectiveMode === 'update-source-workspace'
          ? 'Project updated'
          : 'Joined worktree',
        'success',
        undefined,
        {
          projectId: response.destinationWorkspaceId,
          worktreeId: response.destinationWorktreeId,
        },
      );
      onClose();
    } catch (cause: unknown) {
      setErrorMessage(
        cause instanceof Error ? cause.message : 'Failed to join worktree.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    addToast,
    combineWorktreeWithExistingWorktree,
    flushWorktreeTabs,
    migrateWorktreeTabsToAdhocWorkspace,
    mode,
    onClose,
    selectWorktree,
    selectedExisting,
    showModeToggle,
    sourceWorkspaceId,
    sourceWorktreeId,
    submitting,
  ]);

  const selectedIds =
    pickerMode === 'new-worktrees'
      ? selectedWorkspaceIds
      : selectedExisting
        ? [selectedExisting.workspaceId]
        : [];
  const selectedSharedSources = [
    sourceWorkspace,
    ...selectedIds.map((id) => projects.find((project) => project.id === id)),
  ].filter((project) => project !== undefined);
  if (sharedRequired) {
    return (
      <DialogModal
        onClose={onClose}
        title="New shared multi-repo project"
        titleId="shared-multi-repo-title"
        maxWidth="xl"
      >
        <div className="space-y-4">
          <DesktopOrgSharedMultiRepoSetup
            mode="combine"
            onClose={onClose}
            sources={selectedSharedSources.map((project) => ({
              kind: 'workspace',
              id: project.id,
              name: project.name,
            }))}
            onOpenDestination={onOpenSharedDestination}
          />
        </div>
      </DialogModal>
    );
  }

  return (
    <DialogModal
      onClose={onClose}
      title="Add project"
      titleId="add-repo-to-worktree-title"
      maxWidth="xl"
    >
      <div
        className="space-y-4 text-s"
        data-testid="add-repo-to-worktree-modal"
      >
        <div className="flex items-center justify-between gap-2">
          <SegmentedControl<PickerMode>
            label="Worktrees to add"
            value={pickerMode}
            width="content"
            shape="capsule"
            options={PICKER_MODE_OPTIONS}
            onChange={(next) => {
              if (next === 'new-worktrees') {
                setPickerMode('new-worktrees');
                setErrorMessage(null);
              } else {
                showExistingPicker();
              }
            }}
          />
          <Tooltip label="Refresh">
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={handleRefreshPicker}
              disabled={
                pickerMode === 'new-worktrees'
                  ? loadingOptions
                  : loadingExisting
              }
              data-testid="add-repo-to-worktree-modal-refresh"
              aria-label="Refresh"
            >
              <RefreshSpinnerIcon
                spinning={
                  pickerMode === 'new-worktrees'
                    ? loadingOptions
                    : loadingExisting
                }
              />
            </Button>
          </Tooltip>
        </div>

        {pickerMode === 'new-worktrees' ? (
          <>
            <p className="text-xs fg-secondary">
              Choose one or more projects to combine with this worktree.{' '}
              {brandText.appName} will create a multi-repo worktree and keep the
              original path available with a compatibility symlink.
            </p>

            {loadingOptions ? (
              <div className="rounded-xl border bg-secondary/10 p-4">
                <Heading level={3} variant="title">
                  Loading projects
                </Heading>
                <p className="mt-1 text-xs fg-secondary">
                  Checking repo identities for eligible join targets.
                </p>
              </div>
            ) : workspaceOptions.length === 0 ? (
              <div
                className="rounded-xl border bg-secondary/10 p-4"
                data-testid="add-repo-to-worktree-modal-empty"
              >
                <Heading level={3} variant="title">
                  No eligible projects
                </Heading>
                <p className="mt-1 text-xs fg-secondary">
                  Add a project with at least one repo that is not already here.
                </p>
              </div>
            ) : (
              <WorkspaceMultiSelectPicker
                options={workspaceOptions}
                selectedWorkspaceIds={selectedWorkspaceIds}
                onToggleWorkspace={handleToggleWorkspace}
                searchQuery={searchQuery}
                onSearchQueryChange={setSearchQuery}
                testIdPrefix="add-repo-to-worktree-modal"
                listMaxHeightClassName="max-h-[40vh]"
              />
            )}
          </>
        ) : (
          <>
            <p className="text-xs fg-secondary">
              Choose a worktree to join into this one. Its changes move into a
              combined worktree and the original paths stay valid via
              compatibility symlinks.
            </p>

            {loadingExisting || !hasLoadedExisting ? (
              <div className="rounded-xl border bg-secondary/10 p-4">
                <Heading level={3} variant="title">
                  Loading worktrees
                </Heading>
                <p className="mt-1 text-xs fg-secondary">
                  Checking other projects for joinable worktrees.
                </p>
              </div>
            ) : existingGroups.length === 0 ? (
              <div
                className="rounded-xl border bg-secondary/10 p-4"
                data-testid="add-repo-to-worktree-modal-existing-empty"
              >
                <Heading level={3} variant="title">
                  No worktrees to join
                </Heading>
                <p className="mt-1 text-xs fg-secondary">
                  Create a worktree in another project first, then join it into
                  this one.
                </p>
              </div>
            ) : (
              <ExistingWorktreePicker
                groups={existingGroups}
                selected={
                  selectedExisting
                    ? {
                        workspaceId: selectedExisting.workspaceId,
                        worktreeId: selectedExisting.worktreeId,
                      }
                    : null
                }
                onSelect={setSelectedExisting}
                searchQuery={existingSearchQuery}
                onSearchQueryChange={setExistingSearchQuery}
              />
            )}

            {selectedExisting && selectedExistingWarnings.length > 0 && (
              <Notice
                role="none"
                intent="attention"
                data-testid="add-repo-to-worktree-modal-overlap-warnings"
              >
                <div className="space-y-1">
                  {selectedExistingWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              </Notice>
            )}
          </>
        )}

        {showModeToggle && hasSelection && (
          <div className="rounded-xl border bg-secondary/10 p-3">
            <span className="block text-xs fg-secondary">Update mode</span>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                onClick={() => setMode('temporary')}
                aria-pressed={mode === 'temporary'}
                className={`focus-ring flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                  mode === 'temporary'
                    ? 'border-line-accent bg-accent-subtle fg-primary'
                    : 'bg-base fg-secondary hover:fg-primary'
                }`}
                data-testid="add-repo-to-worktree-modal-mode-temporary"
              >
                <span className="block text-s font-medium">Temporary</span>
                <span className="mt-1 block text-xs fg-secondary">
                  Create or reuse a temporary multi-repo project for this
                  worktree only.
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMode('update-source-workspace')}
                aria-pressed={mode === 'update-source-workspace'}
                className={`focus-ring flex-1 rounded-lg border px-3 py-2 text-left transition-colors ${
                  mode === 'update-source-workspace'
                    ? 'border-line-accent bg-accent-subtle fg-primary'
                    : 'bg-base fg-secondary hover:fg-primary'
                }`}
                data-testid="add-repo-to-worktree-modal-mode-update"
              >
                <span className="block text-s font-medium">Update project</span>
                <span className="mt-1 block text-xs fg-secondary">
                  Add missing repos to this project and this worktree.
                </span>
              </button>
            </div>
          </div>
        )}

        {errorMessage && (
          <Notice
            intent="destructive"
            data-testid="add-repo-to-worktree-modal-error"
          >
            {/* The full message: this box has no details view. Command
                output can name paths and branches. */}
            <span
              className={`${POSTHOG_REPLAY_BLOCK_CLASS} block max-h-40 overflow-y-auto whitespace-pre-wrap break-words`}
            >
              {errorMessage}
            </span>
          </Notice>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            size="compact"
            onClick={onClose}
            disabled={submitting}
            data-testid="add-repo-to-worktree-modal-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={() =>
              void (pickerMode === 'new-worktrees'
                ? handleCombine()
                : handleJoinExisting())
            }
            disabled={
              submitting ||
              (pickerMode === 'new-worktrees'
                ? loadingOptions ||
                  workspaceOptions.length === 0 ||
                  selectedWorkspaceIds.length === 0
                : loadingExisting || !selectedExisting)
            }
            data-testid="add-repo-to-worktree-modal-submit"
          >
            {pickerMode === 'new-worktrees'
              ? submitting
                ? 'Combining…'
                : 'Combine'
              : submitting
                ? 'Joining…'
                : 'Join worktree'}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
