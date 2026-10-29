/**
 * Per-panel session UI state for `pipeline-execution` panels.
 *
 * A pipeline panel's React subtree does not survive a worktree switch (the
 * main layout's content unmounts) and drops its data while hidden, so the
 * small view state that says where the user was lives here, keyed by
 * `${ownerKey}::${panelId}` (the owner is the layout owner key
 * `${projectId}/${worktreeId}`; a Cowork Work Entry occupies the worktree
 * slot):
 *
 * - `entries`: values the panel renders from and reacts to: the child
 *   breadcrumb stack, job and variant selection, status filter, the user's
 *   explicit job-list choice (if any), the tab title once the run's name is
 *   known, and a reveal nonce for explicit targets applied to a mounted panel.
 * - `sessions`: values detail components read once when they mount and write
 *   back on change (step expansion, raw/rich choice, expanded child runs,
 *   pause drafts, scroll offset). See `details/pipelineDetailSession.ts`.
 *
 * Session scope only: nothing here is persisted, and restart starts fresh.
 * Execution snapshots, logs, and reports never belong in this store.
 * `lib/panels/pipeline-panel-sync.ts` releases a panel's state when its tab
 * closes; owner archive/delete paths call {@link releasePipelinePanelUiForOwner}.
 * A worktree switch or layout teardown releases nothing.
 */
import { create } from 'zustand';
import type { JobStatus } from '@/lib/pipelineDetailsView';
import type { PipelineDetailsSelection } from '@/components/activity/details/PipelineDetailsNav';
import type {
  BreadcrumbEntry,
  PipelineExecutionDetailTarget,
} from '@/components/activity/details/pipelineDetailTypes';
import {
  EMPTY_PIPELINE_DETAIL_SESSION_STATE,
  type PipelineDetailSession,
  type PipelineDetailSessionState,
  type PipelineDetailSessionUpdater,
} from '@/components/activity/details/pipelineDetailSession';

export interface PipelinePanelUiEntry {
  /** The bound root execution this state belongs to. */
  readonly executionId: string;
  readonly viewStack: readonly BreadcrumbEntry[];
  /** `null` is the run Summary. */
  readonly selection: PipelineDetailsSelection;
  readonly statusFilter: JobStatus | 'all';
  /**
   * The user's explicit job-list choice for this panel (the toggle), which
   * wins at any width. Absent until they toggle: the list then follows the
   * panel's width (see {@link resolvePipelinePanelNavExpanded}). The width
   * presentation is never written here.
   */
  readonly navExpandedOverride?: boolean;
  /** The run's display name once known, for the tab title. */
  readonly title?: string;
  /**
   * Bumped by each explicit reveal target. A mounted panel forwards it to
   * the detail so the target applies even though nothing remounts.
   */
  readonly revealNonce: number;
}

export type PipelinePanelUiPatch = Partial<
  Omit<PipelinePanelUiEntry, 'executionId' | 'revealNonce'>
>;

export interface PipelinePanelUiState {
  entries: Readonly<Record<string, PipelinePanelUiEntry>>;
  sessions: Readonly<Record<string, PipelineDetailSessionState>>;
}

const EMPTY_STACK: readonly BreadcrumbEntry[] = Object.freeze([]);

export function pipelinePanelUiKey(ownerKey: string, panelId: string): string {
  return `${ownerKey}::${panelId}`;
}

/**
 * A fresh panel's state: the run Summary, and no explicit job-list choice
 * (the list follows the panel's width).
 */
export function defaultPipelinePanelUiEntry(
  executionId: string,
): PipelinePanelUiEntry {
  return {
    executionId,
    viewStack: EMPTY_STACK,
    selection: null,
    statusFilter: 'all',
    revealNonce: 0,
  };
}

/**
 * Below this panel width (CSS px) the job list presents collapsed unless the
 * user chose otherwise. The docked list is 256px (`w-64`), so at the
 * threshold the run body keeps 512px: enough for the run facts in two
 * columns with full timestamps, a step's header with its status pills, and
 * about 70 characters of log. Narrower, a docked list would leave the body
 * under ~480px (a panel beside a chat at 1400px leaves it ~280px), so the
 * list collapses to its toggle and hover/focus preview instead. The compat
 * modal has no toggle and always docks its list.
 */
export const PIPELINE_PANEL_NAV_AUTO_COLLAPSE_WIDTH_PX = 768;

/** How a panel's measured width presents its job list by default. */
export type PipelinePanelWidthClass = 'wide' | 'narrow';

/**
 * The width class for a measured panel width, or `null` when the width says
 * nothing (a hidden panel measures 0; keep the last presentation).
 */
export function classifyPipelinePanelWidth(
  width: number,
): PipelinePanelWidthClass | null {
  if (!(width > 0)) return null;
  return width < PIPELINE_PANEL_NAV_AUTO_COLLAPSE_WIDTH_PX ? 'narrow' : 'wide';
}

/**
 * Whether a panel's job list presents expanded: the user's explicit choice
 * when there is one, otherwise expanded exactly when the panel is wide.
 */
export function resolvePipelinePanelNavExpanded(
  navExpandedOverride: boolean | undefined,
  widthClass: PipelinePanelWidthClass,
): boolean {
  return navExpandedOverride ?? widthClass === 'wide';
}

function selectionForTarget(
  target: PipelineExecutionDetailTarget,
): PipelineDetailsSelection {
  if (target.entry === 'cost') return { entry: 'cost' };
  if (target.entry === 'definition') return { entry: 'definition' };
  if (target.jobId === undefined) return null;
  return target.variantJobId !== undefined
    ? { jobId: target.jobId, variantJobId: target.variantJobId }
    : { jobId: target.jobId };
}

