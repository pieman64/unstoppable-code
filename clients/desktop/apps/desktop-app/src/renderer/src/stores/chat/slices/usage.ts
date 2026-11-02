import { getWorktreeChatContext, updateCapturedChatTab } from '../context';
import { isScopeRevisionedLive, waitForChatScopeLive } from './revisioned';
import type { ChatTabSettingsPatch } from '@canopy/desktop-shared/types';
import { type ChatTab } from '../types';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatUsageSlice } from '../state';

// Only in-flight renderer choices live here. A late rejection must not undo a
// newer billing choice for the same tab.
const pendingBillingChoices = new Map<string, symbol>();

export const createUsageSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatUsageSlice
> = (set, get) => ({
  dismissLlmProviderUsageLimitBanner: (dismissKey, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { activeTab } = context;
    if (!activeTab || activeTab.kind === 'file') return;
    set((state) =>
      updateCapturedChatTab(state, context, (t) => ({
        ...t,
        dismissedLlmProviderUsageLimitBannerKey: dismissKey,
      })),
    );
  },

  enableAiCreditsRouting: (input, target): number | undefined => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return undefined;
    const { activeTab } = context;
    if (!activeTab || activeTab.kind === 'file') return undefined;
    const activatedAt = Date.now();
    const aiCreditsRouting = {
      active: true as const,
      scope: input.scope,
      activatedAt,
      ...(input.resetsAt !== undefined ? { resetsAt: input.resetsAt } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
    };
    set((state) =>
      updateCapturedChatTab(state, context, (t) => {
        const next: ChatTab = {
          ...t,
          billingExplicitlyChosen: true,
          aiCreditsRouting,
        };
        // Enforce the mutual-exclusivity contract documented on
        // `PersistedChatTab.subscriptionBillingOverride`: activating routing
        // (e.g. the usage-limit banner's "just this time") must clear any
        // prior "Subscription" billing-toggle override so the two flags
        // are never persisted or sent together.
        delete next.subscriptionBillingOverride;
        // Hide the usage-limit banner once the user opts into routing so
        // they are not re-prompted for the same event.
        if (t.llmProviderUsageLimitBanner) {
          next.dismissedLlmProviderUsageLimitBannerKey =
            t.llmProviderUsageLimitBanner.dismissKey;
        }
        return next;
      }),
    );
    if (
      isScopeRevisionedLive(
        get(),
        context.selection.projectId,
        context.selection.worktreeId,
      )
    ) {
      void get().dispatchChatCommand(context.selection, {
        type: 'chat.patch_tab_settings',
        tabId: context.chatId,
        patch: {
          billingExplicitlyChosen: true,
          aiCreditsRouting,
          subscriptionBillingOverride: false,
        },
      });
    }
    return activatedAt;
  },

  clearAiCreditsRouting: (target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { activeTab } = context;
    if (!activeTab || activeTab.kind === 'file') return;
    set((state) =>
      updateCapturedChatTab(state, context, (t) => {
        if (!t.aiCreditsRouting) return t;
        const next = { ...t };
        delete next.aiCreditsRouting;
        return next;
      }),
    );
    // Persist the clear without an override or a remembered default, so the
    // chat falls back to its normal billing default (CAN-4200).
    if (
      activeTab.aiCreditsRouting &&
      isScopeRevisionedLive(
        get(),
        context.selection.projectId,
        context.selection.worktreeId,
      )
    ) {
      void get().dispatchChatCommand(context.selection, {
        type: 'chat.patch_tab_settings',
        tabId: context.chatId,
        patch: { aiCreditsRouting: null },
      });
    }
  },

  setAiCreditsRoutingResetsAt: (input, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { activeTab } = context;
    if (!activeTab || activeTab.kind === 'file') return;
    const routing = activeTab.aiCreditsRouting;
    // Only the "just this time" stamp this lookup started from; a cleared,
    // persistent, or newer choice is left alone.
    if (
      !routing?.active ||
      routing.scope !== 'session' ||
      routing.activatedAt !== input.activatedAt
    ) {
      return;
    }
    const aiCreditsRouting = { ...routing, resetsAt: input.resetsAt };
    set((state) =>
      updateCapturedChatTab(state, context, (t) =>
        t.aiCreditsRouting?.activatedAt === input.activatedAt
          ? { ...t, aiCreditsRouting }
          : t,
      ),
    );
    if (
      isScopeRevisionedLive(
        get(),
        context.selection.projectId,
        context.selection.worktreeId,
      )
    ) {
      void get().dispatchChatCommand(context.selection, {
        type: 'chat.patch_tab_settings',
        tabId: context.chatId,
        patch: { aiCreditsRouting },
      });
    }
  },

  selectBillingFramework: (framework, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { activeTab } = context;
    if (!activeTab || activeTab.kind === 'file') return;
    const choiceKey = `${context.selection.projectId}/${context.selection.worktreeId}/${context.chatId}`;
    const choiceToken = Symbol();
    pendingBillingChoices.set(choiceKey, choiceToken);
    const rollbackSubscription = (): void => {
      if (pendingBillingChoices.get(choiceKey) !== choiceToken) return;
      pendingBillingChoices.delete(choiceKey);
      set((state) =>
        updateCapturedChatTab(state, context, (tab) => {
          // Recovery controls or a canonical refresh can supersede this
          // optimistic subscription without going through the picker action.
          if (tab.aiCreditsRouting || tab.subscriptionBillingOverride !== true)
            return tab;
          const next = { ...tab };
          if (activeTab.aiCreditsRouting)
            next.aiCreditsRouting = activeTab.aiCreditsRouting;
          else delete next.aiCreditsRouting;
          if (activeTab.subscriptionBillingOverride !== undefined)
            next.subscriptionBillingOverride =
              activeTab.subscriptionBillingOverride;
          else delete next.subscriptionBillingOverride;
          if (activeTab.billingExplicitlyChosen !== undefined)
            next.billingExplicitlyChosen = activeTab.billingExplicitlyChosen;
          else delete next.billingExplicitlyChosen;
          return next;
        }),
      );
    };
    const activatedAt = Date.now();
    const canonicalPatch: ChatTabSettingsPatch =
      framework === 'ai-credits'
        ? {
            billingExplicitlyChosen: true,
            aiCreditsRouting: {
              active: true,
              scope: 'persistent',
              activatedAt,
            },
            subscriptionBillingOverride: false,
          }
        : {
            billingExplicitlyChosen: true,
            aiCreditsRouting: null,
            subscriptionBillingOverride: true,
          };
    set((state) =>
      updateCapturedChatTab(state, context, (t) => {
        const next: ChatTab = { ...t, billingExplicitlyChosen: true };
        if (framework === 'ai-credits') {
          next.aiCreditsRouting = {
            active: true,
            // The billing toggle is a deliberate, durable per-chat choice
            // (unlike the transient "just this time" banner path), so it is
            // `persistent` — it must survive quota resets and session
            // restarts rather than auto-reverting.
            scope: 'persistent',
            activatedAt,
          };
          delete next.subscriptionBillingOverride;
          // Mirror `enableAiCreditsRouting`: hide the usage-limit banner once
          // the user opts into routing so they are not re-prompted.
          if (t.llmProviderUsageLimitBanner) {
            next.dismissedLlmProviderUsageLimitBannerKey =
              t.llmProviderUsageLimitBanner.dismissKey;
          }
        } else {
          delete next.aiCreditsRouting;
          next.subscriptionBillingOverride = true;
        }
        return next;
      }),
    );
    if (
      isScopeRevisionedLive(
        get(),
        context.selection.projectId,
        context.selection.worktreeId,
      )
    ) {
      void get()
        .dispatchChatCommand(
          context.selection,
          {
            type: 'chat.patch_tab_settings',
            tabId: context.chatId,
            patch: canonicalPatch,
          },
          framework === 'subscription'
            ? { rollback: rollbackSubscription }
            : undefined,
        )
        .then((disposition) => {
          if (disposition !== 'accepted' && framework === 'subscription')
            rollbackSubscription();
          if (pendingBillingChoices.get(choiceKey) === choiceToken)
            pendingBillingChoices.delete(choiceKey);
        });
    } else {
      pendingBillingChoices.delete(choiceKey);
    }
    get().rememberBillingFramework(framework);
  },

  rememberBillingFramework: (framework): void => {
    // Immediately reflect the choice in the in-memory model defaults so new
    // chats/trees opened *in this same session* seed from it. The main-window
    // `onPreferencesSynced` handler does not re-run `applyModelDefaults`, so
    // without this patch `modelDefaults.billingFramework` would stay at its
    // startup value until the next launch and same-session new chats would
    // re-default to the global routing mode (the reported bug).
    set((state) =>
      state.modelDefaults
        ? {
            modelDefaults: {
              ...state.modelDefaults,
              billingFramework: framework,
            },
          }
        : {},
    );
    // Remember the user's last explicit picker choice globally so new
    // chats/trees seed from it (mirrors the usage-limit banner's
    // `enableOnQuota`). Fire-and-forget: a failed write only means new chats
    // fall back to today's behavior, never a broken toggle.
    void window.api
      .savePreferences({ lastChatBillingFramework: framework })
      .catch(() => {});
  },

  setSharedRun: async (
    projectId,
    worktreeId,
    chatId,
    sharedRun,
  ): Promise<void> => {
    const context = getWorktreeChatContext(get(), {
      projectId,
      worktreeId,
      chatId,
    });
    if (!context) return;
    if (context.activeTab?.kind === 'file') return;
    const previousSharedRun = context.activeTab?.sharedRun;
    set((state) =>
      updateCapturedChatTab(state, context, (t) => {
        const next = { ...t };
        if (sharedRun) {
          next.sharedRun = sharedRun;
        } else {
          delete next.sharedRun;
        }
        return next;
      }),
    );
    if (isScopeRevisionedLive(get(), projectId, worktreeId)) {
      let disposition = await get().dispatchChatCommand(context.selection, {
        type: 'chat.patch_tab_settings',
        tabId: chatId,
        patch: { sharedRun: sharedRun ?? null },
      });
      if (
        (disposition === 'transport_failed' || disposition === 'conflict') &&
        (await waitForChatScopeLive(projectId, worktreeId))
      ) {
        disposition = await get().dispatchChatCommand(context.selection, {
          type: 'chat.patch_tab_settings',
          tabId: chatId,
          patch: { sharedRun: sharedRun ?? null },
        });
      }
      if (disposition === 'accepted') {
        get().dismissChatStateNotice(projectId, worktreeId);
      }
      if (disposition !== 'accepted') {
        set((state) =>
          updateCapturedChatTab(state, context, (tab) => {
            const next = { ...tab };
            if (previousSharedRun) next.sharedRun = previousSharedRun;
            else delete next.sharedRun;
            return next;
          }),
        );
        throw new Error('Failed to persist shared-run metadata');
      }
    }
  },
});
