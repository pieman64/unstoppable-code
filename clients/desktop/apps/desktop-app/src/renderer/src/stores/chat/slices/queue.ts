import { MESSAGE_NO_LONGER_EDITABLE_NOTICE } from '@canopy/ui-shared/components';
import { getWorktreeChatContext } from '../context';
import { getChatToastAttribution } from '../notifications';
import { useGitHubStore } from '../../githubStore';
import { blockedPersistenceKeys } from '../persistence';
import { isTerminalBackedInterfaceMode } from '@canopy/desktop-shared/types';
import { useClaudeTerminalStore } from '@/stores/claudeTerminalStore';
import { attachmentMetasFromPaths } from '../attachments';
import {
  cancelProvisionalFirstSendQueue,
  resumeQueuedProvisionalFirstSend,
} from '../provisional-first-send';
import { type ChatTab, type QueuedChatMessage } from '../types';
import {
  clearWorktreeHydrationState,
  recordWorktreeChatTouch,
  removeWorktreeRuntimeState,
  scheduleIdleChatUnload,
} from '../hydration';
import { clearQueuedForSetupFlag } from '../tab-utils';
import { emitSetupQueueDispatch } from '../setup-queue-dispatch';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatQueueSlice } from '../state';

// The pending host lock request per edited entry. Leaving the editor (cancel,
// switch, or save) forgets the attempt, so a rejection the host reports only
// because that unlock or edit landed first is not mistaken for a lost message.
const pendingEditLocks = new Map<string, symbol>();

function editLockKey(key: string, chatId: string, entryId: string): string {
  return JSON.stringify([key, chatId, entryId]);
}