export const usePipelinePanelUiStore = create<PipelinePanelUiState>(() => ({
  entries: {},
  sessions: {},
}));

/**
 * The entry for `key` when it belongs to `executionId`. A panel id reused for
 * another run starts fresh instead of inheriting the old run's view.
 */
export function selectPipelinePanelUiEntry(
  state: PipelinePanelUiState,
  key: string,
  executionId: string,
): PipelinePanelUiEntry | undefined {
  const entry = state.entries[key];
  return entry?.executionId === executionId ? entry : undefined;
}

function currentEntry(
  state: PipelinePanelUiState,
  key: string,
  executionId: string,
): PipelinePanelUiEntry {
  return (
    selectPipelinePanelUiEntry(state, key, executionId) ??
    defaultPipelinePanelUiEntry(executionId)
  );
}

/** Applies a partial view change, creating the entry on first write. */
export function patchPipelinePanelUi(
  key: string,
  executionId: string,
  patch: PipelinePanelUiPatch,
): void {
  usePipelinePanelUiStore.setState((state) => {
    const previous = currentEntry(state, key, executionId);
    const sessionStale =
      state.entries[key] !== undefined &&
      state.entries[key].executionId !== executionId;
    const next: PipelinePanelUiEntry = { ...previous, ...patch };
    return {
      entries: { ...state.entries, [key]: next },
      ...(sessionStale ? { sessions: omitKey(state.sessions, key) } : {}),
    };
  });
}

/**
 * Points a panel at an explicit view of its run: the breadcrumb stack and
 * job/variant, with the status filter cleared so the target is visible. The
 * entry is created when the panel has not mounted yet (it then opens there);
 * a mounted panel applies it immediately. This is the opener's reveal seam.
 */
export function requestPipelinePanelReveal(request: {
  ownerKey: string;
  panelId: string;
  executionId: string;
  target: PipelineExecutionDetailTarget;
}): void {
  const key = pipelinePanelUiKey(request.ownerKey, request.panelId);
  usePipelinePanelUiStore.setState((state) => {
    const previous = currentEntry(state, key, request.executionId);
    const sessionStale =
      state.entries[key] !== undefined &&
      state.entries[key].executionId !== request.executionId;
    const next: PipelinePanelUiEntry = {
      ...previous,
      viewStack: request.target.viewStack
        ? [...request.target.viewStack]
        : EMPTY_STACK,
      selection: selectionForTarget(request.target),
      statusFilter: 'all',
      revealNonce: previous.revealNonce + 1,
    };
    return {
      entries: { ...state.entries, [key]: next },
      ...(sessionStale ? { sessions: omitKey(state.sessions, key) } : {}),
    };
  });
}

function omitKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Record<string, T> {
  const next: Record<string, T> = {};
  for (const [candidate, value] of Object.entries(record)) {
    if (candidate !== key) next[candidate] = value;
  }
  return next;
}

/** The retained detail session for one panel, backed by this store. */
export function getPipelinePanelSession(key: string): PipelineDetailSession {
  return {
    read: (): PipelineDetailSessionState =>
      usePipelinePanelUiStore.getState().sessions[key] ??
      EMPTY_PIPELINE_DETAIL_SESSION_STATE,
    update: (updater: PipelineDetailSessionUpdater): void => {
      usePipelinePanelUiStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [key]: updater(
            state.sessions[key] ?? EMPTY_PIPELINE_DETAIL_SESSION_STATE,
          ),
        },
      }));
    },
  };
}

/** Drops one panel's state (its tab closed). */
export function releasePipelinePanelUi(key: string): void {
  const state = usePipelinePanelUiStore.getState();
  if (state.entries[key] === undefined && state.sessions[key] === undefined) {
    return;
  }
  usePipelinePanelUiStore.setState({
    entries: omitKey(state.entries, key),
    sessions: omitKey(state.sessions, key),
  });
}

/** Keys of every panel with retained state under `ownerKey`. */
export function listPipelinePanelUiKeysForOwner(ownerKey: string): string[] {
  const prefix = `${ownerKey}::`;
  const state = usePipelinePanelUiStore.getState();
  const keys = new Set<string>();
  for (const key of [
    ...Object.keys(state.entries),
    ...Object.keys(state.sessions),
  ]) {
    if (key.startsWith(prefix)) keys.add(key);
  }
  return Array.from(keys);
}

/** Drops every panel's state for an owner that was archived or deleted. */
export function releasePipelinePanelUiForOwner(ownerKey: string): void {
  for (const key of listPipelinePanelUiKeysForOwner(ownerKey)) {
    releasePipelinePanelUi(key);
  }
}

/**
 * The retained run name for a panel's tab, or `undefined`. Matches on the
 * bound run as well as the panel id, since run panel ids are deterministic
 * and can repeat across owners.
 */
export function selectPipelinePanelTitle(
  state: PipelinePanelUiState,
  panelId: string,
  executionId: string,
): string | undefined {
  const suffix = `::${panelId}`;
  for (const [key, entry] of Object.entries(state.entries)) {
    if (key.endsWith(suffix) && entry.executionId === executionId) {
      return entry.title;
    }
  }
  return undefined;
}

export function resetPipelinePanelUiStoreForTests(): void {
  usePipelinePanelUiStore.setState({ entries: {}, sessions: {} });
}
