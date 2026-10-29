/**
 * Plan panel ⇄ tracked-plan reconciler.
 *
 * Keeps open `plan` and `plan-diagram` panels consistent with their owning
 * worktree's tracked plans: a panel whose plan was deleted is closed (both
 * kinds), and panel titles follow plan renames. It never creates a panel, so
 * nothing is resurrected while a group, window, or layout is being closed or
 * torn down; the next explicit open starts combined.
 *
 * Owners are the worktrees the chat ⇄ panel bridge reconciles (the selected
 * worktree and registered overlay owners) plus the owner of every open
 * auxiliary window, because a popped-out plan panel stays live while another
 * worktree is selected. Other cached layouts are left alone until they
 * become owners again.
 *
 * A plan absent from a partially loaded list is not evidence of deletion, so
 * an owner is reconciled only after its full tracked-plan inventory has
 * loaded; the reconciler requests that load once per worktree and waits.
 * Hidden plans are still tracked plans: hiding changes discovery, never an
 * open panel.
 *
 * Like the other panel bridges it lives outside the stores, coalesces store
 * changes into one microtask sweep, and ignores the store updates its own
 * sweep dispatches.
 */
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useChatStore } from '@/stores/chatStore';
import {
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { getChatPanelSyncOwnerKeys } from './chat-panel-sync';
import {
  collectPlanPanelBindings,
  isPlanPanelScope,
  planPanelTitleFor,
  type PlanPanelBinding,
} from './plan-panel-identity';

let installed = false;
let syncing = false;
let pendingSweep = false;
let unsubscribers: Array<() => void> = [];

/** Owners whose inventory load this reconciler requested and still awaits. */
const inventoryRequests = new Set<string>();

/** Splits a `${projectId}/${worktreeId}` key (ids can't contain `/`). */
function splitWorktreeKey(worktreeKey: string): {
  projectId: string;
  worktreeId: string;
} {
  const separator = worktreeKey.indexOf('/');
  return {
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
  };
}

/** Sync owners plus the owners of every live auxiliary window. */
function collectOwnerKeys(): Set<string> {
  const owners = new Set(getChatPanelSyncOwnerKeys());
  for (const record of Object.values(
    usePanelWindowsStore.getState().auxWindows,
  )) {
    owners.add(record.worktreeKey);
  }
  return owners;
}

/** Ask for an owner's full plan inventory once while the load is pending. */
function requestInventory(ownerKey: string): void {
  if (inventoryRequests.has(ownerKey)) return;
  inventoryRequests.add(ownerKey);
  const { projectId, worktreeId } = splitWorktreeKey(ownerKey);
  void useActivityStore
    .getState()
    .loadTrackedPlans(projectId, worktreeId)
    .catch(() => {
      // A failed load leaves panels as they are; the next sweep retries.
      inventoryRequests.delete(ownerKey);
    });
}

/** Close a deleted plan's panel, or bring its title up to date. */
function reconcileBinding(
  ownerKey: string,
  binding: PlanPanelBinding,
  plan: TrackedPlanData | undefined,
): void {
  const store = usePanelLayoutStore.getState();
  if (plan === undefined) {
    store.closeTab(binding.layoutKey, binding.groupId, binding.panelId);
    return;
  }
  const title = planPanelTitleFor(binding.kind, plan);
  if (binding.title !== title) {
    store.updateTabInstanceTitle(ownerKey, binding.panelId, title);
  }
}

function reconcileOwner(
  ownerKey: string,
  layouts: Readonly<Record<string, WorktreePanelLayout>>,
): void {
  // A restore commits the main layout and its windows together; until the
  // main layout exists there is nothing settled to reconcile.
  if (layouts[ownerKey] === undefined) return;
  if (!isPlanPanelScope(splitWorktreeKey(ownerKey).projectId)) return;
  const bindings = collectPlanPanelBindings(layouts, ownerKey);
  if (bindings.length === 0) return;
  const activity = useActivityStore.getState();
  if (activity.trackedPlanInventoryLoaded[ownerKey] !== true) {
    requestInventory(ownerKey);
    return;
  }
  inventoryRequests.delete(ownerKey);
  const plans = new Map(
    (activity.trackedPlans[ownerKey] ?? []).map((plan) => [plan.id, plan]),
  );
  for (const binding of bindings) {
    reconcileBinding(ownerKey, binding, plans.get(binding.planId));
  }
}

function runSweep(): void {
  syncing = true;
  try {
    for (const ownerKey of Array.from(collectOwnerKeys())) {
      reconcileOwner(ownerKey, usePanelLayoutStore.getState().layouts);
    }
  } finally {
    syncing = false;
  }
}

function scheduleSweep(): void {
  if (syncing || pendingSweep) return;
  pendingSweep = true;
  queueMicrotask((): void => {
    if (!pendingSweep) return;
    pendingSweep = false;
    runSweep();
  });
}

/**
 * Subscribe to `select(state)` changes of a store and schedule a sweep when
 * the selected value changes outside the sweep itself.
 */
function watch<TState, TValue>(
  store: {
    getState: () => TState;
    subscribe: (listener: (state: TState) => void) => () => void;
  },
  select: (state: TState) => TValue,
): () => void {
  let previous = select(store.getState());
  return store.subscribe((state) => {
    const next = select(state);
    const changed = next !== previous;
    previous = next;
    if (changed && !syncing) scheduleSweep();
  });
}

/**
 * Installs the reconciler (idempotent; called from `PanelGridSurface` beside
 * the other panel bridges) and schedules the initial sweep.
 */
export function initPlanPanelSync(): void {
  if (installed) return;
  installed = true;
  unsubscribers = [
    watch(usePanelLayoutStore, (state) => state.layouts),
    watch(useActivityStore, (state) => state.trackedPlans),
    watch(useActivityStore, (state) => state.trackedPlanInventoryLoaded),
    watch(useChatStore, (state) => state.selectedWorktree),
    watch(usePanelWindowsStore, (state) => state.auxWindows),
  ];
  scheduleSweep();
}

/** Test-only: runs a pending (scheduled) sweep synchronously. */
export function flushPlanPanelSyncForTests(): void {
  if (!pendingSweep) return;
  pendingSweep = false;
  runSweep();
}

/** Test-only: tears down the subscriptions and clears all module state. */
export function resetPlanPanelSyncForTests(): void {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  installed = false;
  syncing = false;
  pendingSweep = false;
  inventoryRequests.clear();
}
