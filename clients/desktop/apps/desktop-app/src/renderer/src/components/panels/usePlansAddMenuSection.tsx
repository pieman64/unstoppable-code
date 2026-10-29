/**
 * The Add Panel menu's **Plans** entry: its own section after Terminal that
 * opens the plans list card and the owning worktree's tracked plans.
 *
 * - With no visible tracked plan it is one plain `Plans` row that opens the
 *   plans list card (the `plans` activity section).
 * - With visible tracked plans it is the **Plans** submenu: `All plans` (the
 *   same list card) first, a divider, then one entry per plan.
 *
 * Both list-card rows open or reveal: an absent card is added to the menu's
 * group through the menu's `onSelect`, and a card already open anywhere in the
 * worktree's layout family (auxiliary windows included) is revealed instead,
 * never duplicated. The card is therefore offered whether or not it is open,
 * and the Activity section no longer lists it.
 *
 * Plan entries are open-or-reveal too: choosing one places an absent document
 * panel in the menu's group, or reveals the document wherever it already
 * lives in the layout family (never duplicating, moving, or collapsing a split
 * diagram). Hidden plans are left out (hiding changes discovery, not open
 * panels), and titles and visibility follow the store while the menu is open.
 * An auxiliary-window layout key resolves to the worktree that owns the
 * window.
 *
 * The entry is omitted wherever the list card cannot be offered: surfaces
 * without the plans section (Cowork), access that disallows it, and
 * `excludeKinds` containing `activity-card`. A surface that excludes `plan`
 * panels but can host the card shows the plain row.
 */
import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { PanelKind } from '@canopy/protocol';
import type { TrackedPlanData } from '@canopy/desktop-shared/types';
import type {
  PanelAddTabMenuViewEntry,
  PanelAddTabMenuViewSection,
} from '@canopy/ui-shared/components/panels';
import { PlansIcon } from '@canopy/ui-shared/icons/AppIcons';
import { getActivitySectionsForSurface } from '@/components/activity/activity-sections';
import { panelSurfaceForWorktreeKey } from '@/lib/panels/panel-surface';
import { revealPanel } from '@/lib/panels/panel-reveal';
import {
  isPlanPanelScope,
  planPanelTitle,
} from '@/lib/panels/plan-panel-identity';
import {
  openPlanPanel,
  type PlanPanelScope,
} from '@/lib/panels/plan-panel-open';
import { isActivitySectionAllowedForAccess } from '@/lib/shared-containers/panel-allowlist';
import { useWorkspaceAccess } from '@/lib/workspace-access';
import { useActivityStore } from '@/stores/activityStore';
import {
  findPanelByInstanceKey,
  getAuxPanelLayoutOwnerKey,
  getPanelInstanceKey,
} from '@/stores/panelLayoutStore';

export interface UsePlansAddMenuSectionOptions {
  /** The menu's layout: the worktree's main layout or one of its windows. */
  readonly worktreeKey: string;
  /** The group whose menu is open; an absent plan panel is added here. */
  readonly groupId: string;
  /**
   * Kinds the surface cannot host: `activity-card` omits the whole entry,
   * `plan` omits the plan entries (leaving the plain row).
   */
  readonly excludeKinds?: readonly PanelKind[];
  /**
   * The menu's add path for an absent plans list card; it adds the tab to
   * the menu's group and closes the menu.
   */
  readonly onSelect: (
    kind: PanelKind,
    opts: {
      readonly instance: Readonly<Record<string, string>>;
      readonly title: string;
    },
  ) => void;
  /** Closes the whole menu once a plan is chosen or the card is revealed. */
  readonly onClose: () => void;
}

const PLANS_SECTION_ID = 'plans';
const PLANS_CARD_TEST_ID = `panel-add-menu-item-activity-card-${PLANS_SECTION_ID}`;
const NO_PLANS: readonly TrackedPlanData[] = [];

/**
 * The plans list card definition when the menu's surface, access, and
 * exclusions can offer it, else `null`.
 */
function usePlansCardDefinition(
  worktreeKey: string,
  excludeKinds: readonly PanelKind[] | undefined,
): { readonly title: string } | null {
  const access = useWorkspaceAccess();
  if (excludeKinds?.includes('activity-card') === true) return null;
  if (!isActivitySectionAllowedForAccess(PLANS_SECTION_ID, access)) return null;
  const surface =
    panelSurfaceForWorktreeKey(worktreeKey) === 'cowork'
      ? 'cowork'
      : 'worktree';
  const section = getActivitySectionsForSurface(surface).find(
    (candidate) => candidate.id === PLANS_SECTION_ID,
  );
  return section === undefined ? null : { title: section.title };
}

/**
 * The worktree that owns the menu's layout, when it can host plan panels.
 * Keys are `${projectId}/${worktreeId}`; ids never contain `/`.
 */
