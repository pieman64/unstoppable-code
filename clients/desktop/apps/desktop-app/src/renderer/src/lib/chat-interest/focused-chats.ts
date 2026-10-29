/**
 * Which chats this window shows right now (its focused chats), derived from
 * the stores that decide what is on screen. {@link computeFocusedChats} is
 * pure over a {@link ChatInterestSources} snapshot; {@link readChatInterestSources}
 * takes that snapshot from the live stores with `getState()`, so nothing here
 * subscribes React components.
 *
 * Erring toward focused is safe: a chat shown but not declared would miss
 * delivery once later phases filter, while a hidden chat declared focused
 * only costs what every window costs today.
 */
import type {
  ChatInterestChatRef,
  NavigationPage,
  WorktreeSelection,
} from '@canopy/desktop-shared/types';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import type { PanelLayoutViewModel } from '@canopy/ui-shared/panels';
import { isCoworkChatTarget } from '@/lib/cowork';
import { isWorkflowsTabId } from '@/lib/navigation/workflows-target';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import { useChatStore } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { usePanelLayoutStore } from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';

/** The renderer declaring: the app window, or App Advisor's own renderer. */
export type ChatInterestSurface = 'main' | 'app-advisor';

/** Slice the Pipelines page reports its assistant drawer state under. */
export const PIPELINE_ASSISTANT_UI_STATE_KEY = 'pipelines.chatPanel';

/** The Pipeline Assistant drawer's chat scope. */
export const PIPELINE_EDITOR_SCOPE_KEY = `${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`;

/** A pulled-out panel window: its owning worktree and its own layout. */
export interface ChatInterestAuxLayout {
  readonly worktreeKey: string;
  readonly layoutKey: string;
}

/** Everything {@link computeFocusedChats} reads, as one snapshot. */
export interface ChatInterestSources {
  readonly surface: ChatInterestSurface;
  readonly activePage: NavigationPage;
  readonly settingsOpen: boolean;
  readonly selectedWorktree: WorktreeSelection | null;
  /** The Cowork page's (or App Advisor's) workspace and active entry. */
  readonly workEntry: {
    readonly projectId: string;
    readonly workEntryId: string | null;
  };
  /** Whether the Pipelines page reports its assistant drawer open. */
  readonly pipelineAssistantOpen: boolean;
  /** Whether App Advisor shows its floating single-chat layout. */
  readonly appAdvisorFloating: boolean;
  readonly auxLayouts: readonly ChatInterestAuxLayout[];
  readonly layoutViewModel: (layoutKey: string) => PanelLayoutViewModel | null;
  /** The active tab of a chat scope when it is a chat (not a file) tab. */
  readonly activeChatTabId: (scopeKey: string) => string | null;
}

/** Splits a `${projectId}/${worktreeId}` key; ids never contain `/`. */
function parseScopeKey(
  scopeKey: string,
): { projectId: string; worktreeId: string } | null {
  const separator = scopeKey.indexOf('/');
  if (separator <= 0 || separator === scopeKey.length - 1) return null;
  return {
    projectId: scopeKey.slice(0, separator),
    worktreeId: scopeKey.slice(separator + 1),
  };
}

/**
 * The chat panels a layout shows: each visible group's active tab when it is
 * a chat panel. A maximized group hides every other group; a collapsed group
 * shows an icon bar, not its content.
 */
export function layoutFocusedChatIds(
  viewModel: PanelLayoutViewModel,
): string[] {
  const maximized =
    viewModel.maximizedGroupId === null
      ? []
      : viewModel.groups.filter(
          (group) => group.groupId === viewModel.maximizedGroupId,
        );
  const groups = maximized.length > 0 ? maximized : viewModel.groups;
  const chatIds: string[] = [];
  for (const group of groups) {
    if (group.collapsed !== undefined) continue;
    const tab = group.tabs.find(
      (candidate) => candidate.panelId === group.activePanelId,
    );
    const chatTabId =
      tab?.kind === 'chat' ? tab.instance?.chatTabId : undefined;
    if (chatTabId) chatIds.push(chatTabId);
  }
  return chatIds;
}

