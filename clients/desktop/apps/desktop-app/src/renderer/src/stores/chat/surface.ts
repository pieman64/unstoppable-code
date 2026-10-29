// Renderer-surface detection and sentinel chat-state single-writer policy
// guards shared by the chat store modules.
import {
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  PIPELINE_EDITOR_REQUIRED_SKILL_NAME,
  PIPELINE_EDITOR_REQUIRED_SKILL_REF,
} from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { isCoworkChatTarget } from '@/lib/cowork';
import {
  isWorktreeArchiveSuppressedForChatActivity,
  useProjectsStore,
} from '../projectsStore';
import { useNavigationStore } from '../navigationStore';

// ---------------------------------------------------------------------------
// Sentinel chat-state single-writer policy
// ---------------------------------------------------------------------------
//
// The App Advisor sentinel `(APP_ADVISOR_PROJECT_ID, APP_ADVISOR_WORKTREE_ID)`
// chat state lives in BOTH renderers (the main window keeps a read-only
// mirror so the Sidebar can derive thinking/unread status; the App Advisor
// window owns the authoritative writes). Without a guard, both renderers
// would issue commands for the same target and race on
// `activeTabId`/unread/tab metadata.
//
// `__chatStoreSurface` records which renderer this module instance is
// running in (detected from the URL `surface` parameter at module load
// time, matching `main.tsx`'s `getRendererSurface`). All sentinel writes
// (typed commands, sentinel `activeTabId` mutations, sentinel
// `attentionDismissedAt` persistence) are gated by `isSentinelWriteAllowed`
// so only the App Advisor renderer ever issues the canonical persisted
// state. The main renderer is restricted to nav-status-derivation
// in-memory updates (tab `status`/`unread`/`attentionDismissedAt`/
// `description`) — see Phase 8 of the frontend plan.
//
// Do NOT relax this guard to dual-writer behavior. Manual check 15 in the
// plan ("send several messages while hidden, reopen, transcript matches
// the nav-status implied") and the chat-store sentinel tests verify
// ownership stays one-sided.
export function detectChatStoreSurface(): 'main' | 'app-advisor' {
  if (typeof window === 'undefined' || !window.location) return 'main';
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('surface') === 'app-advisor' ? 'app-advisor' : 'main';
  } catch {
    return 'main';
  }
}

export const __chatStoreSurface: 'main' | 'app-advisor' =
  detectChatStoreSurface();

/**
 * Recognizes any App Advisor chat target. App Advisor chats are entry-keyed
 * `(app-advisor, <workEntryId>)` (the legacy read-only pre-entry slot keeps
 * `worktreeId === 'global'`), so recognition is PROJECT-ONLY. The reserved
 * `app-advisor` project id can never collide with a real workspace, so a
 * foreign project whose worktreeId happens to be `'global'` is never
 * misclassified — the `worktreeId` parameter exists only for call-site
 * symmetry with the other sentinel detectors.
 */
export function isAppAdvisorChatTarget(
  projectId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _worktreeId?: string,
): boolean {
  return projectId === APP_ADVISOR_PROJECT_ID;
}

/**
 * The legacy pre-entry App Advisor slot `(app-advisor, 'global')`. Read-only:
 * it is not a valid destination for new messages and exists only so archived
 * pre-entry history remains browsable.
 */
export function isLegacyAppAdvisorGlobalTarget(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    projectId === APP_ADVISOR_PROJECT_ID &&
    worktreeId === APP_ADVISOR_WORKTREE_ID
  );
}

/**
 * The embedded pipeline-editor assistant runs in the main window against the
 * pipeline-editor sentinel target. Like the other sentinel chats it is a
 * synthetic (non-worktree) target, and — unlike a normal Claude worktree chat —
 * it must always use the Canopy-native SDK runtime: the managed Claude Code
 * terminal cannot host the pipeline-editor MCP tools (and crashes in the
 * scratch cwd), so this target is forced to `canopy` interface mode everywhere.
 */
export function isPipelineEditorChatTarget(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    projectId === PIPELINE_EDITOR_PROJECT_ID &&
    worktreeId === PIPELINE_EDITOR_WORKTREE_ID
  );
}

export function withRequiredPipelineEditorSkill(
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections {
  const base: ChatTabPluginSelections = selections ?? {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
  };
  return {
    ...base,
    skillRefs: [
      ...(base.skillRefs ?? []).filter(
        (ref) => ref.skillName !== PIPELINE_EDITOR_REQUIRED_SKILL_NAME,
      ),
      PIPELINE_EDITOR_REQUIRED_SKILL_REF,
    ],
  };
}

export function withRequiredPluginSelectionsForTarget(
  projectId: string,
  worktreeId: string,
  selections: ChatTabPluginSelections | undefined,
): ChatTabPluginSelections | undefined {
  return isPipelineEditorChatTarget(projectId, worktreeId)
    ? withRequiredPipelineEditorSkill(selections)
    : selections;
}

/**
 * Returns true when this renderer is allowed to persist/mutate the
 * canonical chat state for `(projectId, worktreeId)`. For non-sentinel
 * targets this is always true; for the App Advisor sentinel target only
 * the App Advisor renderer (`__chatStoreSurface === 'app-advisor'`) may
 * write. The main renderer falls through to in-memory-only nav-status
 * derivation when this returns false.
 */
export function isSentinelWriteAllowed(
  projectId: string,
  worktreeId: string,
): boolean {
  if (!isAppAdvisorChatTarget(projectId, worktreeId)) return true;
  return __chatStoreSurface === 'app-advisor';
}

export function isReadOnlyAppAdvisorMirrorTarget(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    isAppAdvisorChatTarget(projectId, worktreeId) &&
    !isSentinelWriteAllowed(projectId, worktreeId)
  );
}

export function isSyntheticChatTarget(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    isCoworkChatTarget(projectId) ||
    projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    projectId === CODE_REVIEW_CHAT_PROJECT_ID ||
    isAppAdvisorChatTarget(projectId, worktreeId) ||
    isPipelineEditorChatTarget(projectId, worktreeId)
  );
}

/**
 * Whether closing a used chat tab archives it into the worktree
 * `ArchivedChatsFile` instead of hard-deleting. Cowork chats archive through
 * this same standard flow; the remaining synthetic scopes stay hard-delete.
 */
export function shouldArchiveChatTargetOnClose(
  projectId: string,
  worktreeId: string,
): boolean {
  return (
    isCoworkChatTarget(projectId) ||
    !isSyntheticChatTarget(projectId, worktreeId)
  );
}

export function canReceiveWorktreeChatActivity(
  projectId: string,
  worktreeId: string,
): boolean {
  if (isSyntheticChatTarget(projectId, worktreeId)) {
    return true;
  }

  if (isWorktreeArchiveSuppressedForChatActivity(projectId, worktreeId)) {
    return true;
  }

  const projectsState = useProjectsStore.getState();
  return canNavigateToWorktreeFromSidebarItems(
    projectsState.projects,
    projectId,
    worktreeId,
    projectsState.hasHydratedProjects,
  );
}

export function isAppAdvisorWindowFocused(): boolean {
  const navigation = useNavigationStore.getState();
  return navigation.appAdvisorOpen && navigation.appAdvisorFocused;
}
