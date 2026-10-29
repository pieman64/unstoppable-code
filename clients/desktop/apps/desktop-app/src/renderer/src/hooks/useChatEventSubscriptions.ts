import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { subscribeToChatEvents } from '@/lib/chatEventFanout';
import { chatStoreRenderView, useChatStore } from '@/stores/chatStore';
import { windowFrameScheduler } from '@/stores/chat/frame-batched-store-view';
import { applyChatStateChangedForRender } from '@/stores/chat/render-cadence';
import { useAiCreditsBannerStore } from '@/stores/aiCreditsBannerStore';
import { useTransientRetryBannerStore } from '@/stores/transientRetryBannerStore';
import { invalidateAiCreditsAvailabilityCache } from '@/hooks/useAiCreditsAvailability';
import { invalidateSharedAiCreditsRead } from '@/lib/openBillingPage';
import {
  recordChatEventApplied,
  recordChatStateApplied,
} from '@/lib/renderer-diagnostics/recorder';
import { invalidateAiCreditsUsageCache } from '@/hooks/useAiCreditsUsage';
import type {
  ApprovalRequestEvent,
  ApprovalRuleAddedEvent,
  ChatEvent,
  ChatQueueUpdatedEvent,
  ChatSessionImportedEvent,
  ChatStateChangedEvent,
  ClaudeTerminalScheduledPromptEvent,
  DeferredToolsReloadEvent,
  HookChatTabStartedEvent,
  ChatTabDescriptionUpdatedEvent,
  McpAskUserEvent,
  PlanExitRequestEvent,
} from '@canopy/desktop-shared/types';
import {
  isAiCreditsNoBillingSourceEventData,
  isAiCreditsRoutingStatusEventData,
  isAiCreditsUsageLimitEventData,
  isNoBillingSourceErrorEventData,
  isTransientRetryStateEventData,
} from '@canopy/desktop-shared/types';