/** This window's focused chats, in a stable order, without duplicates. */
export function computeFocusedChats(
  sources: ChatInterestSources,
): ChatInterestChatRef[] {
  const focused: ChatInterestChatRef[] = [];
  const seen = new Set<string>();
  const add = (scopeKey: string, chatIds: readonly string[]): void => {
    const scope = parseScopeKey(scopeKey);
    if (!scope) return;
    for (const chatId of chatIds) {
      const key = `${scopeKey}/${chatId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      focused.push({ ...scope, chatId });
    }
  };
  const addLayout = (scopeKey: string, layoutKey: string): void => {
    const viewModel = sources.layoutViewModel(layoutKey);
    if (viewModel) add(scopeKey, layoutFocusedChatIds(viewModel));
  };
  const addActiveChat = (scopeKey: string): void => {
    const chatId = sources.activeChatTabId(scopeKey);
    if (chatId) add(scopeKey, [chatId]);
  };

  const { workEntry } = sources;
  const workEntryKey =
    workEntry.workEntryId === null
      ? null
      : `${workEntry.projectId}/${workEntry.workEntryId}`;

  if (sources.surface === 'app-advisor') {
    // App Advisor's window has no pages: its entry grid, or the floating
    // layout's single chat, is what it shows.
    if (workEntryKey !== null) {
      if (sources.appAdvisorFloating) addActiveChat(workEntryKey);
      else addLayout(workEntryKey, workEntryKey);
    }
  } else if (!sources.settingsOpen) {
    const page = sources.activePage;
    const selected = sources.selectedWorktree;
    if (page === 'main' || page === 'kanban') {
      // WorktreePart's `visible`: the Code page, for a worktree selection.
      if (selected && !isCoworkChatTarget(selected.projectId)) {
        const key = `${selected.projectId}/${selected.worktreeId}`;
        addLayout(key, key);
      }
    } else if (page === 'chat') {
      if (workEntryKey !== null) addLayout(workEntryKey, workEntryKey);
    } else if (isWorkflowsTabId(page) && sources.pipelineAssistantOpen) {
      addActiveChat(PIPELINE_EDITOR_SCOPE_KEY);
    }
  }

  // Pulled-out panel windows render from this renderer and stay on screen
  // whatever the opener's page or selection.
  for (const aux of sources.auxLayouts) {
    addLayout(aux.worktreeKey, aux.layoutKey);
  }
  return focused;
}

function readPipelineAssistantOpen(): boolean {
  const slice =
    useCurrentUiStateStore.getState().slices[PIPELINE_ASSISTANT_UI_STATE_KEY];
  return (
    typeof slice === 'object' &&
    slice !== null &&
    !Array.isArray(slice) &&
    slice.visible === true
  );
}

/** A {@link ChatInterestSources} snapshot of the live stores. */
export function readChatInterestSources(
  surface: ChatInterestSurface,
): ChatInterestSources {
  const navigation = useNavigationStore.getState();
  const chat = useChatStore.getState();
  const standalone = useStandaloneChatStore.getState();
  const layouts = usePanelLayoutStore.getState().layouts;
  return {
    surface,
    activePage: navigation.activePage,
    settingsOpen: navigation.settingsOpen,
    selectedWorktree: chat.selectedWorktree,
    workEntry: {
      projectId: standalone.activeChatProjectId,
      workEntryId: standalone.activeWorkEntryId,
    },
    pipelineAssistantOpen:
      surface === 'main' ? readPipelineAssistantOpen() : false,
    appAdvisorFloating:
      surface === 'app-advisor' &&
      useAppAdvisorStore.getState().layout === 'floating',
    auxLayouts: Object.values(usePanelWindowsStore.getState().auxWindows),
    layoutViewModel: (layoutKey) => layouts[layoutKey]?.viewModel ?? null,
    activeChatTabId: (scopeKey): string | null => {
      const scope = chat.worktreeChats[scopeKey];
      const tab = scope?.tabs.find(
        (candidate) => candidate.id === scope.activeTabId,
      );
      return tab && tab.kind !== 'file' ? tab.id : null;
    },
  };
}
