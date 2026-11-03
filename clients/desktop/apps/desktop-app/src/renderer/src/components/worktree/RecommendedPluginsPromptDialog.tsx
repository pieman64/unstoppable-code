import { Button } from '@canopy/ui-shared/components';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  RecommendedPluginApplyResult,
  RecommendedPluginItem,
} from '@canopy/desktop-shared/types';
import { DialogModal } from '../shared';
import {
  useProjectsStore,
  type PendingRecommendedPluginPrompt,
} from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { pipelinePackageRequirementKindLabel } from '@canopy/ui-shared/lib/pipeline-package-display';
import { Checkbox } from '@canopy/ui-shared/components';

interface RecommendedPluginsPromptDialogProps {
  prompt: PendingRecommendedPluginPrompt;
}

/**
 * Per-row UI status. Combines "what will happen if applied" with terminal
 * "what happened" labels so the dialog can render a single label per row.
 */
type RowStatus =
  | { state: 'pending-select' }
  | { state: 'pending-install-and-select' }
  | { state: 'installing' }
  | { state: 'selected' }
  | { state: 'installed-and-selected' }
  | { state: 'error'; message: string };

interface ActionableEntry {
  item: RecommendedPluginItem;
}

function isActionable(item: RecommendedPluginItem): boolean {
  return item.action === 'select' || item.action === 'install-and-select';
}

function pendingLabelForItem(item: RecommendedPluginItem): RowStatus {
  if (item.action === 'select') {
    return { state: 'pending-select' };
  }
  return { state: 'pending-install-and-select' };
}

function describeStatus(status: RowStatus): string {
  switch (status.state) {
    case 'pending-select':
      return 'Will select by default';
    case 'pending-install-and-select':
      return 'Will install and select by default';
    case 'installing':
      return 'Installing…';
    case 'selected':
      return 'Selected';
    case 'installed-and-selected':
      return 'Installed and selected';
    case 'error':
      return `Failed: ${status.message}`;
  }
}

const TERMINAL_STATES: ReadonlySet<RowStatus['state']> = new Set<
  RowStatus['state']
>(['selected', 'installed-and-selected', 'error']);

/**
 * Post-create / scope-change recommendation prompt for source-controlled
 * `canopy.json.plugins` recommendations. The dialog is mounted globally by
 * `WorktreeManager` whenever `pendingRecommendedPluginPrompt` is non-null;
 * dismissing or applying clears that store field via the corresponding
 * actions.
 */
