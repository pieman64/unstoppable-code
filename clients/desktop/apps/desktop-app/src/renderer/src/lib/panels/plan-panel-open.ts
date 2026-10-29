/**
 * Open, split, and reveal plan workspace panels.
 *
 * A plan's document panel (`plan`) is its permanent identity: opening a plan
 * always targets it, revealing it wherever it already lives in the owning
 * worktree's layout family, or placing it through the shared content-panel
 * opener. Splitting creates (or reveals) one `plan-diagram` panel beside the
 * document, and Add Panel can open (or reveal) the diagram alone in a chosen
 * group. Merging needs no code: closing the diagram panel is the merge,
 * because the document derives its split state from the live layout.
 */
import type {
  ActivitySectionId,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';
import { useActivityStore } from '@/stores/activityStore';
import { useActivitySectionRevealStore } from '@/stores/activitySectionRevealStore';
import { useChatStore } from '@/stores/chatStore';
import {
  findPanelByInstanceKey,
  getPanelInstanceKey,
  usePanelLayoutStore,
  type PanelInstanceLocation,
} from '@/stores/panelLayoutStore';
import {
  planViewKey,
  usePlanViewStore,
  type PlanDiagramKind,
  type PlanViewInnerTab,
} from '@/stores/planViewStore';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import { useActivityCardStore } from '@/stores/activityCardStore';
import { getLabsFeatureEnabled } from '@/stores/labsExperimentsStore';
import { openActivitySectionInSidePanel } from './activity-section-panel-open';
import {
  openContentPanel,
  type ContentPanelIntent,
  type ContentPanelOpenResult,
  type ContentPanelOrigin,
  type ContentPanelSeed,
} from './chat-panel-sync';
import { ensureMinimalDestination } from './minimal-layout';
import {
  DEFAULT_CHAT_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
} from './panel-group-ids';
import { findPanelLocation, revealPanel } from './panel-reveal';
import {
  isPlanPanelScope,
  planDiagramSeed,
  planDocumentSeed,
  planPanelInstanceKey,
  type PlanPanelKind,
} from './plan-panel-identity';

/** The worktree that owns a tracked plan. */
export interface PlanPanelScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

/**
 * `auto` places an absent document with the open-file placement policy (the
 * origin's content group, else the layout default); a group intent places it
 * in exactly that group (Add Panel), in `layoutKey` (the worktree's main
 * layout when omitted). An open document is revealed either way.
 */
export type PlanPanelIntent =
  | 'auto'
  | { readonly groupId: string; readonly layoutKey?: string };

export interface OpenPlanPanelOptions {
  readonly intent?: PlanPanelIntent;
  /** Where an `auto` open started (the owning worktree's active chat). */
  readonly origin?: ContentPanelOrigin;
}

const UNAVAILABLE: ContentPanelOpenResult = { status: 'unavailable' };
const FAILED: ContentPanelOpenResult = { status: 'failed' };

function worktreeKeyOf(scope: PlanPanelScope): string {
  return `${scope.projectId}/${scope.worktreeId}`;
}

function isOpened(
  result: ContentPanelOpenResult,
): result is Extract<
  ContentPanelOpenResult,
  { status: 'revealed' | 'placed' }
> {
  return result.status === 'revealed' || result.status === 'placed';
}

/**
 * The plan, from the store or fetched on its own. `null` when the scope
 * cannot host plan panels or the plan does not exist.
 */
async function resolvePlan(
  scope: PlanPanelScope,
  planId: string,
): Promise<TrackedPlanData | null> {
  if (!isPlanPanelScope(scope.projectId)) return null;
  try {
    return await useActivityStore
      .getState()
      .ensureTrackedPlanLoaded(scope.projectId, scope.worktreeId, planId);
  } catch {
    return null;
  }
}

/** Select a combined plan panel's inner tab (no-op while no view is open). */
function selectInnerTab(
  scope: PlanPanelScope,
  planId: string,
  tab: PlanViewInnerTab,
): void {
  usePlanViewStore
    .getState()
    .setInnerTab(planViewKey(scope.projectId, scope.worktreeId, planId), tab);
}

function findPlanPanel(
  scope: PlanPanelScope,
  kind: PlanPanelKind,
  planId: string,
): PanelInstanceLocation | null {
  return findPanelByInstanceKey(
    worktreeKeyOf(scope),
    planPanelInstanceKey(kind, planId),
  );
}

function toContentIntent(
  intent: PlanPanelIntent | undefined,
): ContentPanelIntent {
  if (intent === undefined || intent === 'auto') return { kind: 'auto' };
  return intent.layoutKey === undefined
    ? { kind: 'group', groupId: intent.groupId }
    : { kind: 'group', groupId: intent.groupId, layoutKey: intent.layoutKey };
}

/**
 * Open a tracked plan's document panel in its owning worktree, or reveal it
 * where it already is (never moving it, and never touching a split diagram).
 * A diagram left open after its document was closed stays where it is; the
 * document is recreated per `intent`. The document's Document inner tab is
 * selected. Resolves `unavailable` when the scope cannot host plan panels or
 * the plan does not exist.
 */
export async function openPlanPanel(
  scope: PlanPanelScope,
  planId: string,
  options: OpenPlanPanelOptions = {},
): Promise<ContentPanelOpenResult> {
  const plan = await resolvePlan(scope, planId);
  if (plan === null) return UNAVAILABLE;
  const result = await openContentPanel(
    worktreeKeyOf(scope),
    planDocumentSeed(plan),
    options.origin === undefined
      ? { intent: toContentIntent(options.intent) }
      : { intent: toContentIntent(options.intent), origin: options.origin },
  );
  if (isOpened(result)) selectInnerTab(scope, planId, 'document');
  return result;
}

/**
 * Open a tracked plan's diagram panel in one explicit group (Add Panel), in
 * `intent.layoutKey` (the worktree's main layout when omitted). An open
 * diagram panel is revealed where it is instead (never moved or duplicated).
 * A diagram needs no open document: closing the document later leaves the
 * diagram alone. Resolves `unavailable` when the scope cannot host plan
 * panels or the plan does not exist, and `failed` when the group cannot take
 * the panel.
 */
export async function openPlanDiagramPanel(
  scope: PlanPanelScope,
  planId: string,
  options: {
    readonly intent: { readonly groupId: string; readonly layoutKey?: string };
  },
): Promise<ContentPanelOpenResult> {
  const plan = await resolvePlan(scope, planId);
  if (plan === null) return UNAVAILABLE;
  const result = await openContentPanel(
    worktreeKeyOf(scope),
    planDiagramSeed(plan),
    { intent: toContentIntent(options.intent) },
  );
  // A split diagram leaves the document on its Document tab (as Split does).
  if (result.status === 'placed') selectInnerTab(scope, planId, 'document');
  return result;
}

/**
 * Split the diagram off to the right of the document's group, in the same
 * layout (main or auxiliary). Reuses the deterministic panel id when it is
 * free in the family. `null` when the layout refuses the split (a Minimal
 * layout's fixed topology).
 */
function splitBesideDocument(
  worktreeKey: string,
  document: PanelInstanceLocation,
  seed: ContentPanelSeed,
): PanelInstanceLocation | null {
  const panelIdFree = findPanelLocation(worktreeKey, seed.panelId) === null;
  const store = usePanelLayoutStore.getState();
  const groupId = store.splitGroup(
    document.layoutKey,
    document.groupId,
    'right',
    {
      kind: seed.kind,
      title: seed.title,
      instance: seed.instance,
      ...(panelIdFree ? { panelId: seed.panelId } : {}),
    },
  );
  if (groupId === null) return null;
  const panelId =
    usePanelLayoutStore.getState().layouts[document.layoutKey]?.groups[groupId]
      ?.tabs[0]?.panelId;
  return panelId === undefined
    ? null
    : { layoutKey: document.layoutKey, groupId, panelId };
}

/**
 * Minimal layouts cannot split, so the diagram goes to the other flexible
 * group: the Bottom Drawer for a document in the Side Panel, and the Side
 * Panel for a document in the Bottom Drawer.
 */
async function placeInOtherMinimalGroup(
  worktreeKey: string,
  document: PanelInstanceLocation,
  seed: ContentPanelSeed,
): Promise<ContentPanelOpenResult> {
  const groupId = ensureMinimalDestination(
    worktreeKey,
    document.groupId === DEFAULT_TERMINAL_GROUP_ID ? 'file-diff' : 'terminal',
  );
  if (groupId === null) return FAILED;
  return openContentPanel(worktreeKey, seed, {
    intent: { kind: 'group', groupId },
  });
}

/**
 * Open the plan's diagram in its own panel beside the document. An existing
 * diagram panel is only revealed (splitting twice never duplicates). Needs
 * an open document panel; the document keeps its identity and shows its
 * Document tab afterwards. Resolves `unavailable` when the scope cannot host
 * plan panels or the plan does not exist, and `failed` when there is no
 * document or no place for the diagram.
 */
export async function splitPlanDiagram(
  scope: PlanPanelScope,
  planId: string,
): Promise<ContentPanelOpenResult> {
  const plan = await resolvePlan(scope, planId);
  if (plan === null) return UNAVAILABLE;
  const existing = findPlanPanel(scope, 'plan-diagram', planId);
  if (existing !== null) {
    revealPanel(existing);
    return { status: 'revealed', location: existing };
  }
  const document = findPlanPanel(scope, 'plan', planId);
  if (document === null) return FAILED;
  const worktreeKey = worktreeKeyOf(scope);
  const seed = planDiagramSeed(plan);
  const split = splitBesideDocument(worktreeKey, document, seed);
  let result: ContentPanelOpenResult = FAILED;
  if (split !== null) {
    revealPanel(split);
    result = { status: 'placed', location: split };
  } else if (getWorkspaceLayoutMode(worktreeKey) === 'minimal') {
    result = await placeInOtherMinimalGroup(worktreeKey, document, seed);
  }
  if (isOpened(result)) selectInnerTab(scope, planId, 'document');
  return result;
}

/** Reveal the plan's split diagram panel. `false` when it is not split. */
export function revealPlanDiagram(
  scope: PlanPanelScope,
  planId: string,
): boolean {
  const location = findPlanPanel(scope, 'plan-diagram', planId);
  if (location === null) return false;
  revealPanel(location);
  return true;
}

/**
 * Show a diagram node for a plan (a comment's diagram jump): reveal the split
 * diagram panel, or switch the combined panel to its Diagram tab, then ask
 * the diagram to reveal the node.
 */
export function revealPlanDiagramNode(
  scope: PlanPanelScope,
  planId: string,
  diagramKind: PlanDiagramKind,
  nodeId: string,
): void {
  if (!revealPlanDiagram(scope, planId)) {
    selectInnerTab(scope, planId, 'diagram');
  }
  usePlanViewStore
    .getState()
    .requestDiagramReveal(
      planViewKey(scope.projectId, scope.worktreeId, planId),
      diagramKind,
      nodeId,
    );
}

/**
 * The placement origin for an `auto` plan open: the owning worktree's active
 * chat tab, as file opens use. `undefined` when its active tab is a file tab
 * or its chats are not loaded.
 */
export function planPanelOriginForWorktree(
  worktreeKey: string,
): ContentPanelOrigin | undefined {
  const worktree = useChatStore.getState().worktreeChats[worktreeKey];
  if (!worktree) return undefined;
  const active = worktree.tabs.find((tab) => tab.id === worktree.activeTabId);
  if (active !== undefined && active.kind !== 'file') {
    return { chatTabId: active.id };
  }
  // Opening a file (for example from a chat mention) makes its tab the active
  // one; the plan still belongs beside the chat the user was working in.
  const lastChat = worktree.tabs.find(
    (tab) =>
      tab.id === worktree.lastActiveEditableChatId && tab.kind !== 'file',
  );
  return lastChat === undefined ? undefined : { chatTabId: lastChat.id };
}

/**
 * How long a chat reveal waits for the chat/panel bridge to place the chat's
 * panel. The bridge places it on its next pass (a microtask) for a worktree it
 * reconciles; the bound keeps a worktree it does not reconcile from holding a
 * subscription.
 */
const CHAT_PANEL_WAIT_MS = 5_000;

/** The pending chat reveal per worktree; a newer reveal supersedes it. */
const pendingChatPanelReveals = new Map<string, () => void>();

function findChatPanel(
  worktreeKey: string,
  chatId: string,
): PanelInstanceLocation | null {
  return findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({ kind: 'chat', instance: { chatTabId: chatId } }),
  );
}

