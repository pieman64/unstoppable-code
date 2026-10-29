/**
 * Identity of the plan workspace panels: the `plan` document panel and its
 * optional split `plan-diagram` panel, both bound to `instance.planId`.
 *
 * Each kind/plan pair exists at most once across a worktree's layout family
 * (its main layout and auxiliary windows). Whether a plan's diagram is split
 * out is never persisted separately: it is derived from whether a
 * `plan-diagram` panel for the plan exists in that family right now.
 */
import type { PanelKind } from '@canopy/protocol';
import {
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  getAuxPanelLayoutOwnerKey,
  getPanelInstanceKey,
  usePanelLayoutStore,
  type PanelTabDescriptor,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';
import type { ContentPanelSeed } from './chat-panel-sync';

/** The two plan-bound panel kinds. */
export type PlanPanelKind = Extract<PanelKind, 'plan' | 'plan-diagram'>;

/** The plan fields a panel's identity and title derive from. */
export type PlanPanelSource = Pick<TrackedPlanData, 'id' | 'title'>;

/** Title used when a plan has no usable title. */
const FALLBACK_PLAN_TITLE = 'Plan';

/** Whether `kind` is one of the plan-bound panel kinds. */
export function isPlanPanelKind(kind: string): kind is PlanPanelKind {
  return kind === 'plan' || kind === 'plan-diagram';
}

/** Deterministic panel id of a plan's document panel. */
export function planPanelIdFor(planId: string): string {
  return `panel-plan-${planId}`;
}

/** Deterministic panel id of a plan's split diagram panel. */
export function planDiagramPanelIdFor(planId: string): string {
  return `panel-plan-diagram-${planId}`;
}

/** The layout store's instance key for a plan panel (`plan:<id>`, …). */
export function planPanelInstanceKey(
  kind: PlanPanelKind,
  planId: string,
): string {
  return getPanelInstanceKey({ kind, instance: { planId } });
}

/** Tab title of a plan's document panel: the plan's own title. */
export function planPanelTitle(plan: Pick<TrackedPlanData, 'title'>): string {
  const title = plan.title.trim();
  return title.length > 0 ? title : FALLBACK_PLAN_TITLE;
}

/** Tab title of a plan's split diagram panel. */
export function planDiagramPanelTitle(
  plan: Pick<TrackedPlanData, 'title'>,
): string {
  return `${planPanelTitle(plan)} (Diagram)`;
}

/** The tab title a plan panel of `kind` should show. */
export function planPanelTitleFor(
  kind: PlanPanelKind,
  plan: Pick<TrackedPlanData, 'title'>,
): string {
  return kind === 'plan' ? planPanelTitle(plan) : planDiagramPanelTitle(plan);
}

/** Content-panel seed for a plan's document panel. */
export function planDocumentSeed(plan: PlanPanelSource): ContentPanelSeed {
  return {
    kind: 'plan',
    panelId: planPanelIdFor(plan.id),
    instance: { planId: plan.id },
    title: planPanelTitle(plan),
  };
}

/** Content-panel seed for a plan's split diagram panel. */
export function planDiagramSeed(plan: PlanPanelSource): ContentPanelSeed {
  return {
    kind: 'plan-diagram',
    panelId: planDiagramPanelIdFor(plan.id),
    instance: { planId: plan.id },
    title: planDiagramPanelTitle(plan),
  };
}

/**
 * Whether a project can host plan panels. Plans belong to code worktrees
 * (including a shared-container recipient's read-only view); Cowork, App
 * Advisor, and the legacy plan-explore chat scope have no tracked plans.
 */
export function isPlanPanelScope(projectId: string): boolean {
  return (
    projectId !== APP_ADVISOR_PROJECT_ID &&
    projectId !== PLAN_EXPLORE_CHAT_PROJECT_ID &&
    !isCoworkChatTarget(projectId)
  );
}

/** One plan panel found in a layout family. */
export interface PlanPanelBinding {
  readonly layoutKey: string;
  readonly groupId: string;
  readonly panelId: string;
  readonly kind: PlanPanelKind;
  readonly planId: string;
  readonly title: string | undefined;
}

/** Whether `layoutKey` is `worktreeKey`'s main layout or one of its windows. */
function isFamilyLayoutKey(layoutKey: string, worktreeKey: string): boolean {
  return (
    layoutKey === worktreeKey ||
    getAuxPanelLayoutOwnerKey(layoutKey) === worktreeKey
  );
}

/** The plan panel a tab is, or `null` for any other tab. */
function toPlanPanelBinding(
  layoutKey: string,
  groupId: string,
  tab: PanelTabDescriptor,
): PlanPanelBinding | null {
  const kind = tab.kind;
  const planId = tab.instance?.planId?.trim() ?? '';
  if (!isPlanPanelKind(kind) || planId.length === 0) return null;
  return {
    layoutKey,
    groupId,
    panelId: tab.panelId,
    kind,
    planId,
    title: tab.title,
  };
}

/** Every plan panel in one layout, in group order. */
function collectLayoutPlanPanels(
  layoutKey: string,
  layout: WorktreePanelLayout,
): PlanPanelBinding[] {
  return Object.entries(layout.groups).flatMap(([groupId, group]) =>
    group.tabs.flatMap((tab) => {
      const binding = toPlanPanelBinding(layoutKey, groupId, tab);
      return binding === null ? [] : [binding];
    }),
  );
}

/** Every plan panel across `worktreeKey`'s layout family. */
export function collectPlanPanelBindings(
  layouts: Readonly<Record<string, WorktreePanelLayout>>,
  worktreeKey: string,
): PlanPanelBinding[] {
  return Object.entries(layouts).flatMap(([layoutKey, layout]) =>
    isFamilyLayoutKey(layoutKey, worktreeKey)
      ? collectLayoutPlanPanels(layoutKey, layout)
      : [],
  );
}

/** Whether a `kind` panel for `planId` exists in `worktreeKey`'s family. */
export function familyHasPlanPanel(
  layouts: Readonly<Record<string, WorktreePanelLayout>>,
  worktreeKey: string,
  kind: PlanPanelKind,
  planId: string,
): boolean {
  return collectPlanPanelBindings(layouts, worktreeKey).some(
    (binding) => binding.kind === kind && binding.planId === planId,
  );
}

/**
 * Whether a `kind` panel for `planId` is on screen in `worktreeKey`'s layout
 * family (the main layout or a popped-out window): the active tab of a group
 * that is not collapsed, in a layout where no other group is maximized.
 */
export function isPlanPanelOnScreen(
  layouts: Readonly<Record<string, WorktreePanelLayout>>,
  worktreeKey: string,
  kind: PlanPanelKind,
  planId: string,
): boolean {
  return collectPlanPanelBindings(layouts, worktreeKey).some((binding) => {
    if (binding.kind !== kind || binding.planId !== planId) return false;
    const layout = layouts[binding.layoutKey];
    const group = layout?.groups[binding.groupId];
    if (layout === undefined || group === undefined) return false;
    return (
      group.activePanelId === binding.panelId &&
      group.collapsed === undefined &&
      (layout.maximizedGroupId === null ||
        layout.maximizedGroupId === binding.groupId)
    );
  });
}

/** {@link isPlanPanelOnScreen}, kept current as the layout changes. */
export function useIsPlanPanelOnScreen(
  worktreeKey: string,
  kind: PlanPanelKind,
  planId: string,
): boolean {
  return usePanelLayoutStore((state) =>
    isPlanPanelOnScreen(state.layouts, worktreeKey, kind, planId),
  );
}

/**
 * Whether the plan's diagram is split into its own panel anywhere in the
 * worktree's layout family (derived from the layout, never persisted).
 */
export function useIsPlanDiagramSplit(
  worktreeKey: string,
  planId: string,
): boolean {
  return usePanelLayoutStore((state) =>
    familyHasPlanPanel(state.layouts, worktreeKey, 'plan-diagram', planId),
  );
}
