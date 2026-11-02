import { Button } from '@canopy/ui-shared/components';
import { useCallback, useEffect, useId, useState, type JSX } from 'react';
import type {
  ChatTabPluginSelections,
  RecommendedPluginItem,
} from '@canopy/desktop-shared/types';
import { LoadingSpinner } from '../shared';
import { hasVisibleRecommendedPluginItems } from '@/lib/recommendedPlugins';
import { useProjectsStore } from '@/stores/projectsStore';

interface RecommendedPluginsSettingsPanelProps {
  projectId: string;
  /** Worktree to inspect for recommendations. May be undefined when no
   * worktree is selected; the panel renders an idle state in that case. */
  worktreeId: string | undefined;
  repoId?: string;
  /** Notifies the parent that a row action persisted new default plugin
   * selections so it can resync any in-memory edit buffer (e.g. the workspace
   * settings modal's pending plugins state) with the freshly persisted value.
   * Without this, a subsequent "Save Local" would overwrite the recommendation
   * with the parent's stale buffer. */
  onAppliedSelections?: (selections: ChatTabPluginSelections) => void;
  /** When `true`, the panel renders nothing once a successful inspection
   * returns zero actionable recommendations. Lets surfaces like the chat
   * plugins modal include the panel opportunistically without adding empty
   * real estate when the current branch's canopy.json has no useful local
   * action. */
  hideWhenEmpty?: boolean;
  /** `compact` renders a one-line summary strip for settings tabs whose
   * remaining height belongs to the capability table: nothing until there are
   * recommendations, and the rows only after the user expands it. */
  variant?: 'panel' | 'compact';
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; items: RecommendedPluginItem[] }
  | { kind: 'error'; message: string };

type RowAction = 'install-and-select' | 'select' | 'suggest-again';

interface RowActionState {
  action: RowAction;
  pending: boolean;
  error?: string;
}

function describeRowStatus(item: RecommendedPluginItem): {
  label: string;
  tone: 'muted' | 'positive' | 'warn';
} {
  if (item.selectedByDefault) {
    return { label: 'Selected by default', tone: 'positive' };
  }
  if (item.installed && !item.optedOut) {
    return { label: 'Installed, not selected', tone: 'muted' };
  }
  if (item.installState === 'installable' && !item.optedOut) {
    return { label: 'Missing', tone: 'warn' };
  }
  if (item.optedOut) {
    return { label: 'Opted out', tone: 'muted' };
  }
  if (item.installState === 'unavailable') {
    return { label: 'Manual setup required', tone: 'warn' };
  }
  return { label: '', tone: 'muted' };
}

function pickPrimaryAction(item: RecommendedPluginItem): RowAction | null {
  if (item.optedOut) {
    return 'suggest-again';
  }
  if (item.installState === 'installable' && !item.installed) {
    return 'install-and-select';
  }
  if (item.installed && !item.selectedByDefault) {
    return 'select';
  }
  return null;
}

function actionLabel(action: RowAction): string {
  switch (action) {
    case 'install-and-select':
      return 'Install and select';
    case 'select':
      return 'Select by default';
    case 'suggest-again':
      return 'Suggest again';
  }
}

/**
 * One-line summary of the recommendations for settings tabs that give their
 * height to the capability table. Renders nothing until there is something to
 * report; the rows open below the strip on Review.
 */