/** Reveal `chatId`'s panel once the chat/panel bridge places it. */
function revealChatPanelWhenPlaced(worktreeKey: string, chatId: string): void {
  let unsubscribe = (): void => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopWatching = (): void => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const cancel = (): void => {
    stopWatching();
    if (pendingChatPanelReveals.get(worktreeKey) === cancel) {
      pendingChatPanelReveals.delete(worktreeKey);
    }
  };
  pendingChatPanelReveals.set(worktreeKey, cancel);
  unsubscribe = usePanelLayoutStore.subscribe((): void => {
    if (findChatPanel(worktreeKey, chatId) === null) return;
    stopWatching();
    // The bridge places the panel in the middle of its pass; reveal once
    // that pass has settled, unless a newer reveal took over meanwhile.
    queueMicrotask((): void => {
      if (pendingChatPanelReveals.get(worktreeKey) !== cancel) return;
      cancel();
      const location = findChatPanel(worktreeKey, chatId);
      if (location !== null) revealPanel(location);
    });
  });
  timer = setTimeout(cancel, CHAT_PANEL_WAIT_MS);
}

/**
 * Reveal the panel of a chat in the plan's owning worktree (when Implement or
 * a comment submission chose it): leave another group's maximize, expand its
 * collapsed group, select its tab, and focus its group. A chat the worktree
 * has but whose panel the chat/panel bridge has not placed yet (a chat just
 * created or made active) is revealed once the bridge places it. A newer
 * reveal in the same worktree supersedes a pending one. `false` when the
 * worktree has no such chat.
 */
