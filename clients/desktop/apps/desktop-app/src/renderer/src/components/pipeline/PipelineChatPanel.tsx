import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
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
import { TitlebarIconButton } from '@canopy/ui-shared/components';
import { ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon } from '@canopy/ui-shared/icons/AppIcons';
import { PipelineAssistantStarters } from './PipelineAssistantStarters';
import { PipelineAssistantTabStrip } from './PipelineAssistantTabStrip';
import type { PipelineAssistantContext } from './pipelineAssistantSuggestions';
import { PIPELINE_EDITOR_CHAT_KEY } from './pipelineAssistantDraft';
import { openPipelineAssistantChat } from './pipelineAssistantConversation';
import { PIPELINE_ASSISTANT_NEW_CHAT_EVENT } from '@/lib/pipelineAssistantEvents';

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
  /**
   * Collapse the list's drawer (owned by the page so width/visibility
   * persist). The edit view's assistant always shows, so it has none.
   */
  onCollapse?: () => void;
  /**
   * The edge the panel sits on: `end` beside the Workflows list, `start` in
   * an open workflow's edit view (CAN-4319), where the chat leads in its own
   * card.
   */
  placement?: 'start' | 'end';
  /** A new workflow: an empty chat offers starters. */
  creating?: boolean;
  /**
   * The open saved workflow: an empty chat offers what to ask or change
   * about it (CAN-4319).
   */
  assistantContext?: PipelineAssistantContext;
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
  placement = 'end',
  creating = false,
  assistantContext,
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

  // Hydrate persisted tabs for the sentinel target, then pick the composer's
  // chat: a new one when a new workflow asked for it (CAN-4319), else the one
  // it had. `loadTabsForTarget` short-circuits once the slice is hydrated, so
  // re-mounting the drawer is cheap and idempotent.
  const loadedRef = useRef(false);
  // Placement remounts the panel, so this stays what it mounted with.
  const editViewRef = useRef(placement === 'start');
  // An edit view shows no chat until it has picked one: a starter or a
  // keystroke must not land in the chat a new one is about to replace.
  const [chatPicked, setChatPicked] = useState(placement !== 'start');
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
        // Show whatever chat there is rather than none.
        if (!cancelled) setChatPicked(true);
        return;
      }
      if (cancelled) return;
      loadedRef.current = true;
      openPipelineAssistantChat(editViewRef.current);
      setChatPicked(true);
    })();
    // A new workflow opened while the loaded edit view stays mounted.
    const handleNewChat = (): void => {
      if (loadedRef.current && editViewRef.current) {
        openPipelineAssistantChat(true);
      }
    };
    window.addEventListener(PIPELINE_ASSISTANT_NEW_CHAT_EVENT, handleNewChat);
    return (): void => {
      cancelled = true;
      window.removeEventListener(
        PIPELINE_ASSISTANT_NEW_CHAT_EVENT,
        handleNewChat,
      );
    };
  }, []);

  const activeTabId = chat?.activeTabId;
  const activeTab = useMemo(() => {
    if (!chatPicked) return null;
    const found = (chat?.tabs ?? []).find((tab) => tab.id === activeTabId);
    return found && found.kind !== 'file' ? found : null;
  }, [chat?.tabs, activeTabId, chatPicked]);
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

  const inEditView = placement === 'start';
  return (
    <section
      aria-label="Workflow assistant"
      data-testid="pipeline-chat-panel"
      // In the edit view the assistant is a panel card like a worktree's
      // (CAN-4319): the panel group frame, its tab row on top. Beside the
      // list it is a bordered drawer with a titled header.
      className={
        inEditView
          ? 'canopy-panel-group'
          : 'flex h-full min-h-0 w-full flex-col border-l bg-card'
      }
      data-placement={placement}
      // The tab row reads as part of the card, as a worktree chat's does
      // above a conversation's start.
      {...(inEditView ? { 'data-title-edge': 'top' } : {})}
    >
      {inEditView ? (
        <PipelineAssistantTabStrip />
      ) : (
        <>
          {/* This header sits in the top 40px band that `App.tsx` paints as
              an OS window-drag rect (`app-main-titlebar-drag-region`, which
              spans the whole main shell including this drawer column).
              app-region hit testing ignores z-order, so `electron-no-drag` on
              the button is load-bearing (`TitlebarIconButton` carries it):
              without it the collapse control receives a window drag instead
              of a click for real mice. Playwright's synthetic clicks bypass
              app-region, so only a computed-region assertion catches this.
              The title keeps dragging the window, matching the band beside
              it. */}
          <div className="flex h-10 shrink-0 items-center justify-between border-b px-3">
            <span className="select-none text-s font-semibold fg-primary">
              Workflow Assistant
            </span>
            {onCollapse ? (
              <TitlebarIconButton
                icon={AppCatalogChevronRightMediumIcon}
                iconSize={14}
                onClick={onCollapse}
                aria-label="Hide workflow assistant"
                data-testid="pipeline-chat-collapse"
              />
            ) : null}
          </div>

          {/* Reuse the shared chat tab bar (provider icons, right-click
              context menu with pin / close-others, drag-reorder, and
              close-last-tab → new-empty-tab) bound to the pipeline-editor
              sentinel scope. `dragRegion={false}` keeps the embedded strip
              from acting as a window-drag handle. */}
          <ChatTabBar
            scope={PIPELINE_EDITOR_TARGET}
            dragRegion={false}
            dataTestId="pipeline-chat-tabs"
          />
        </>
      )}

      {/* The whole chat takes dropped files (see ChatDropOverlay). */}
      <div
        data-chat-drop-zone
        // Chat keeps plain line breaks (see canopy-tokens-core.css).
        data-chat-window
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <ChatContent
          transcript={transcript}
          composerTab={composerTab}
          targetOverride={targetOverride}
          hideComposer={!activeTab}
          {...((creating || assistantContext) && activeTab
            ? {
                emptyStateCenter: (
                  <PipelineAssistantStarters
                    tabId={activeTab.id}
                    {...(!creating && assistantContext
                      ? { context: assistantContext }
                      : {})}
                  />
                ),
                emptyStateCenterPlacement: 'center',
              }
            : {})}
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
