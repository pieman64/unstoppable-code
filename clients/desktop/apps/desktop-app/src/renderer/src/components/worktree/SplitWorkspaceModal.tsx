import { Heading } from '@canopy/ui-shared/components';
import { Button } from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/shallow';
import {
  WORKSPACE_ROOT_REPO_ID,
  type SplitTemporaryWorkspaceItemSummary,
  type SplitTemporaryWorkspaceItemSummaryEntry,
  type SplitTemporaryWorkspacePreviewResponse,
  type SplitTemporaryWorkspaceSelection,
} from '@canopy/desktop-shared/types';
import { ErrorBanner, RichHoverTooltip } from '@canopy/ui-shared/components';
import {
  ArchiveIcon,
  ChatIcon,
  PipelineIcon,
  PlansIcon,
  SplitIcon,
  TrashIcon,
  AttachmentIcon as AppCatalogAttachmentIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useChatStore } from '@/stores/chatStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { ActionTooltip } from '@/components/shared/ActionTooltip';
import { RefreshSpinner } from '@/components/shared/loading';
import { DialogModal } from '../shared';
import { DiffBadge } from './DiffBadge';
import { Tooltip } from '@canopy/ui-shared';

interface SplitWorkspaceModalProps {
  /** Temporary multi-repo workspace that owns the worktree being split. */
  workspaceId: string;
  /** Worktree whose child repos are split back into single-repo worktrees. */
  worktreeId: string;
  onClose: () => void;
}

/** Paperclip glyph for the root attachments counter (no AppIcons export). */
function AttachmentGlyph(): JSX.Element {
  return <AppCatalogAttachmentIcon className="h-3.5 w-3.5" aria-hidden />;
}

/** Duplicate titles ("New Chat") get occurrence-suffixed React keys. */
function disambiguateEntries(
  entries: SplitTemporaryWorkspaceItemSummaryEntry[],
): Array<{ key: string; entry: SplitTemporaryWorkspaceItemSummaryEntry }> {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const occurrence = (seen.get(entry.title) ?? 0) + 1;
    seen.set(entry.title, occurrence);
    return { key: `${entry.title}#${occurrence}`, entry };
  });
}

/**
 * The item counter's hover list: up to the summary's included titles with an
 * "N more…" tail, on the shared rich hover surface.
 */
function ItemListContent({
  heading,
  entries,
  moreCount,
}: {
  heading: string;
  entries: SplitTemporaryWorkspaceItemSummaryEntry[];
  moreCount: number;
}): JSX.Element {
  return (
    <>
      <div className="mb-1 text-3xs font-semibold fg-secondary">{heading}</div>
      <div className="space-y-1.5">
        {disambiguateEntries(entries).map(({ key, entry }) => (
          <div
            key={key}
            className="flex items-center gap-1.5 text-xs fg-primary"
          >
            {entry.archived === true && (
              <span
                className="shrink-0 fg-secondary"
                data-testid="split-workspace-modal-tooltip-archived"
              >
                <ArchiveIcon className="h-3 w-3" />
              </span>
            )}
            <span className="truncate">{entry.title}</span>
          </div>
        ))}
        {moreCount > 0 && (
          <div className="text-3xs fg-secondary">{moreCount} more…</div>
        )}
      </div>
    </>
  );
}

/** One icon+count counter with the hover list. Hidden when empty. */
interface ItemCounterProps {
  icon: ReactNode;
  heading: string;
  summary: SplitTemporaryWorkspaceItemSummary;
  testId: string;
}

function ItemCounter({
  icon,
  heading,
  summary,
  testId,
}: ItemCounterProps): JSX.Element | null {
  if (summary.count === 0) {
    return null;
  }
  return (
    <RichHoverTooltip
      content={
        <ItemListContent
          heading={heading}
          entries={summary.entries}
          moreCount={summary.count - summary.entries.length}
        />
      }
      elevation="menu"
      surfacePadding="card"
      surfaceClassName="min-w-50 max-w-75"
    >
      <span
        className="inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums fg-secondary"
        data-testid={testId}
      >
        {icon}
        {summary.count}
      </span>
    </RichHoverTooltip>
  );
}

/** Icon toggle: Split (accent when selected), Archive, Delete (destructive). */
interface SelectionToggleButtonProps {
  kind: 'split' | 'archive' | 'delete';
  selected: boolean;
  onSelect: () => void;
  tooltipTitle: string;
  tooltipDescription: string;
  testId: string;
  disabled?: boolean;
}