export function revealWorktreeChatPanel(
  scope: PlanPanelScope,
  chatId: string,
): boolean {
  const worktreeKey = worktreeKeyOf(scope);
  pendingChatPanelReveals.get(worktreeKey)?.();
  const location = findChatPanel(worktreeKey, chatId);
  if (location !== null) {
    revealPanel(location);
    return true;
  }
  const chatExists =
    useChatStore
      .getState()
      .worktreeChats[worktreeKey]?.tabs.some((tab) => tab.id === chatId) ??
    false;
  if (!chatExists) return false;
  revealChatPanelWhenPlaced(worktreeKey, chatId);
  return true;
}

/** The activity card that lists a worktree's pipeline runs. */
const PIPELINE_RUNS_SECTION_ID: ActivitySectionId = 'pipeline-runs';

/**
 * Reveal where the owning worktree's pipeline runs appear (after a plan
 * started one): its Pipeline Runs card panel when one exists, else its
 * Activity panel, expanding a collapsed group and, in the Activity panel, a
 * collapsed Pipeline runs section (the card panel has no collapse). `false`
 * when the worktree has neither panel.
 *
 * Early access has no Activity panel (Activity is a card beside the chat):
 * it opens Pipeline runs as a Side Panel tab in Minimal, and in Advanced,
 * which has no Side Panel, shows the worktree's Activity card and reveals
 * the main chat that hosts it (a maximized plan panel would hide it).
 */