function resolvePlanScope(
  worktreeKey: string,
  excludeKinds: readonly PanelKind[] | undefined,
): PlanPanelScope | null {
  if (excludeKinds?.includes('plan') === true) return null;
  const ownerKey = getAuxPanelLayoutOwnerKey(worktreeKey) ?? worktreeKey;
  const separator = ownerKey.indexOf('/');
  if (separator <= 0 || separator === ownerKey.length - 1) return null;
  const projectId = ownerKey.slice(0, separator);
  if (!isPlanPanelScope(projectId)) return null;
  return { projectId, worktreeId: ownerKey.slice(separator + 1) };
}

/**
 * The scope's visible plans in plan-list order, kept current while the menu
 * is open. The full inventory is requested once when it has not loaded yet
 * (a failed load simply leaves the entry as it is).
 */
function useVisibleTrackedPlans(
  projectId: string | undefined,
  worktreeId: string | undefined,
): readonly TrackedPlanData[] {
  const ownerKey =
    projectId === undefined || worktreeId === undefined
      ? null
      : `${projectId}/${worktreeId}`;
  const plans = useActivityStore(
    useShallow((state): readonly TrackedPlanData[] =>
      ownerKey === null
        ? NO_PLANS
        : (state.trackedPlans[ownerKey] ?? NO_PLANS).filter(
            (plan) => plan.hidden !== true,
          ),
    ),
  );
  const inventoryLoaded = useActivityStore(
    (state) =>
      ownerKey !== null && state.trackedPlanInventoryLoaded[ownerKey] === true,
  );
  useEffect(() => {
    if (
      projectId === undefined ||
      worktreeId === undefined ||
      inventoryLoaded
    ) {
      return;
    }
    void useActivityStore
      .getState()
      .loadTrackedPlans(projectId, worktreeId)
      .catch(() => undefined);
  }, [projectId, worktreeId, inventoryLoaded]);
  return plans;
}

/**
 * The Plans section for the Add Panel menu — a plain row or a submenu — or
 * `null` when the menu's surface cannot offer the plans list card.
 */
export function usePlansAddMenuSection({
  worktreeKey,
  groupId,
  excludeKinds,
  onSelect,
  onClose,
}: UsePlansAddMenuSectionOptions): PanelAddTabMenuViewSection | null {
  const card = usePlansCardDefinition(worktreeKey, excludeKinds);
  const cardTitle = card?.title;
  const scope = resolvePlanScope(worktreeKey, excludeKinds);
  const projectId = scope?.projectId;
  const worktreeId = scope?.worktreeId;
  // Without the card there is no entry at all, so plans need not load.
  const plans = useVisibleTrackedPlans(
    cardTitle === undefined ? undefined : projectId,
    worktreeId,
  );

  return useMemo((): PanelAddTabMenuViewSection | null => {
    if (cardTitle === undefined) return null;

    // Read at choice time: the card may open or close while the menu is up.
    const openOrRevealCard = (): void => {
      const instance = { sectionId: PLANS_SECTION_ID };
      const existing = findPanelByInstanceKey(
        worktreeKey,
        getPanelInstanceKey({ kind: 'activity-card', instance }),
      );
      if (existing === null) {
        onSelect('activity-card', { instance, title: cardTitle });
        return;
      }
      revealPanel(existing);
      onClose();
    };
    const cardEntry = (label: string): PanelAddTabMenuViewEntry => ({
      testId: PLANS_CARD_TEST_ID,
      label,
      icon: <PlansIcon />,
      onActivate: openOrRevealCard,
    });

    // No plan scope (plan panels excluded, or an app-managed surface) or no
    // visible plan: the plain row.
    if (
      projectId === undefined ||
      worktreeId === undefined ||
      plans.length === 0
    ) {
      return rowSection(cardEntry(cardTitle));
    }
    const planScope: PlanPanelScope = { projectId, worktreeId };
    const entries = plans.map(
      (plan): PanelAddTabMenuViewEntry => ({
        key: plan.id,
        testId: `panel-add-menu-item-plan-${plan.id}`,
        label: planPanelTitle(plan),
        icon: <PlansIcon />,
        onActivate: (): void => {
          void openPlanPanel(planScope, plan.id, {
            intent: { groupId, layoutKey: worktreeKey },
          });
          onClose();
        },
      }),
    );
    return {
      id: PLANS_SECTION_ID,
      label: cardTitle,
      presentation: 'submenu',
      icon: <PlansIcon />,
      headerEntries: [cardEntry('All plans')],
      entries,
    };
  }, [
    cardTitle,
    projectId,
    worktreeId,
    plans,
    groupId,
    worktreeKey,
    onSelect,
    onClose,
  ]);
}

/** The plain one-row Plans section (no visible plan to nest). */
function rowSection(
  entry: PanelAddTabMenuViewEntry,
): PanelAddTabMenuViewSection {
  return {
    id: PLANS_SECTION_ID,
    label: entry.label,
    presentation: 'row',
    entries: [entry],
  };
}
