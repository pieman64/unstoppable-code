import { useEffect, useMemo, type JSX } from 'react';
import {
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
} from '@canopy/desktop-shared/types';
import { PIPELINE_EDITOR_REQUIRED_SKILL_REF } from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import {
  useChatStore,
  useChatTabRenderState,
  useWorktreeChatRenderState,
} from '@/stores/chatStore';
import { ChatContent } from '@/components/chat/ChatContent';
import { ChatTabBar } from '@/components/chat/ChatTabBar';
import {
  toActiveComposerView,
  toActiveTranscriptView,
} from '@/components/chat/types';
import { Tooltip } from '@canopy/ui-shared';
import { ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

const PIPELINE_EDITOR_CHAT_KEY = `${PIPELINE_EDITOR_PROJECT_ID}/${PIPELINE_EDITOR_WORKTREE_ID}`;

const PIPELINE_EDITOR_TARGET = {
  projectId: PIPELINE_EDITOR_PROJECT_ID,
  worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
} as const;

/**
 * The bundled skill the pipeline-editor assistant always requires. The backend
 * force-injects it into the effective plugin selections server-side regardless
 * of stored selections; the renderer surfaces it here as a locked picker row so
 * the user cannot remove it. `builtin:app` is the bundled-skill source id (see
 * `BUILTIN_SOURCE_ID` on the main process).
 */
const REQUIRED_PIPELINE_SKILL_REFS = [PIPELINE_EDITOR_REQUIRED_SKILL_REF];

interface PipelineChatPanelProps {
  /** Collapse the drawer (owned by the page so width/visibility persist). */
  onCollapse: () => void;
}

/**
 * Embedded pipeline-editor chat drawer. Reuses the proven `ChatContent`
 * surface bound to the pipeline-editor sentinel target
 * ({@link PIPELINE_EDITOR_PROJECT_ID} / {@link PIPELINE_EDITOR_WORKTREE_ID}),
 * so multi-tab support comes for free from `chatStore.worktreeChats` keyed by
 * that target. Routing to the pipeline-editor runtime happens on the main
 * process by sentinel target — the renderer never sets `assistantMode`, so the
 * normal `chatStore.sendMessage(targetOverride)` path is all that is needed.
 *
 * Modeled on `StandaloneChatPage` / `AppAdvisorDialog`; the tab strip reuses
 * the shared `ChatTabBar` bound to the sentinel scope so it matches the
 * worktree / App Advisor tab UX (provider icons, context menu, drag-reorder,
 * close-last-tab → new-empty-tab) without a mirror store.
 */
export function PipelineChatPanel({
  onCollapse,
}: PipelineChatPanelProps): JSX.Element {
  const clearQueuedMessage = useChatStore((s) => s.clearQueuedMessage);
  const forceQueuedMessage = useChatStore((s) => s.forceQueuedMessage);
  const setEditingQueuedMessage = useChatStore(
    (s) => s.setEditingQueuedMessage,
  );
  const saveEditedQueuedMessage = useChatStore(
    (s) => s.saveEditedQueuedMessage,
  );

  const chat = useWorktreeChatRenderState(
    PIPELINE_EDITOR_CHAT_KEY,
    (worktreeChat) => worktreeChat,
  );

  // Hydrate persisted tabs for the sentinel target and guarantee a composer
  // target on mount. `loadTabsForTarget` short-circuits once the slice is
  // hydrated, so re-mounting the drawer is cheap and idempotent.
  useEffect(() => {
    let cancelled = false;
    void (async (): Promise<void> => {
      let pluginSelections;
      try {
        const prefs = await window.api.loadPreferences();
        pluginSelections = prefs.pipelineEditorPluginSelections;
      } catch {
        pluginSelections = undefined;
      }
      if (cancelled) return;
      try {
        await useChatStore
          .getState()
          .loadTabsForTarget(
            PIPELINE_EDITOR_PROJECT_ID,
            PIPELINE_EDITOR_WORKTREE_ID,
            pluginSelections ? { pluginSelections } : undefined,
          );
      } catch {
        return;
      }
      if (cancelled) return;
      void useChatStore
        .getState()
        .ensureWorktreeHasChatTab(PIPELINE_EDITOR_TARGET);
    })();
    return (): void => {
      cancelled = true;
    };
  }, []);

  const activeTabId = chat?.activeTabId;
  const activeTab = useMemo(() => {
    const found = (chat?.tabs ?? []).find((tab) => tab.id === activeTabId);
    return found && found.kind !== 'file' ? found : null;
  }, [chat?.tabs, activeTabId]);
  const activeLastActivityAt = useChatTabRenderState(
    activeTabId ? { ...PIPELINE_EDITOR_TARGET, chatId: activeTabId } : null,
    ({ runtime }) => (activeTabId ? runtime?.lastActivityAt : undefined),
  );

  // Focus the composer when the active tab changes (matches the worktree /
  // App Advisor chat surfaces).
  const activeTabFocusId = activeTab?.id;
  useEffect(() => {
    if (!activeTabFocusId) return;
    const frame = requestAnimationFrame(() => {
      // The panel mounts with the Workflows › Pipelines tab, so a keyboard
      // user arrowing through the tabs must keep focus there (CAN-3980).
      if (document.activeElement?.closest('[role="tablist"]')) return;
      document.dispatchEvent(new CustomEvent('canopy:focus-chat-input'));
    });
    return (): void => cancelAnimationFrame(frame);
  }, [activeTabFocusId]);

  const transcript = activeTab ? toActiveTranscriptView(activeTab) : null;
  const composerTab = activeTab
    ? toActiveComposerView(activeTab, {
        includeActiveAgentStep: true,
        lastActivityAt: activeLastActivityAt,
      })
    : null;
  const targetOverride = activeTab
    ? { ...PIPELINE_EDITOR_TARGET, chatId: activeTab.id }
    : undefined;

  return (
    <section
      aria-label="Pipeline assistant"
      data-testid="pipeline-chat-panel"
      className="flex h-full min-h-0 w-full flex-col border-l bg-card"
    >
      {/* This header sits in the top 40px band that `App.tsx` paints as an OS
          window-drag rect (`app-main-titlebar-drag-region`, which spans the
          whole main shell including this drawer column). app-region hit
          testing ignores z-order, so `electron-no-drag` on the button is
          load-bearing: without it the collapse control receives a window drag
          instead of a click for real mice. Playwright's synthetic clicks
          bypass app-region, so only a computed-region assertion catches this.
          The title keeps dragging the window, matching the band beside it. */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
        <span className="select-none text-s font-semibold fg-primary">
          Pipeline Assistant
        </span>
        <Tooltip label="Hide pipeline assistant">
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Hide pipeline assistant"
            data-testid="pipeline-chat-collapse"
            className="electron-no-drag focus-ring inline-flex h-7 w-7 items-center justify-center rounded-md fg-secondary transition-colors hover:bg-fg-primary/[0.06] hover:fg-primary"
          >
            <AppCatalogChevronRightMediumIcon
              width="14"
              height="14"
              aria-hidden="true"
            />
          </button>
        </Tooltip>
      </div>

      {/* Reuse the shared chat tab bar (provider icons, right-click context
          menu with pin / close-others, drag-reorder, and close-last-tab →
          new-empty-tab) bound to the pipeline-editor sentinel scope, matching
          the worktree / App Advisor chat tab UX. `dragRegion={false}` keeps the
          embedded strip from acting as a window-drag handle. */}
      <ChatTabBar
        scope={PIPELINE_EDITOR_TARGET}
        dragRegion={false}
        dataTestId="pipeline-chat-tabs"
      />

      {/* The whole chat takes dropped files (see ChatDropOverlay). */}
      <div
        data-chat-drop-zone
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <ChatContent
          transcript={transcript}
          composerTab={composerTab}
          targetOverride={targetOverride}
          hideComposer={!activeTab}
          hideBranchActions
          hidePlanMode
          hideDirectoryPicker
          disableTerminalMode
          disableFileTypeahead
          lockedSkillRefs={REQUIRED_PIPELINE_SKILL_REFS}
          onClearQueuedMessage={(index): void => {
            if (targetOverride) clearQueuedMessage(index, targetOverride);
          }}
          onForceQueuedMessage={(index): void => {
            if (targetOverride) forceQueuedMessage(index, targetOverride);
          }}
          onEditQueuedMessage={(index, message): void => {
            if (targetOverride)
              void setEditingQueuedMessage(index, targetOverride, message);
          }}
          onCancelEditQueuedMessage={(): void => {
            if (targetOverride)
              void setEditingQueuedMessage(null, targetOverride);
          }}
          onSaveEditQueuedMessage={(
            index,
            text,
            fileReferences,
            attachmentPaths,
            attachmentPromptContexts,
            inputMode,
            scheduledSendDraft,
            expected,
          ): void => {
            if (!targetOverride) return;
            saveEditedQueuedMessage(
              index,
              text,
              fileReferences,
              attachmentPaths,
              attachmentPromptContexts,
              inputMode,
              scheduledSendDraft,
              targetOverride,
              expected,
            );
          }}
        />
      </div>
    </section>
  );
}