export const createQueueSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatQueueSlice
> = (set, get, api) => ({
  clearQueuedMessage: (index, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, key, chatId, activeTab } = context;
    const targetMessage = activeTab?.queuedMessages[index];
    const queuedHookQueueId = targetMessage?.queuedHookQueueId;
    const isHookPlaceholder = queuedHookQueueId !== undefined;

    if (isHookPlaceholder) {
      void window.api.chat
        .cancelQueuedHookChat({
          queueId: queuedHookQueueId,
        })
        .then(
          ({ cancelled }) => {
            if (!cancelled) {
              return;
            }

            set((state) => {
              const currentWc = state.worktreeChats[key];
              if (!currentWc) return state;

              const currentTab = currentWc.tabs.find(
                (tab) => tab.id === chatId,
              );
              const currentMessage = currentTab?.queuedMessages[index];
              if (
                currentTab?.queuedHookPlaceholder !== true ||
                currentMessage?.queuedHookQueueId !== queuedHookQueueId
              ) {
                return state;
              }

              const filteredTabs = currentWc.tabs.filter(
                (tab) => tab.id !== chatId,
              );
              const previousActiveTabId = currentWc.activeTabId;
              const nextActiveTabId =
                previousActiveTabId === chatId
                  ? (filteredTabs[filteredTabs.length - 1]?.id ?? '')
                  : previousActiveTabId;
              const updated = {
                ...currentWc,
                tabs: filteredTabs,
                activeTabId: nextActiveTabId,
              };
              return {
                worktreeChats: {
                  ...state.worktreeChats,
                  [key]: updated,
                },
              };
            });
          },
          () => {
            // Leave the placeholder intact so the user can retry cancellation.
          },
        );
      return;
    }

    if (targetMessage?.hostQueueEntryId) {
      void window.api.chat.cancelQueuedMessage({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        entryId: targetMessage.hostQueueEntryId,
      });
      return;
    }

    const acceptedInputId = targetMessage?.dispatchOptions?.acceptedInputId;
    const removeLocal = (): void => {
      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;

        const updatedTabs = currentWc.tabs.map((t) =>
          t.id === chatId
            ? {
                ...cancelProvisionalFirstSendQueue(
                  t,
                  targetMessage?.dispatchOptions?.userMessageId,
                ),
                queuedMessages: t.queuedMessages.filter((message, i) =>
                  acceptedInputId
                    ? message.dispatchOptions?.acceptedInputId !==
                      acceptedInputId
                    : i !== index,
                ),
              }
            : t,
        );
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs: updatedTabs },
          },
        };
      });
    };
    if (!acceptedInputId) {
      removeLocal();
      return;
    }
    // Main retains accepted agent input; settle it first so it can never be
    // delivered later. A refusal keeps the entry so the user can retry.
    void window.api.chat
      .cancelQueuedMessage({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        entryId: acceptedInputId,
      })
      .then(removeLocal, () => undefined);
  },

  forceQueuedMessage: (index, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, key, chatId, activeTab } = context;
    const targetMessage = activeTab?.queuedMessages[index];
    if (!activeTab || !targetMessage || activeTab.queuedForSetup === true) {
      return;
    }

    if (targetMessage.queuedHookQueueId) {
      void window.api.chat
        .forceQueuedHookChat({
          queueId: targetMessage.queuedHookQueueId,
        })
        .catch(() => {
          // Leave the placeholder intact so the user can retry forcing it.
        });
      return;
    }

    if (targetMessage.hostQueueEntryId) {
      void window.api.chat.forceQueuedMessage({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        entryId: targetMessage.hostQueueEntryId,
      });
      return;
    }

    // Host queues above dispatch by entry id. Legacy local queues drain their
    // head once cancellation settles, so promote only the selected prompt.
    const promoteTarget = (queued: QueuedChatMessage[]): QueuedChatMessage[] =>
      queued[index] === targetMessage
        ? [targetMessage, ...queued.filter((_, i) => i !== index)]
        : queued;

    if (activeTab.status === 'streaming') {
      if (isTerminalBackedInterfaceMode(activeTab.interfaceMode)) {
        const runtime = useClaudeTerminalStore
          .getState()
          .getStateForChat(sel.projectId, sel.worktreeId, chatId);
        if (runtime?.terminalId) {
          set((state) => {
            const currentWc = state.worktreeChats[key];
            if (!currentWc) return state;

            const updatedTabs = currentWc.tabs.map((tab) =>
              tab.id === chatId
                ? {
                    ...tab,
                    queuedMessages: promoteTarget(tab.queuedMessages),
                    forceQueuedMessageCancelPending: true,
                  }
                : tab,
            );
            return {
              worktreeChats: {
                ...state.worktreeChats,
                [key]: { ...currentWc, tabs: updatedTabs },
              },
            };
          });
          void window.api.terminal
            .write({ terminalId: runtime.terminalId, data: '\x03' })
            .catch(() => {
              set((state) => {
                const currentWc = state.worktreeChats[key];
                if (!currentWc) return state;
                const updatedTabs = currentWc.tabs.map((tab) =>
                  tab.id === chatId
                    ? {
                        ...tab,
                        forceQueuedMessageCancelPending: undefined,
                      }
                    : tab,
                );
                return {
                  worktreeChats: {
                    ...state.worktreeChats,
                    [key]: { ...currentWc, tabs: updatedTabs },
                  },
                };
              });
            });
          return;
        }
      }

      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;

        const updatedTabs = currentWc.tabs.map((tab) =>
          tab.id === chatId
            ? {
                ...tab,
                queuedMessages: promoteTarget(tab.queuedMessages),
                forceQueuedMessageCancelPending: true,
              }
            : tab,
        );
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs: updatedTabs },
          },
        };
      });
      void get().cancelSession({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
      });
      return;
    }

    const restoredAttachments = attachmentMetasFromPaths(
      targetMessage.attachmentPaths,
      targetMessage.attachmentPromptContexts,
    );
    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;
      const updatedTabs = currentWc.tabs.map((tab) =>
        tab.id === chatId
          ? {
              ...tab,
              queuedMessages: tab.queuedMessages.filter(
                (message) => message !== targetMessage,
              ),
              pendingAttachments: restoredAttachments,
            }
          : tab,
      );
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: { ...currentWc, tabs: updatedTabs },
        },
      };
    });
    void get().sendMessage(
      targetMessage.text,
      targetMessage.fileReferences,
      {
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
      },
      targetMessage.inputMode,
      targetMessage.dispatchOptions,
    );
  },

  setEditingQueuedMessage: async (
    requestedIndex,
    target,
    expected,
  ): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, key, chatId, activeTab } = context;
    const attemptKey = editLockKey(key, chatId, '');
    const notifyUnavailable = (error?: unknown): void => {
      const { meta, onClick } = getChatToastAttribution({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
      });
      useGitHubStore
        .getState()
        .addToast(
          error instanceof Error
            ? error.message
            : MESSAGE_NO_LONGER_EDITABLE_NOTICE,
          'error',
          onClick,
          meta,
        );
    };
    const updateEditing = (
      index: number | null,
      focusAllowed = true,
      pendingId?: string,
    ): void => {
      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: {
              ...wc,
              tabs: wc.tabs.map((tab) => {
                if (tab.id !== chatId) return tab;
                const next = { ...tab };
                if (pendingId) next.pendingQueuedMessageEditId = pendingId;
                else delete next.pendingQueuedMessageEditId;
                if (index === null) {
                  delete next.editingQueuedMessageIndex;
                  delete next.editingQueuedMessageFocusAllowed;
                } else {
                  next.editingQueuedMessageIndex = index;
                  next.editingQueuedMessageFocusAllowed = focusAllowed;
                }
                return next;
              }),
            },
          },
        };
      });
    };
    if (requestedIndex === null) {
      pendingEditLocks.delete(attemptKey);
      const previousIndex = activeTab?.editingQueuedMessageIndex;
      const previousEntryId =
        previousIndex === undefined
          ? undefined
          : activeTab?.queuedMessages[previousIndex]?.hostQueueEntryId;
      updateEditing(null);
      if (previousEntryId) {
        await window.api.chat.setQueuedMessageEditLock({
          ...sel,
          chatId,
          entryId: previousEntryId,
          locked: false,
        });
      } else if (
        activeTab?.status === 'idle' &&
        activeTab.queuedMessages.length > 0
      ) {
        get().forceQueuedMessage(0, { ...sel, chatId });
      }
      return;
    }
    if (pendingEditLocks.has(attemptKey)) return;
    const queued = activeTab?.queuedMessages ?? [];
    const index = expected
      ? queued.findIndex(
          (candidate) =>
            candidate === expected ||
            (expected.hostQueueEntryId !== undefined &&
              candidate.hostQueueEntryId === expected.hostQueueEntryId),
        )
      : requestedIndex;
    const message = queued[index];
    if (
      !message ||
      message.pendingSend ||
      message.queuedHookQueueId ||
      message.editLocked ||
      activeTab?.editingQueuedMessageIndex !== undefined
    ) {
      notifyUnavailable();
      return;
    }
    if (!message.hostQueueEntryId) {
      updateEditing(index);
      return;
    }
    const entryId = message.hostQueueEntryId;
    const attempt = Symbol(entryId);
    pendingEditLocks.set(attemptKey, attempt);
    updateEditing(null, true, entryId);
    const selection = get().selectedWorktree;
    const activeTabId = get().worktreeChats[key]?.activeTabId;
    const stillInContext = (): boolean => {
      const current = get().selectedWorktree;
      return (
        current?.projectId === selection?.projectId &&
        current?.worktreeId === selection?.worktreeId &&
        get().worktreeChats[key]?.activeTabId === activeTabId
      );
    };
    const unsubscribe = api.subscribe(() => {
      if (!stillInContext() && pendingEditLocks.get(attemptKey) === attempt) {
        pendingEditLocks.delete(attemptKey);
        updateEditing(null);
      }
    });
    let focusMoved = false;
    const onFocus = (): void => {
      focusMoved = true;
    };
    globalThis.document?.addEventListener('focusin', onFocus);
    try {
      await window.api.chat.setQueuedMessageEditLock({
        ...sel,
        chatId,
        entryId,
        locked: true,
      });
      const currentTab = get().worktreeChats[key]?.tabs.find(
        (tab) => tab.id === chatId,
      );
      const currentIndex =
        currentTab?.queuedMessages.findIndex(
          (row) => row.hostQueueEntryId === entryId,
        ) ?? -1;
      const currentMessage = currentTab?.queuedMessages[currentIndex];
      if (
        pendingEditLocks.get(attemptKey) !== attempt ||
        !stillInContext() ||
        !currentMessage ||
        currentMessage.pendingSend ||
        currentMessage.queuedHookQueueId ||
        currentTab?.editingQueuedMessageIndex !== undefined
      ) {
        // Only a successful acquisition owns a lock that this attempt may release.
        await window.api.chat.setQueuedMessageEditLock({
          ...sel,
          chatId,
          entryId,
          locked: false,
        });
        if (pendingEditLocks.get(attemptKey) === attempt && stillInContext())
          notifyUnavailable();
        return;
      }
      updateEditing(currentIndex, !focusMoved);
    } catch (error) {
      if (pendingEditLocks.get(attemptKey) === attempt && stillInContext())
        notifyUnavailable(error);
    } finally {
      unsubscribe();
      globalThis.document?.removeEventListener('focusin', onFocus);
      if (pendingEditLocks.get(attemptKey) === attempt) {
        pendingEditLocks.delete(attemptKey);
        const currentTab = get().worktreeChats[key]?.tabs.find(
          (tab) => tab.id === chatId,
        );
        if (currentTab?.pendingQueuedMessageEditId) updateEditing(null);
      }
    }
  },

  saveEditedQueuedMessage: (
    requestedIndex,
    text,
    fileReferences,
    attachmentPaths,
    attachmentPromptContexts,
    inputMode,
    scheduledSendDraft,
    target,
    expected,
  ): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { selection: sel, key, chatId, activeTab } = context;
    const notifyFailure = (error?: unknown): void => {
      const { meta, onClick } = getChatToastAttribution({ ...sel, chatId });
      useGitHubStore
        .getState()
        .addToast(
          error instanceof Error
            ? error.message
            : MESSAGE_NO_LONGER_EDITABLE_NOTICE,
          'error',
          onClick,
          meta,
        );
    };
    const index = expected
      ? (activeTab?.queuedMessages.findIndex(
          (candidate) =>
            candidate === expected ||
            (expected.hostQueueEntryId !== undefined &&
              candidate.hostQueueEntryId === expected.hostQueueEntryId),
        ) ?? -1)
      : requestedIndex;
    if (index < 0 || !activeTab?.queuedMessages[index]) {
      notifyFailure();
      return;
    }
    const hostQueueEntryId = activeTab.queuedMessages[index]?.hostQueueEntryId;
    if (hostQueueEntryId) {
      pendingEditLocks.delete(editLockKey(key, chatId, ''));
      // Close the editor before the host round-trip. Queue refreshes preserve
      // the currently edited host entry by id, so leaving this index set would
      // remount the stale editor even after the host accepted the new text.
      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;
        const updatedTabs = currentWc.tabs.map((tab) => {
          if (
            tab.id !== chatId ||
            tab.editingQueuedMessageIndex === undefined
          ) {
            return tab;
          }
          const nextTab = { ...tab };
          delete nextTab.editingQueuedMessageIndex;
          return nextTab;
        });
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs: updatedTabs },
          },
        };
      });

      void window.api.chat
        .editQueuedMessage({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
          entryId: hostQueueEntryId,
          text,
          ...(fileReferences ? { fileReferences } : {}),
          ...(attachmentPaths ? { attachmentPaths } : {}),
          ...(attachmentPromptContexts ? { attachmentPromptContexts } : {}),
          ...(inputMode ? { inputMode } : {}),
        })
        .catch((error: unknown) => {
          notifyFailure(error);
          // A failed edit leaves the host lock intact; release it so the queue
          // can continue draining after the local editor has closed.
          void window.api.chat.setQueuedMessageEditLock({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            chatId,
            entryId: hostQueueEntryId,
            locked: false,
          });
        });
      return;
    }

    // Main retains the attributed body of accepted agent input. Update it
    // before the local copy so the terminal write and transcript import agree;
    // the open editor holds the drain until main answers.
    const acceptedInputId =
      activeTab?.queuedMessages[index]?.dispatchOptions?.acceptedInputId;
    const applyLocalEdit = (applyText: boolean): void => {
      set((state) => {
        const currentWc = state.worktreeChats[key];
        if (!currentWc) return state;
        const updatedTabs = currentWc.tabs.map((tab) => {
          if (tab.id !== chatId) return tab;
          const targetIndex = acceptedInputId
            ? tab.queuedMessages.findIndex(
                (message) =>
                  message.dispatchOptions?.acceptedInputId === acceptedInputId,
              )
            : index;
          const existing = tab.queuedMessages[targetIndex];
          if (!existing || !applyText) {
            // Main refused the edit or the input already left: close the editor.
            if (!acceptedInputId) return tab;
            const nextTab = { ...tab };
            delete nextTab.editingQueuedMessageIndex;
            return nextTab;
          }
          const updatedMessage: QueuedChatMessage = {
            ...existing,
            text,
            ...(fileReferences && fileReferences.length > 0
              ? { fileReferences }
              : { fileReferences: undefined }),
            ...(attachmentPaths && attachmentPaths.length > 0
              ? { attachmentPaths }
              : { attachmentPaths: undefined }),
            ...(attachmentPromptContexts && attachmentPromptContexts.length > 0
              ? { attachmentPromptContexts }
              : { attachmentPromptContexts: undefined }),
            ...(inputMode ? { inputMode } : {}),
            ...(scheduledSendDraft
              ? { scheduledSendDraft }
              : { scheduledSendDraft: undefined }),
          };
          const nextMessages = tab.queuedMessages.slice();
          nextMessages[targetIndex] = updatedMessage;
          const nextTab: ChatTab = {
            ...tab,
            queuedMessages: nextMessages,
          };
          delete nextTab.editingQueuedMessageIndex;
          return nextTab;
        });
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...currentWc, tabs: updatedTabs },
          },
        };
      });

      const refreshedWc = get().worktreeChats[key];
      const refreshedTab = refreshedWc?.tabs.find((t) => t.id === chatId);
      if (
        refreshedTab &&
        refreshedTab.status === 'idle' &&
        refreshedTab.queuedMessages.length > 0 &&
        refreshedTab.editingQueuedMessageIndex === undefined
      ) {
        get().forceQueuedMessage(0, {
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
        });
      }
    };
    if (!acceptedInputId) {
      applyLocalEdit(true);
      return;
    }
    void window.api.chat
      .editQueuedMessage({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        entryId: acceptedInputId,
        text,
        ...(fileReferences ? { fileReferences } : {}),
        ...(attachmentPaths ? { attachmentPaths } : {}),
        ...(attachmentPromptContexts ? { attachmentPromptContexts } : {}),
        ...(inputMode ? { inputMode } : {}),
      })
      .then(
        () => applyLocalEdit(true),
        () => applyLocalEdit(false),
      );
  },

  flushPendingChatsForWorktree: (projectId, worktreeId): void => {
    const key = `${projectId}/${worktreeId}`;
    const wc = get().worktreeChats[key];
    if (!wc) return;
    recordWorktreeChatTouch(key);

    const flushable = wc.tabs.filter(
      (tab) =>
        tab.queuedForSetup === true &&
        tab.status === 'idle' &&
        tab.queuedMessages.length > 0,
    );
    if (flushable.length === 0) {
      // Still clear the marker even when there are no messages — e.g. the
      // queue was cancelled before git-ready arrived.
      const hasStaleMarker = wc.tabs.some((t) => t.queuedForSetup === true);
      if (hasStaleMarker) {
        set((state) => {
          const currentWc = state.worktreeChats[key];
          if (!currentWc) return state;
          const updatedTabs = currentWc.tabs.map((t) =>
            t.queuedForSetup ? clearQueuedForSetupFlag(t) : t,
          );
          return {
            worktreeChats: {
              ...state.worktreeChats,
              [key]: { ...currentWc, tabs: updatedTabs },
            },
          };
        });
      }
      return;
    }

    // Take the first message off each queued-for-setup tab and dispatch via
    // sendMessage with an explicit target. The post-streaming drain at the
    // bottom of handleChatEvent picks up the rest naturally.
    type TabSendContext = {
      tabId: string;
      message: QueuedChatMessage;
    };
    const dispatches: TabSendContext[] = [];

    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;
      const updatedTabs = currentWc.tabs.map((t) => {
        if (
          t.queuedForSetup !== true ||
          t.status !== 'idle' ||
          t.queuedMessages.length === 0
        ) {
          // Clear the marker if the status changed but there's no work left.
          if (t.queuedForSetup) {
            return clearQueuedForSetupFlag(t);
          }
          return t;
        }
        const [first, ...rest] = t.queuedMessages;
        dispatches.push({ tabId: t.id, message: first });
        const restoredAttachments = attachmentMetasFromPaths(
          first.attachmentPaths,
          first.attachmentPromptContexts,
        );
        return {
          ...resumeQueuedProvisionalFirstSend(
            clearQueuedForSetupFlag(t),
            first,
          ),
          queuedMessages: rest,
          pendingAttachments: restoredAttachments,
        };
      });
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: { ...currentWc, tabs: updatedTabs },
        },
      };
    });

    for (const { tabId, message } of dispatches) {
      void get().sendMessage(
        message.text,
        message.fileReferences,
        {
          projectId,
          worktreeId,
          chatId: tabId,
        },
        undefined,
        {
          ...message.dispatchOptions,
          onDispatchStarted: (): void => {
            emitSetupQueueDispatch({
              projectId,
              worktreeId,
              chatId: tabId,
              count: 1,
            });
            message.dispatchOptions?.onDispatchStarted?.();
          },
        },
      );
    }
  },

  dropWorktreeQueuedState: (projectId, worktreeId): void => {
    const key = `${projectId}/${worktreeId}`;
    set((state) => removeWorktreeRuntimeState(state, projectId, worktreeId));

    blockedPersistenceKeys.delete(key);
    clearWorktreeHydrationState(key);
    scheduleIdleChatUnload();
  },
});
