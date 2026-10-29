/**
 * Open, or reveal, the two cost panels of a work scope (a Code worktree, or a
 * Cowork or App Advisor Work Entry):
 * - `cost`: the scope singleton, like the Feed.
 * - `session-breakdown`: one per chat across the layout family, bound by
 *   `instance.chatId`. Opening a chat's breakdown that is already open
 *   reveals it where it is; it is never moved or duplicated.
 *
 * A new panel goes to the Side Panel under the Minimal layout and to the
 * active group otherwise.
 */
import {
  clampPanelTitle,
  isSessionBreakdownPanelInstance,
  type PanelKind,
} from '@canopy/protocol';
import { useChatStore } from '@/stores/chatStore';
import {
  getPanelInstanceKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import {
  openContentPanel,
  type ContentPanelIntent,
  type ContentPanelOpenResult,
  type ContentPanelSeed,
} from '@/lib/panels/chat-panel-sync';
import { ensureMinimalDestination } from '@/lib/panels/minimal-layout';

/** The Cost panel's tab title and palette noun. */
export const COST_PANEL_TITLE = 'Cost';
/** The Session breakdown's name: its tooltip, add-tab row and palette noun. */
export const SESSION_BREAKDOWN_PANEL_NAME = 'Session breakdown';
export const COST_PANEL_ID = 'panel-cost';

/** The work scope a cost panel belongs to. */
export interface CostPanelScope {
  readonly projectId: string;
  readonly worktreeId: string;
}

const FAILED: ContentPanelOpenResult = { status: 'failed' };

function worktreeKeyOf(scope: CostPanelScope): string {
  return makeWorktreePanelKey(scope.projectId, scope.worktreeId);
}

/**
 * Where a new cost panel goes: the Side Panel under Minimal, otherwise the
 * layout's active group. `auto` (the shared content placement) only when the
 * layout is not built yet; the opener hydrates it first.
 */
function placementIntent(
  worktreeKey: string,
  kind: PanelKind,
): ContentPanelIntent {
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  if (layout === undefined) return { kind: 'auto' };
  if (getWorkspaceLayoutMode(worktreeKey) === 'minimal') {
    const groupId = ensureMinimalDestination(worktreeKey, kind);
    return groupId === null ? { kind: 'auto' } : { kind: 'group', groupId };
  }
  const groupId = layout.activeGroupId;
  return groupId !== null && layout.groups[groupId] !== undefined
    ? { kind: 'group', groupId }
    : { kind: 'auto' };
}

/** Seed for the scope's Cost panel. */
export function costPanelSeed(): ContentPanelSeed {
  return {
    kind: 'cost',
    panelId: COST_PANEL_ID,
    title: COST_PANEL_TITLE,
    // The panel layout store omits empty instance records when it creates a
    // descriptor, while the content-panel placement adapter expects a record.
    instance: {},
  };
}

/**
 * Deterministic panel id for a chat's Session breakdown. Identity is the
 * chat id binding, not this display-safe id; placement retries with a
 * generated id if another panel already claimed it.
 */
export function sessionBreakdownPanelIdFor(chatId: string): string {
  return `panel-session-breakdown-${chatId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/** The layout store's family-wide identity key for a chat's breakdown. */
export function sessionBreakdownPanelInstanceKey(chatId: string): string {
  return getPanelInstanceKey({
    kind: 'session-breakdown',
    instance: { chatId },
  });
}

/**
 * The chat's name as the breakdown tab's stored title: the live tab title,
 * else the archived chat's, else the panel's name. The tab itself follows the
 * chat's live name while it is open.
 */
export function sessionBreakdownTitleFor(
  scope: CostPanelScope,
  chatId: string,
): string {
  const state = useChatStore.getState();
  const key = worktreeKeyOf(scope);
  const live = state.worktreeChats[key]?.tabs.find((tab) => tab.id === chatId);
  const archived = state.archivedChats[key]?.find(
    (chat) => chat.chatId === chatId,
  );
  const title = (live?.title ?? archived?.title ?? '').trim();
  return clampPanelTitle(
    title.length > 0 ? title : SESSION_BREAKDOWN_PANEL_NAME,
  );
}

/** Seed for one chat's Session breakdown. */
export function sessionBreakdownPanelSeed(
  chatId: string,
  title: string,
): ContentPanelSeed {
  return {
    kind: 'session-breakdown',
    panelId: sessionBreakdownPanelIdFor(chatId),
    title: clampPanelTitle(title),
    instance: { chatId },
  };
}

/** Opens or reveals the scope's Cost panel. */
export function openCostPanel(
  scope: CostPanelScope,
): Promise<ContentPanelOpenResult> {
  const worktreeKey = worktreeKeyOf(scope);
  return openContentPanel(worktreeKey, costPanelSeed(), {
    intent: placementIntent(worktreeKey, 'cost'),
  });
}

/**
 * Opens or reveals one chat's Session breakdown in the scope's layout
 * family. Fails before touching the layout when the chat id is not a valid
 * binding.
 */
export function openSessionBreakdownPanel(
  scope: CostPanelScope,
  chatId: string,
): Promise<ContentPanelOpenResult> {
  if (!isSessionBreakdownPanelInstance({ chatId })) {
    return Promise.resolve(FAILED);
  }
  const worktreeKey = worktreeKeyOf(scope);
  return openContentPanel(
    worktreeKey,
    sessionBreakdownPanelSeed(chatId, sessionBreakdownTitleFor(scope, chatId)),
    { intent: placementIntent(worktreeKey, 'session-breakdown') },
  );
}