function SelectionToggleButton({
  kind,
  selected,
  onSelect,
  tooltipTitle,
  tooltipDescription,
  testId,
  disabled = false,
}: SelectionToggleButtonProps): JSX.Element {
  const Icon =
    kind === 'split' ? SplitIcon : kind === 'archive' ? ArchiveIcon : TrashIcon;
  // At rest every choice is quiet; the chosen one takes its kind's tone and,
  // through `pressedHover`, keeps that tone's hover fill while pressed.
  const variant = !selected
    ? 'ghost-quiet'
    : kind === 'split'
      ? 'ghost-accent'
      : kind === 'delete'
        ? 'ghost-destructive'
        : 'ghost';
  return (
    <ActionTooltip title={tooltipTitle} description={tooltipDescription}>
      <Button
        variant={variant}
        size="sm"
        iconOnly
        pressedHover
        disabled={disabled}
        aria-pressed={selected}
        aria-label={tooltipTitle}
        onClick={onSelect}
        data-testid={testId}
        data-selected={selected ? 'true' : 'false'}
      >
        <Icon className="h-4 w-4" />
      </Button>
    </ActionTooltip>
  );
}

/**
 * Fire-and-forget confirm path. Lives outside the component because the modal
 * closes the instant the user confirms — the fast split phase, navigation,
 * and error surfacing must not depend on the (unmounted) component. Errors
 * land as toasts; the background phase's outcome is handled globally by the
 * projectsStore split-complete subscription.
 */
async function performSplitConfirm(
  workspaceId: string,
  worktreeId: string,
  selections: Record<string, SplitTemporaryWorkspaceSelection>,
  rootAction: 'archive' | 'delete' | undefined,
  previewRevision: string,
): Promise<void> {
  try {
    const { approvalToken } =
      await window.api.approveSplitTemporaryWorkspaceDestructiveAction({
        workspaceId,
        worktreeId,
        selections,
        previewRevision,
        ...(rootAction ? { rootAction } : {}),
      });
    const response = await useProjectsStore
      .getState()
      .splitTemporaryWorkspaceWorktree(
        workspaceId,
        worktreeId,
        selections,
        rootAction,
        approvalToken ?? undefined,
        previewRevision,
      );

    const target = response.navigationTarget;
    const navigate = useNavigationStore.getState().navigate;
    if (target.kind === 'worktree') {
      navigate('main');
      useChatStore
        .getState()
        .selectWorktree(target.workspaceId, target.worktreeId);
    } else if (target.kind === 'workspace') {
      navigate('main');
    } else {
      navigate('home');
    }
  } catch (cause: unknown) {
    useGitHubStore
      .getState()
      .addToast(
        cause instanceof Error ? cause.message : 'Failed to split project.',
        'error',
        undefined,
        { projectId: workspaceId, worktreeId },
      );
  }
}