export function revealWorktreeActivityPanel(scope: PlanPanelScope): boolean {
  const worktreeKey = worktreeKeyOf(scope);
  const card = findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({
      kind: 'activity-card',
      instance: { sectionId: PIPELINE_RUNS_SECTION_ID },
    }),
  );
  if (card !== null) {
    revealPanel(card);
    return true;
  }
  if (getLabsFeatureEnabled('activity-card')) {
    if (openActivitySectionInSidePanel(worktreeKey, PIPELINE_RUNS_SECTION_ID)) {
      return true;
    }
    useActivityCardStore.getState().show(worktreeKey);
    const chatGroup =
      usePanelLayoutStore.getState().layouts[worktreeKey]?.groups[
        DEFAULT_CHAT_GROUP_ID
      ];
    // The card shows only beside a chat: the active tab when it is one, else
    // the group's first chat.
    const chatTabs = chatGroup?.tabs.filter((tab) => tab.kind === 'chat') ?? [];
    const chatPanelId = (
      chatTabs.find((tab) => tab.panelId === chatGroup?.activePanelId) ??
      chatTabs[0]
    )?.panelId;
    if (chatPanelId !== undefined) {
      revealPanel({
        layoutKey: worktreeKey,
        groupId: DEFAULT_CHAT_GROUP_ID,
        panelId: chatPanelId,
      });
    }
    return true;
  }
  const activity = findPanelByInstanceKey(
    worktreeKey,
    getPanelInstanceKey({ kind: 'activity-section' }),
  );
  if (activity === null) return false;
  revealPanel(activity);
  useActivitySectionRevealStore
    .getState()
    .requestSectionExpand(worktreeKey, PIPELINE_RUNS_SECTION_ID);
  return true;
}