export function useChatEventSubscriptions(): void {
  const handleChatEvent = useChatStore((s) => s.handleChatEvent);
  const handleChatStateChanged = useChatStore((s) => s.handleChatStateChanged);
  const handleChatQueueUpdated = useChatStore((s) => s.handleChatQueueUpdated);
  const handleHookTabStarted = useChatStore((s) => s.handleHookTabStarted);
  const handleSessionImported = useChatStore((s) => s.handleSessionImported);
  const handleScheduledTerminalPrompt = useChatStore(
    (s) => s.handleScheduledTerminalPrompt,
  );
  const handleMcpAskUser = useChatStore((s) => s.handleMcpAskUser);
  const handleApprovalRequest = useChatStore((s) => s.handleApprovalRequest);
  const handleApprovalCancelled = useChatStore(
    (s) => s.handleApprovalCancelled,
  );
  const handleApprovalAutoResolved = useChatStore(
    (s) => s.handleApprovalAutoResolved,
  );
  const handleApprovalRuleAdded = useChatStore(
    (s) => s.handleApprovalRuleAdded,
  );
  const handlePlanExitRequest = useChatStore((s) => s.handlePlanExitRequest);
  const verifyStreamingTabs = useChatStore((s) => s.verifyStreamingTabs);
  const handleTabDescriptionUpdated = useChatStore(
    (s) => s.handleTabDescriptionUpdated,
  );
  const handleDeferredToolsReloadEvent = useChatStore(
    (s) => s.handleDeferredToolsReloadEvent,
  );

  // Revisioned canonical chat-state stream. Registered before any snapshot
  // query this renderer issues (listener-before-query): scopes hydrated via
  // `hydrateChatScopeRevisioned` buffer events received while their snapshot
  // request is pending and apply them in committed revision order.
  //
  // Every event applies to the store on arrival, so all non-React readers see
  // it at once. Streamed content (`isStreamedContentEvent`) reaches React
  // once per animation frame through `chatStoreRenderView`; any other store
  // update, user input, the window hiding, and unsubscribe publish it sooner.
  useEffect(() => {
    if (typeof window.api.chat.onStateChanged !== 'function') return;
    const scheduler = windowFrameScheduler();
    const flush = (): void => chatStoreRenderView.flush();
    // Input commits pending content before the event reaches React's
    // handlers, so they act on what is current. A dispatched event gets no
    // microtask checkpoint between listeners, so the render is flushed here.
    const flushForInput = (): void => {
      if (!chatStoreRenderView.hasPendingNotification()) return;
      flushSync(flush);
    };
    const flushWhenHidden = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('pointerdown', flushForInput, true);
    window.addEventListener('keydown', flushForInput, true);
    const unsubscribe = window.api.chat.onStateChanged(
      (event: ChatStateChangedEvent): void => {
        const startedAt = performance.now();
        applyChatStateChangedForRender(event, {
          apply: handleChatStateChanged,
          runtimeByChatId: useChatStore.getState().runtimeByChatId,
          view: chatStoreRenderView,
          scheduler,
        });
        recordChatStateApplied(event, startedAt);
      },
    );
    return (): void => {
      unsubscribe();
      flush();
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pointerdown', flushForInput, true);
      window.removeEventListener('keydown', flushForInput, true);
    };
  }, [handleChatStateChanged]);

  useEffect(() => {
    if (!window.api.chat.onChatQueueUpdated) return;
    const unsubscribe = window.api.chat.onChatQueueUpdated(
      (event: ChatQueueUpdatedEvent) => {
        handleChatQueueUpdated(event);
      },
    );
    return unsubscribe;
  }, [handleChatQueueUpdated]);

  useEffect(() => {
    let active = true;
    const retryTargetsUpdatedAfterSnapshotRequest = new Set<string>();
    const unsubscribe = subscribeToChatEvents((event: ChatEvent) => {
      const startedAt = performance.now();
      handleChatEvent(event);
      recordChatEventApplied(event, startedAt);
      // AI Credits routing status + usage-limit signals flow through the same
      // event pipeline for every surface, so feed the shared target-keyed banner
      // store here once — the shared banners then work on any surface (CAN-838).
      const target = {
        projectId: event.projectId,
        worktreeId: event.worktreeId,
        chatId: event.chatId,
      };
      if (isAiCreditsRoutingStatusEventData(event.data)) {
        useAiCreditsBannerStore
          .getState()
          .setRoutingActive(target, event.data.active);
      } else if (isAiCreditsUsageLimitEventData(event.data)) {
        useAiCreditsBannerStore.getState().setUsageLimit(target, {
          provider: event.data.provider,
          resetsAt: event.data.resetsAt,
        });
        // Credits were just exhausted for this provider — drop all three cached
        // AI Credits reads so they re-fetch immediately instead of showing stale
        // state until the TTL lapses: the availability cache so the model picker
        // re-gates gateway models (CAN-838), and the usage cache so the Usage
        // tile and the sidebar low-balance alert reflect the new balance.
        invalidateAiCreditsAvailabilityCache();
        invalidateAiCreditsUsageCache();
        // ...and the recovery flows' retained answer, which is a THIRD cache.
        // It gates whether the recovery modal auto-commits a model on coverage,
        // so leaving it behind here would let a click after exhaustion commit a
        // model that can no longer run.
        invalidateSharedAiCreditsRead();
      } else if (isAiCreditsNoBillingSourceEventData(event.data)) {
        // A turn reached the hosted gateway and nothing could pay for it
        // (CAN-2413). Distinct from the pre-flight abort below: this one
        // already failed mid-turn, so the composer banner is the only recovery
        // affordance the user gets besides the in-transcript notice.
        useAiCreditsBannerStore.getState().setNoBillingSource(target, {
          provider: event.data.provider,
        });
        // Same reason the usage-limit branch invalidates: the renderer's 60s
        // caches would otherwise keep reporting credits as spendable, which
        // both hides the banner's derived path and leaves gateway models
        // selectable as if the balance were fine.
        invalidateAiCreditsAvailabilityCache();
        invalidateAiCreditsUsageCache();
        // Same third cache as the usage-limit branch: this turn already proved
        // nothing can pay, so a retained "covered" answer must not survive to
        // auto-commit a model in the recovery modal.
        invalidateSharedAiCreditsRead();
      } else if (isNoBillingSourceErrorEventData(event.data)) {
        // The turn was aborted because nothing could pay for it (ECW-9091).
        // `NoBillingSourceBanner` is the visible remedy, but it gates on the
        // renderer's 60s availability cache while the backstop gates on the
        // main process's 30s routing context — so across a credits-exhaustion
        // transition the backstop can fire while the renderer still believes
        // credits are spendable and hides the banner. That would be a fully
        // silent send: no reply, no rendered error (the desktop transcript has
        // no error-string surface), and no usage-limit event to invalidate on,
        // because no provider request was ever made.
        //
        // Dropping all three cached reads closes that window: the banner and the
        // model picker re-gate on the next render instead of waiting out the
        // TTL. This is what makes the `error_code` an actual signal rather than
        // a marker, matching the Ollama precedent it was modeled on.
        invalidateAiCreditsAvailabilityCache();
        invalidateAiCreditsUsageCache();
        // The recovery flows' retained answer is the third; see the
        // usage-limit branch above.
        invalidateSharedAiCreditsRead();
      } else if (isTransientRetryStateEventData(event.data)) {
        // Transient provider-error retry state flows through the same event
        // pipeline; feed the shared target-keyed store so the retry banner
        // renders on any surface. `active: false` clears it.
        retryTargetsUpdatedAfterSnapshotRequest.add(
          `${target.projectId}/${target.worktreeId}/${target.chatId}`,
        );
        useTransientRetryBannerStore.getState().setState(target, event.data);
      }
    });
    void window.api.chat
      .getTransientRetrySnapshot()
      .then((entries) => {
        if (!active) return;
        for (const entry of entries) {
          if (
            retryTargetsUpdatedAfterSnapshotRequest.has(
              `${entry.projectId}/${entry.worktreeId}/${entry.chatId}`,
            )
          ) {
            continue;
          }
          useTransientRetryBannerStore.getState().setState(entry, entry.data);
        }
      })
      .catch((): void => {
        // Push events remain authoritative if the initial snapshot is
        // unavailable during renderer startup.
      });
    return (): void => {
      active = false;
      unsubscribe();
    };
  }, [handleChatEvent]);

  useEffect(() => {
    const unsubscribe = window.api.chat.onScheduledTerminalPrompt(
      (event: ClaudeTerminalScheduledPromptEvent) => {
        handleScheduledTerminalPrompt(event);
      },
    );
    return unsubscribe;
  }, [handleScheduledTerminalPrompt]);

  useEffect(() => {
    const unsubscribe = window.api.chat.onHookTabStarted(
      (event: HookChatTabStartedEvent) => {
        handleHookTabStarted(event);
      },
    );
    return unsubscribe;
  }, [handleHookTabStarted]);

  useEffect(() => {
    if (!window.api.chat.onChatSessionImported) return;
    return window.api.chat.onChatSessionImported(
      (event: ChatSessionImportedEvent) => {
        handleSessionImported(event);
      },
    );
  }, [handleSessionImported]);

  useEffect(() => {
    const unsubscribe = window.api.chat.onMcpAskUser(
      (event: McpAskUserEvent) => {
        handleMcpAskUser(event);
      },
    );
    return unsubscribe;
  }, [handleMcpAskUser]);

  useEffect(() => {
    const unsubscribe = window.api.chat.onMcpExpireAskUser((event) => {
      useChatStore.getState().expireMcpQuestion(event.requestId);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.api.approvals.onRequest(
      (event: ApprovalRequestEvent) => {
        handleApprovalRequest(event);
      },
    );
    return unsubscribe;
  }, [handleApprovalRequest]);

  useEffect(() => {
    const unsubscribe = window.api.approvals.onCancelled((event) => {
      handleApprovalCancelled(event.requestId);
    });
    return unsubscribe;
  }, [handleApprovalCancelled]);

  useEffect(() => {
    const unsubscribe = window.api.approvals.onAutoResolved((event) => {
      handleApprovalAutoResolved(event);
    });
    return unsubscribe;
  }, [handleApprovalAutoResolved]);

  useEffect(() => {
    const unsubscribe = window.api.approvals.onRuleAdded(
      (event: ApprovalRuleAddedEvent) => {
        handleApprovalRuleAdded(event);
      },
    );
    return unsubscribe;
  }, [handleApprovalRuleAdded]);

  useEffect(() => {
    const unsubscribe = window.api.chat.onPlanExitRequest(
      (event: PlanExitRequestEvent) => {
        handlePlanExitRequest(event);
      },
    );
    return unsubscribe;
  }, [handlePlanExitRequest]);

  useEffect(() => {
    const unsubscribe = window.api.chat.onTabDescriptionUpdated(
      (event: ChatTabDescriptionUpdatedEvent) => {
        handleTabDescriptionUpdated(
          event.projectId,
          event.worktreeId,
          event.chatId,
          event.description,
        );
      },
    );
    return unsubscribe;
  }, [handleTabDescriptionUpdated]);

  useEffect(() => {
    const unsubscribe = window.api.chat.onDeferredToolsReloadEvent(
      (event: DeferredToolsReloadEvent) => {
        handleDeferredToolsReloadEvent(event);
      },
    );
    return unsubscribe;
  }, [handleDeferredToolsReloadEvent]);

  useEffect(() => {
    const verifyIfVisible = (): void => {
      if (document.visibilityState !== 'visible') {
        return;
      }
      void verifyStreamingTabs();
    };

    const intervalId = window.setInterval(verifyIfVisible, 30_000);
    document.addEventListener('visibilitychange', verifyIfVisible);
    window.addEventListener('focus', verifyIfVisible);

    return (): void => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', verifyIfVisible);
      window.removeEventListener('focus', verifyIfVisible);
    };
  }, [verifyStreamingTabs]);
}