/** "Split X, Archive Y and Delete Z" — only the non-zero parts. */
function buildConfirmLabel(
  splitCount: number,
  archiveCount: number,
  deleteCount: number,
): string {
  const parts: string[] = [];
  if (splitCount > 0) parts.push(`Split ${splitCount}`);
  if (archiveCount > 0) parts.push(`Archive ${archiveCount}`);
  if (deleteCount > 0) parts.push(`Delete ${deleteCount}`);
  if (parts.length === 0) return 'Split project';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Confirmation modal for splitting a temporary multi-repo workspace worktree
 * back into per-repo single-repo worktrees.
 *
 * The repo list renders instantly from the workspace's sidebar record; the
 * destination mapping and item ownership (the slow part) load in the
 * background and enrich the rows in place — per-repo diff stats plus
 * chat/pipeline/plan counters whose hover popovers list what travels with
 * each repo. When items are tied to the workspace root (root-scoped chats,
 * pipelines, plans, attachments, or physical root files), a leading
 * "Project root" row offers Archive or Delete.
 * Row actions are icon toggles with tooltips; the confirm button stays
 * verbose ("Split X, Archive Y and Delete Z") and turns destructive when any
 * hard delete is selected. Confirming closes the modal immediately — the
 * split continues in the background with optimistic UI updates.
 */
export function SplitWorkspaceModal({
  workspaceId,
  worktreeId,
  onClose,
}: SplitWorkspaceModalProps): JSX.Element {
  const { project, repoBranches } = useProjectsStore(
    useShallow((state) => ({
      project: state.projects.find((candidate) => candidate.id === workspaceId),
      repoBranches:
        state.repoBranches[createDiffStatsKey(workspaceId, worktreeId)],
    })),
  );
  const addToast = useGitHubStore((state) => state.addToast);

  // Instant row source: the workspace's configured repos. The preview below
  // only adds destination names, removal modes, and item counters.
  const repos = useMemo(
    () =>
      project?.type === 'multi-repo'
        ? project.repos.filter((repo) => repo.id !== WORKSPACE_ROOT_REPO_ID)
        : [],
    [project],
  );

  // Per-repo diff stats scoped to this worktree's child checkouts, from the
  // same aggregate refresh that feeds the sidebar row badge.
  const repoStatsById = useMemo(() => {
    const statsById = new Map<
      string,
      { insertions: number; deletions: number }
    >();
    for (const repoBranch of repoBranches ?? []) {
      if (
        repoBranch.insertions !== undefined ||
        repoBranch.deletions !== undefined
      ) {
        statsById.set(repoBranch.repoId, {
          insertions: repoBranch.insertions ?? 0,
          deletions: repoBranch.deletions ?? 0,
        });
      }
    }
    return statsById;
  }, [repoBranches]);

  useEffect(() => {
    void useProjectsStore
      .getState()
      .refreshWorktreeDiffStats(workspaceId, worktreeId);
  }, [workspaceId, worktreeId]);

  const [preview, setPreview] =
    useState<SplitTemporaryWorkspacePreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selections, setSelections] = useState<
    Record<string, SplitTemporaryWorkspaceSelection>
  >({});
  const [rootSelection, setRootSelection] = useState<'archive' | 'delete'>(
    'delete',
  );
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        // The preview revision covers the persisted chat inventory. Flush the
        // source tabs first so confirmation cannot approve a revision that the
        // execution path's own flush immediately invalidates.
        await useChatStore
          .getState()
          .flushWorktreeTabs(workspaceId, worktreeId);
        const response = await window.api.previewSplitTemporaryWorkspace({
          workspaceId,
          worktreeId,
        });
        if (cancelled) return;
        setPreview(response);
        setRootSelection(response.root.canArchive ? 'archive' : 'delete');
      } catch (cause: unknown) {
        if (cancelled) return;
        setPreviewError(
          cause instanceof Error
            ? cause.message
            : 'Failed to load destination projects.',
        );
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [workspaceId, worktreeId]);

  const previewLoaded = preview !== null;
  const previewByRepoId = useMemo(() => {
    const byRepoId = new Map<
      string,
      NonNullable<SplitTemporaryWorkspacePreviewResponse['repos']>[number]
    >();
    for (const repo of preview?.repos ?? []) {
      byRepoId.set(repo.repoId, repo);
    }
    return byRepoId;
  }, [preview]);
  const root = preview?.root;
  const rootPresent = root?.present === true;

  const selectionOf = useCallback(
    (repoId: string): SplitTemporaryWorkspaceSelection =>
      selections[repoId] ?? 'split',
    [selections],
  );

  // While the mapping loads, removals count as Archive (the safe default the
  // toggles also display); Delete counts only exist once modes are known.
  const { splitCount, archiveCount, deleteCount } = useMemo(() => {
    let split = 0;
    let archive = 0;
    let toDelete = 0;
    for (const repo of repos) {
      if (selectionOf(repo.id) === 'split') {
        split += 1;
      } else if (previewByRepoId.get(repo.id)?.removalMode === 'delete') {
        toDelete += 1;
      } else {
        archive += 1;
      }
    }
    if (rootPresent) {
      if (rootSelection === 'archive') {
        archive += 1;
      } else {
        toDelete += 1;
      }
    }
    return { splitCount: split, archiveCount: archive, deleteCount: toDelete };
  }, [repos, selectionOf, previewByRepoId, rootPresent, rootSelection]);

  useCurrentUiStateReporter('worktree.splitWorkspaceModal', {
    open: true,
    workspaceId,
    worktreeId,
    repoCount: repos.length,
    splitCount,
    archiveCount,
    deleteCount,
    rootRowVisible: rootPresent,
    rootSelection,
    destinationsLoaded: previewLoaded,
    errorVisible: previewError !== null,
  });

  const setSelection = useCallback(
    (repoId: string, selection: SplitTemporaryWorkspaceSelection): void => {
      setSelections((current) => ({ ...current, [repoId]: selection }));
    },
    [],
  );

  const handleConfirm = useCallback((): void => {
    if (confirmed || !preview || repos.length === 0) return;
    setConfirmed(true);
    // Eagerly drop the user onto the planned destination page right now —
    // main for a split/archive destination (the concrete reserved worktree is
    // selected in its "setting up" state as soon as the fast phase returns),
    // home when nothing survives the split.
    const anySurvivingDestination =
      (rootPresent && rootSelection === 'archive') ||
      repos.some(
        (repo) =>
          selectionOf(repo.id) === 'split' ||
          (previewByRepoId.get(repo.id)?.removalMode ?? 'archive') ===
            'archive',
      );
    useNavigationStore
      .getState()
      .navigate(anySurvivingDestination ? 'main' : 'home');
    // Close immediately; the fast split phase, destination selection, and any
    // errors continue outside the component (toasts + the global
    // split-complete subscription).
    onClose();
    void performSplitConfirm(
      workspaceId,
      worktreeId,
      { ...selections },
      rootPresent ? rootSelection : undefined,
      preview.previewRevision,
    );
  }, [
    confirmed,
    onClose,
    previewByRepoId,
    preview,
    repos,
    rootPresent,
    rootSelection,
    selectionOf,
    selections,
    workspaceId,
    worktreeId,
  ]);

  // The workspace disappearing under the modal (e.g. split finished from
  // another surface) leaves nothing to configure.
  useEffect(() => {
    if (!project && !confirmed) {
      addToast('This project is no longer available.', 'error');
      onClose();
    }
  }, [project, confirmed, addToast, onClose]);

  const confirmLabel = buildConfirmLabel(splitCount, archiveCount, deleteCount);
  const confirmDisabled =
    confirmed || !previewLoaded || repos.length === 0 || previewError !== null;

  return (
    <DialogModal
      onClose={onClose}
      title="Split project"
      titleId="split-workspace-title"
      maxWidth="xl"
    >
      <div className="space-y-4 text-s" data-testid="split-workspace-modal">
        <p className="text-xs fg-secondary">
          Splitting moves each kept repo&apos;s checkout — along with its chats,
          workflow runs and plans — into a new worktree in that repo&apos;s own
          single-repo project. Repos you don&apos;t keep are archived or
          deleted, following each destination project&apos;s archive settings.
          This temporary project disappears once its last worktree is gone.
        </p>

        {repos.length === 0 ? (
          <div
            className="rounded-xl border bg-secondary/10 p-4"
            data-testid="split-workspace-modal-empty"
          >
            <Heading level={3} variant="title">
              No repos to split
            </Heading>
          </div>
        ) : (
          <div className="space-y-2">
            {rootPresent && root && (
              <div
                className="flex items-center justify-between gap-3 rounded-xl border bg-secondary/10 px-3 py-2"
                data-testid="split-workspace-modal-root"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-s font-medium fg-primary">
                      Project root
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-2">
                      <ItemCounter
                        icon={<ChatIcon className="h-3.5 w-3.5" />}
                        heading="Chats"
                        summary={root.chats}
                        testId="split-workspace-modal-root-chats"
                      />
                      <ItemCounter
                        icon={<PipelineIcon className="h-3.5 w-3.5" />}
                        heading="Workflow runs"
                        summary={root.pipelines}
                        testId="split-workspace-modal-root-pipelines"
                      />
                      <ItemCounter
                        icon={<PlansIcon className="h-3.5 w-3.5" />}
                        heading="Plans"
                        summary={root.plans}
                        testId="split-workspace-modal-root-plans"
                      />
                      <ItemCounter
                        icon={<AttachmentGlyph />}
                        heading="Attachments"
                        summary={root.attachments}
                        testId="split-workspace-modal-root-attachments"
                      />
                    </span>
                  </div>
                  <div
                    className="truncate text-xs fg-secondary"
                    data-testid="split-workspace-modal-root-destination"
                  >
                    {rootSelection === 'archive'
                      ? 'Archives the project root contents as an archived entry'
                      : 'Project root contents are deleted permanently'}
                  </div>
                </div>
                <div className="inline-flex shrink-0 items-center gap-1 rounded-lg border p-1">
                  <SelectionToggleButton
                    kind="archive"
                    selected={rootSelection === 'archive'}
                    onSelect={() => setRootSelection('archive')}
                    tooltipTitle="Archive"
                    tooltipDescription={
                      root.canArchive
                        ? 'Keep the project root contents as an archived entry'
                        : 'Archive retention is disabled for this project'
                    }
                    testId="split-workspace-modal-root-archive"
                    disabled={!root.canArchive}
                  />
                  <SelectionToggleButton
                    kind="delete"
                    selected={rootSelection === 'delete'}
                    onSelect={() => setRootSelection('delete')}
                    tooltipTitle="Delete"
                    tooltipDescription="Delete the project root contents permanently"
                    testId="split-workspace-modal-root-delete"
                  />
                </div>
              </div>
            )}
            {repos.map((repo) => {
              const selection = selectionOf(repo.id);
              const repoPreview = previewByRepoId.get(repo.id);
              const removalMode = repoPreview?.removalMode ?? 'archive';
              const destinationName =
                repoPreview?.destinationWorkspaceName ?? repo.name;
              const repoStats = repoStatsById.get(repo.id);
              return (
                <div
                  key={repo.id}
                  className="flex items-center justify-between gap-3 rounded-xl border bg-secondary/10 px-3 py-2"
                  data-testid={`split-workspace-modal-repo-${repo.id}`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-s font-medium fg-primary">
                        {repo.name}
                      </span>
                      {repoStats && (
                        <span
                          className="shrink-0"
                          data-testid={`split-workspace-modal-repo-${repo.id}-diff`}
                        >
                          <DiffBadge compact stats={repoStats} />
                        </span>
                      )}
                      {repoPreview && (
                        <span className="inline-flex shrink-0 items-center gap-2">
                          <ItemCounter
                            icon={<ChatIcon className="h-3.5 w-3.5" />}
                            heading="Chats"
                            summary={repoPreview.chats}
                            testId={`split-workspace-modal-repo-${repo.id}-chats`}
                          />
                          <ItemCounter
                            icon={<PipelineIcon className="h-3.5 w-3.5" />}
                            heading="Workflow runs"
                            summary={repoPreview.pipelines}
                            testId={`split-workspace-modal-repo-${repo.id}-pipelines`}
                          />
                          <ItemCounter
                            icon={<PlansIcon className="h-3.5 w-3.5" />}
                            heading="Plans"
                            summary={repoPreview.plans}
                            testId={`split-workspace-modal-repo-${repo.id}-plans`}
                          />
                        </span>
                      )}
                    </div>
                    <div
                      className="truncate text-xs fg-secondary"
                      data-testid={`split-workspace-modal-repo-${repo.id}-destination`}
                    >
                      {!repoPreview ? (
                        <span className="inline-flex items-center gap-1.5">
                          <RefreshSpinner spinning size={12} />
                          Resolving destination project…
                        </span>
                      ) : selection === 'split' ? (
                        repoPreview.destinationWorkspaceId ? (
                          `Moves to project "${destinationName}"`
                        ) : (
                          `Creates project "${destinationName}"`
                        )
                      ) : removalMode === 'archive' ? (
                        `Archives in project "${destinationName}"`
                      ) : (
                        'Deleted permanently'
                      )}
                    </div>
                  </div>
                  <div className="inline-flex shrink-0 items-center gap-1 rounded-lg border p-1">
                    <SelectionToggleButton
                      kind="split"
                      selected={selection === 'split'}
                      onSelect={() => setSelection(repo.id, 'split')}
                      tooltipTitle="Split"
                      tooltipDescription={`Move to its own worktree in "${destinationName}"`}
                      testId={`split-workspace-modal-repo-${repo.id}-split`}
                    />
                    <SelectionToggleButton
                      kind={removalMode}
                      selected={selection === 'remove'}
                      onSelect={() => setSelection(repo.id, 'remove')}
                      tooltipTitle={
                        removalMode === 'archive' ? 'Archive' : 'Delete'
                      }
                      tooltipDescription={
                        removalMode === 'archive'
                          ? `Archive in project "${destinationName}"`
                          : 'Delete this repo checkout permanently'
                      }
                      testId={`split-workspace-modal-repo-${repo.id}-remove`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <ErrorBanner
          error={previewError}
          className=""
          testId="split-workspace-modal-error"
        />

        <div className="flex items-center justify-end gap-2 pt-1">
          {!previewLoaded && previewError === null && repos.length > 0 && (
            <span
              className="mr-auto inline-flex items-center gap-1.5 text-xs fg-secondary"
              data-testid="split-workspace-modal-loading"
            >
              <RefreshSpinner spinning size={12} />
              Loading destination projects…
            </span>
          )}
          <Button
            size="compact"
            onClick={onClose}
            data-testid="split-workspace-modal-cancel"
          >
            Cancel
          </Button>
          <Tooltip
            label="Waiting for destination projects to load"
            suppressed={previewLoaded || previewError !== null}
          >
            <Button
              variant={deleteCount > 0 ? 'destructive' : 'primary'}
              size="compact"
              onClick={handleConfirm}
              disabled={confirmDisabled}
              data-testid="split-workspace-modal-confirm"
              data-danger={deleteCount > 0 ? 'true' : 'false'}
            >
              {confirmLabel}
            </Button>
          </Tooltip>
        </div>
      </div>
    </DialogModal>
  );
}