function CompactRecommendationsStrip({
  loadState,
  renderRowList,
}: {
  loadState: LoadState;
  renderRowList: (items: RecommendedPluginItem[]) => JSX.Element;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const rowListId = useId();
  if (loadState.kind === 'error') {
    return (
      <p
        data-testid="recommended-plugins-strip"
        className="shrink-0 truncate rounded-lg border px-3 py-1.5 text-xs fg-destructive-strong"
      >
        {loadState.message}
      </p>
    );
  }
  if (loadState.kind !== 'ready' || loadState.items.length === 0) {
    return null;
  }
  const total = loadState.items.length;
  const notSelected = loadState.items.filter(
    (item) => !item.selectedByDefault,
  ).length;
  return (
    <div
      data-testid="recommended-plugins-strip"
      className="shrink-0 rounded-lg border bg-secondary/30"
    >
      <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs fg-secondary">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium fg-primary">canopy.json</span> recommends{' '}
          {total} {total === 1 ? 'item' : 'items'}
          {notSelected > 0 ? ` · ${String(notSelected)} not selected` : ''}
        </span>
        <Button
          variant="ghost-accent"
          size="compact"
          aria-expanded={expanded}
          aria-controls={expanded ? rowListId : undefined}
          onClick={(): void => setExpanded((current) => !current)}
        >
          Review
          <span
            aria-hidden
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
          >
            ⌄
          </span>
        </Button>
      </div>
      {expanded && (
        <div id={rowListId} className="max-h-48 overflow-y-auto border-t p-2">
          {renderRowList(loadState.items)}
        </div>
      )}
    </div>
  );
}

/**
 * Settings-panel surface for `canopy.json.plugins` recommendations. Renders
 * the inspector output for a given workspace/worktree (and optional child
 * repo) and exposes row-level install/select/opt-out actions. All mutations
 * route through `applyRecommendedPlugins` so the install + selection logic
 * stays single-sourced with the prompt dialog. The panel passes
 * `dismissPromptOnSuccess: false` so it does not interfere with the prompt
 * dialog when both surfaces are open simultaneously.
 */
export function RecommendedPluginsSettingsPanel({
  projectId,
  worktreeId,
  repoId,
  onAppliedSelections,
  hideWhenEmpty,
  variant = 'panel',
}: RecommendedPluginsSettingsPanelProps): JSX.Element | null {
  const applyRecommendedPlugins = useProjectsStore(
    (state) => state.applyRecommendedPlugins,
  );

  const [loadState, setLoadState] = useState<LoadState>({ kind: 'idle' });
  const [rowState, setRowState] = useState<Record<string, RowActionState>>({});

  const fetchItems = useCallback(async (): Promise<void> => {
    if (!worktreeId) {
      setLoadState({ kind: 'idle' });
      return;
    }
    setLoadState({ kind: 'loading' });
    try {
      const response = await window.api.inspectRecommendedPlugins({
        workspaceId: projectId,
        worktreeId,
        repoId,
      });
      setLoadState({ kind: 'ready', items: response.items });
    } catch {
      setLoadState({
        kind: 'error',
        message: 'Failed to load recommended plugins.',
      });
    }
  }, [projectId, worktreeId, repoId]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const handleAction = useCallback(
    async (item: RecommendedPluginItem, action: RowAction): Promise<void> => {
      if (!worktreeId) {
        return;
      }
      setRowState((current) => ({
        ...current,
        [item.key]: { action, pending: true },
      }));
      try {
        let response;
        if (action === 'suggest-again') {
          response = await applyRecommendedPlugins({
            projectId,
            worktreeId,
            repoId,
            selectedKeys: [],
            optOutKeys: [],
            clearOptOutKeys: [item.key],
            dismissPromptOnSuccess: false,
          });
          const failed = response.results.find(
            (r) => r.key === item.key && r.status === 'error',
          );
          if (failed) {
            setRowState((current) => ({
              ...current,
              [item.key]: {
                action,
                pending: false,
                error: failed.message ?? 'Failed to clear opt-out.',
              },
            }));
            return;
          }
        } else {
          // Both `install-and-select` and `select` send the same payload —
          // the backend applier looks at the install state and decides
          // whether to install before selecting.
          response = await applyRecommendedPlugins({
            projectId,
            worktreeId,
            repoId,
            selectedKeys: [item.key],
            optOutKeys: [],
            dismissPromptOnSuccess: false,
          });
          const failed = response.results.find(
            (r) => r.key === item.key && r.status === 'error',
          );
          if (failed) {
            setRowState((current) => ({
              ...current,
              [item.key]: {
                action,
                pending: false,
                error: failed.message ?? 'Failed to apply recommendation.',
              },
            }));
            return;
          }
        }

        onAppliedSelections?.(response.defaultPluginSelections);

        setRowState((current) => {
          const next = { ...current };
          delete next[item.key];
          return next;
        });
        await fetchItems();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setRowState((current) => ({
          ...current,
          [item.key]: { action, pending: false, error: message },
        }));
      }
    },
    [
      applyRecommendedPlugins,
      fetchItems,
      onAppliedSelections,
      projectId,
      repoId,
      worktreeId,
    ],
  );

  const renderRowList = (items: RecommendedPluginItem[]): JSX.Element => (
    <ul className="divide-y rounded-lg border">
      {items.map((item) => {
        const state = rowState[item.key];
        const action = pickPrimaryAction(item);
        const status = describeRowStatus(item);
        return (
          <li key={item.key} className="flex items-start gap-3 p-3 text-xs">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium fg-primary">
                  {item.displayName}
                </span>
                <span className="rounded-full border px-1.5 py-0.5 text-3xs fg-secondary">
                  {item.kind === 'claude_plugin' ? 'plugin' : item.kind}
                </span>
              </div>
              <div className="mt-0.5 fg-secondary">{item.displaySource}</div>
              <div
                className={`mt-1 text-2xs ${
                  status.tone === 'positive'
                    ? 'fg-success-strong'
                    : status.tone === 'warn'
                      ? 'fg-warning'
                      : 'fg-secondary'
                }`}
              >
                {status.label}
              </div>
              {item.installState === 'unavailable' && !item.optedOut && (
                <p className="mt-1 text-2xs fg-secondary">
                  Install this manually from Plugins or Skills, then return here
                  to select it by default.
                </p>
              )}
              {state?.error && (
                <p className="mt-1 text-2xs fg-destructive-strong">
                  {state.error}
                </p>
              )}
            </div>
            {action && (
              <Button
                size="compact"
                onClick={(): void => {
                  void handleAction(item, action);
                }}
                disabled={state?.pending === true}
              >
                {state?.pending ? 'Working…' : actionLabel(action)}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );

  if (variant === 'compact') {
    return worktreeId ? (
      <CompactRecommendationsStrip
        loadState={loadState}
        renderRowList={renderRowList}
      />
    ) : null;
  }

  const headerCopy = (
    <h3 className="text-s font-medium fg-primary">
      Recommended from canopy.json
    </h3>
  );

  if (!worktreeId) {
    if (hideWhenEmpty) {
      return null;
    }
    return (
      <div className="rounded-lg border p-3 space-y-2">
        {headerCopy}
        <p className="text-xs fg-secondary">
          Select a worktree to inspect canopy.json recommendations.
        </p>
      </div>
    );
  }

  if (loadState.kind === 'loading') {
    if (hideWhenEmpty) {
      return null;
    }
    return (
      <div className="rounded-lg border p-3 space-y-2">
        {headerCopy}
        <div className="flex items-center gap-2 text-xs fg-secondary">
          <LoadingSpinner tone="secondary" />
          <span>Loading recommendations…</span>
        </div>
      </div>
    );
  }

  if (loadState.kind === 'error') {
    return (
      <div className="rounded-lg border p-3 space-y-2">
        {headerCopy}
        <p className="text-xs fg-destructive-strong">{loadState.message}</p>
      </div>
    );
  }

  if (
    loadState.kind !== 'ready' ||
    loadState.items.length === 0 ||
    (hideWhenEmpty && !hasVisibleRecommendedPluginItems(loadState.items))
  ) {
    if (hideWhenEmpty) {
      return null;
    }
    return (
      <div className="rounded-lg border p-3 space-y-2">
        {headerCopy}
        <p className="text-xs fg-secondary">
          No recommended plugins are declared in the selected canopy.json.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border p-3 space-y-2">
      {headerCopy}
      {renderRowList(loadState.items)}
    </div>
  );
}