export function RecommendedPluginsPromptDialog({
  prompt,
}: RecommendedPluginsPromptDialogProps): JSX.Element {
  const applyRecommendedPlugins = useProjectsStore(
    (state) => state.applyRecommendedPlugins,
  );
  const dismissPendingRecommendedPluginPrompt = useProjectsStore(
    (state) => state.dismissPendingRecommendedPluginPrompt,
  );
  const openSettings = useNavigationStore((state) => state.openSettings);
  const openPluginsNavigation = useNavigationStore(
    (state) => state.openPluginsNavigation,
  );

  const actionable = useMemo<ActionableEntry[]>(
    () => prompt.items.filter(isActionable).map((item) => ({ item })),
    [prompt.items],
  );
  const informational = useMemo(
    () => prompt.items.filter((item) => !isActionable(item)),
    [prompt.items],
  );

  // Default every actionable row checked. Most users want the full set.
  const [checked, setChecked] = useState<Set<string>>(() => {
    const next = new Set<string>();
    for (const entry of actionable) {
      next.add(entry.item.key);
    }
    return next;
  });
  // Re-seed checked when the prompt items change (e.g., re-inspection after
  // a partial failure replaces the prompt with the latest state).
  useEffect(() => {
    setChecked(() => {
      const next = new Set<string>();
      for (const entry of actionable) {
        next.add(entry.item.key);
      }
      return next;
    });
  }, [actionable]);

  const [rowStatuses, setRowStatuses] = useState<Record<string, RowStatus>>({});
  const [applying, setApplying] = useState(false);
  const [hasErrors, setHasErrors] = useState(false);

  const handleDismissClose = useCallback((): void => {
    if (applying) {
      return;
    }
    dismissPendingRecommendedPluginPrompt({ remember: true });
  }, [applying, dismissPendingRecommendedPluginPrompt]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !applying) {
        handleDismissClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return (): void => document.removeEventListener('keydown', onKeyDown);
  }, [handleDismissClose, applying]);

  function toggleChecked(key: string): void {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const checkedCount = useMemo(
    () =>
      actionable.reduce(
        (count, entry) => (checked.has(entry.item.key) ? count + 1 : count),
        0,
      ),
    [actionable, checked],
  );

  const allChecked = checkedCount === actionable.length;
  const noneChecked = checkedCount === 0;

  async function runApply(opts: { skip: boolean }): Promise<void> {
    if (applying) {
      return;
    }
    const { skip } = opts;
    const selectedKeys: string[] = [];
    const optOutKeys: string[] = [];
    for (const entry of actionable) {
      if (!skip && checked.has(entry.item.key)) {
        selectedKeys.push(entry.item.key);
      } else {
        optOutKeys.push(entry.item.key);
      }
    }

    setApplying(true);
    setHasErrors(false);

    // Mark all selected rows as installing/selecting up front so the dialog
    // gives immediate feedback. Rows that aren't in `selectedKeys` are left
    // untouched (their status reflects the prior render).
    setRowStatuses((current) => {
      const next: Record<string, RowStatus> = { ...current };
      for (const entry of actionable) {
        if (!selectedKeys.includes(entry.item.key)) {
          continue;
        }
        next[entry.item.key] =
          entry.item.action === 'install-and-select'
            ? { state: 'installing' }
            : { state: 'selected' };
      }
      return next;
    });

    let results: RecommendedPluginApplyResult[] = [];
    try {
      const response = await applyRecommendedPlugins({
        projectId: prompt.projectId,
        worktreeId: prompt.worktreeId,
        repoId: prompt.repoId,
        selectedKeys,
        optOutKeys,
        dismissPromptOnSuccess: true,
      });
      results = response.results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRowStatuses((current) => {
        const next: Record<string, RowStatus> = { ...current };
        for (const key of selectedKeys) {
          next[key] = { state: 'error', message };
        }
        return next;
      });
      setHasErrors(true);
      setApplying(false);
      return;
    }

    let nextHasErrors = false;
    setRowStatuses((current) => {
      const next: Record<string, RowStatus> = { ...current };
      for (const result of results) {
        if (result.status === 'installed-and-selected') {
          next[result.key] = { state: 'installed-and-selected' };
        } else if (result.status === 'selected') {
          next[result.key] = { state: 'selected' };
        } else if (result.status === 'error') {
          nextHasErrors = true;
          next[result.key] = {
            state: 'error',
            message: result.message ?? 'Failed to apply recommendation.',
          };
        }
      }
      return next;
    });
    setHasErrors(nextHasErrors);
    setApplying(false);
  }

  function handleAskMeLater(): void {
    handleDismissClose();
  }

  const primaryLabel = applying
    ? 'Applying…'
    : hasErrors
      ? 'Try again'
      : noneChecked
        ? 'Skip recommendations'
        : 'Apply selected';

  return (
    <DialogModal
      onClose={(): void => {
        handleDismissClose();
      }}
      title="Recommended plugins"
      subtitle={prompt.scopeLabel}
      titleId="recommended-plugins-prompt-dialog-title"
      maxWidth="2xl"
      closeOnBackdrop={!applying}
    >
      <div className="flex flex-col gap-4 text-s fg-primary">
        <p className="text-xs fg-secondary">
          This project&apos;s canopy.json recommends plugins or skills that are
          not installed or selected as project defaults. Keep items checked to
          install/select them by default. Unchecked items will not be suggested
          again for this project.
        </p>

        {actionable.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {actionable.map((entry) => {
              const { item } = entry;
              const status: RowStatus =
                rowStatuses[item.key] ?? pendingLabelForItem(item);
              const isChecked = checked.has(item.key);
              const checkboxDisabled =
                applying || TERMINAL_STATES.has(status.state);
              return (
                <li
                  key={item.key}
                  className="flex items-start gap-3 p-3 text-xs"
                >
                  <Checkbox
                    checked={isChecked}
                    disabled={checkboxDisabled}
                    onChange={(): void => toggleChecked(item.key)}
                    className="mt-0.5"
                    aria-label={`Apply ${item.displayName}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium fg-primary">
                        {item.displayName}
                      </span>
                      <span className="rounded-full border px-1.5 py-0.5 text-3xs fg-secondary">
                        {item.kind === 'claude_plugin' ? 'plugin' : item.kind}
                      </span>
                    </div>
                    <div className="mt-0.5 fg-secondary">
                      {item.displaySource}
                    </div>
                    <div
                      className={`mt-1 text-2xs ${
                        status.state === 'error'
                          ? 'fg-destructive-strong'
                          : status.state === 'selected' ||
                              status.state === 'installed-and-selected'
                            ? 'fg-success-strong'
                            : 'fg-secondary'
                      }`}
                    >
                      {describeStatus(status)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {informational.length > 0 && (
          <div className="space-y-2">
            <div className="text-2xs font-medium fg-secondary">
              Already configured
            </div>
            <ul className="divide-y rounded-lg border">
              {informational.map((item) => (
                <li key={item.key} className="p-3 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium fg-primary">
                      {item.displayName}
                    </span>
                    <span className="rounded-full border px-1.5 py-0.5 text-3xs fg-secondary">
                      {item.kind === 'claude_plugin' ? 'plugin' : item.kind}
                    </span>
                  </div>
                  <div className="mt-0.5 fg-secondary">
                    {item.displaySource}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {prompt.requirements.length > 0 && (
          <section
            className="space-y-2 rounded-lg border p-3"
            data-testid="recommended-plugin-requirements"
          >
            <h3 className="text-xs font-medium fg-primary">
              Environment setup
            </h3>
            <ul className="space-y-2">
              {prompt.requirements.map((requirement) => (
                <li
                  key={requirement.id}
                  className="flex items-start justify-between gap-3 text-xs"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium fg-primary">
                        {requirement.displayName}
                      </span>
                      <span className="fg-secondary">
                        {pipelinePackageRequirementKindLabel(requirement.kind)}
                      </span>
                      <span className="rounded-full border px-1.5 py-0.5 text-3xs fg-secondary">
                        {requirement.status === 'available'
                          ? 'Available'
                          : requirement.status === 'missing'
                            ? 'Needs setup'
                            : 'Unknown'}
                      </span>
                    </div>
                    <p className="mt-0.5 fg-secondary">
                      {requirement.detail ?? requirement.setupHint}
                    </p>
                  </div>
                  {requirement.status !== 'available' &&
                    (requirement.kind === 'mcp' ||
                      requirement.kind === 'connector') && (
                      <Button
                        size="compact"
                        data-testid={`recommended-plugin-requirement-setup-${requirement.id}`}
                        onClick={() =>
                          openPluginsNavigation({
                            kind: 'entry-detail',
                            entryId:
                              requirement.kind === 'mcp'
                                ? `mcp-catalog:${requirement.displayName}`
                                : `provider-connector:${requirement.displayName}`,
                          })
                        }
                      >
                        Set up
                      </Button>
                    )}
                </li>
              ))}
            </ul>
            {prompt.requirements.some(
              (requirement) =>
                requirement.status !== 'available' &&
                requirement.kind !== 'mcp' &&
                requirement.kind !== 'connector',
            ) && (
              <Button
                size="compact"
                onClick={() => openSettings('environment')}
              >
                Open environment setup
              </Button>
            )}
            <p className="text-2xs fg-secondary">
              Missing setup does not block applying recommendations.
            </p>
          </section>
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="text-2xs fg-secondary">
            {actionable.length === 0
              ? 'No recommendations need action'
              : allChecked
                ? `${checkedCount} of ${actionable.length} selected`
                : noneChecked
                  ? `0 of ${actionable.length} selected`
                  : `${checkedCount} of ${actionable.length} selected`}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="compact"
              onClick={handleAskMeLater}
              disabled={applying}
            >
              Ask me later
            </Button>
            {actionable.length > 0 && (
              <Button
                variant="primary"
                size="compact"
                onClick={(): void => {
                  void runApply({ skip: noneChecked });
                }}
                disabled={applying}
              >
                {primaryLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </DialogModal>
  );
}
