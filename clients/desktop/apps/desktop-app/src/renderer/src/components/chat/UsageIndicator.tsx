import { isCopilotModel } from '@canopy/desktop-shared/lib/copilot-models';
import { isCostWorkScope } from '@canopy/desktop-shared/lib/cost-scope';
import { CopilotAccountUsage } from './CopilotAccountUsage';
import { isCursorModel } from '@canopy/desktop-shared/lib/cursor-models';
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type JSX,
  type RefObject,
} from 'react';
import {
  UsageIndicator as SharedUsageIndicator,
  createOpenCodeUsageResponse,
  type UsageIndicatorContextBreakdown,
} from '@canopy/ui-shared/components';
import { useCostChatSummaryStore } from '@canopy/ui-app/cost';
import { UsageCostPreviewRow } from '@canopy/ui-shared/components/cost';
import type { CostScopeRef } from '@canopy/protocol/cost-view';
import {
  getModelDisplayName,
  getProviderForModel,
  type AgentProviderType,
  type ChatContextUsageRequest,
  type ChatTabUsage,
} from '@canopy/desktop-shared/types';
import { accountProxyHarnessForChat } from '@canopy/desktop-shared/lib/account-proxy';
import { useNavigationStore } from '@/stores/navigationStore';
import { useChatAccountSource } from '@/stores/accountProxyStore';
import { desktopCostClient } from '@/lib/cost/ipc-cost-client';
import { openSessionBreakdownPanel } from '@/lib/cost/open-cost-panels';
import { CursorAccountUsage } from './CursorAccountUsage';
import { PlanAccountUsage, type PlanAccountProvider } from './PlanAccountUsage';
import { ProxyAccountUsage } from './ProxyAccountUsage';
import { createSeededTabUsage } from '@/lib/chatUsageNormalization';
import {
  getRendererModelFactsVersion,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';

interface UsageIndicatorProps {
  usage: ChatTabUsage | undefined;
  isCodex: boolean;
  /** Selected harness, independent of the model's shared identity. */
  isCursor?: boolean;
  /**
   * The tab's current model. Lets the meter size itself to the model's
   * context window while `usage` is still undefined (a chat whose session has
   * not produced a turn yet), instead of rendering a dead ring.
   */
  model?: string;
  /**
   * The chat's execution provider, as main creates its session; defaults to
   * the model's provider. Only Claude Code and Codex chats can run through the
   * account proxy.
   */
  providerType?: AgentProviderType;
  /** Whether the tab routes through AI Credits; picks the gateway window. */
  aiCreditsRouted?: boolean;
  /**
   * The user picked their own subscription for this chat, which keeps the
   * global AI Credits mode from outranking the account proxy.
   */
  subscriptionBillingOverride?: boolean;
  /**
   * Whether the account proxy serves the chat's live session, as main
   * reported it; undefined before the session exists.
   */
  accountProxyRouted?: boolean;
  /**
   * The chat whose live session can report what fills its context window.
   * Asked as the popover opens; Claude sessions answer by category.
   */
  contextTarget?: ChatContextUsageRequest;
  /** Lines the popover up with the composer box's right edge. */
  alignRef?: RefObject<HTMLElement | null>;
}

/**
 * Desktop wrapper over the shared composer usage meter: resolves the model's
 * configured context window through desktop-shared (CAN-2799) and hands the
 * seeded usage to the shared popover.
 */
export function UsageIndicator({
  usage,
  isCodex,
  isCursor,
  model,
  providerType,
  aiCreditsRouted = false,
  subscriptionBillingOverride,
  accountProxyRouted,
  contextTarget,
  alignRef,
}: UsageIndicatorProps): JSX.Element {
  useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  const navigate = useNavigationStore((state) => state.navigate);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const usageModel = usage?.model || model;
  const modelLabel = usageModel ? getModelDisplayName(usageModel) : undefined;
  const isCopilot = isCopilotModel(usageModel ?? '');
  const selectedModel = model ?? usageModel;
  const opencode =
    (providerType ??
      (selectedModel ? getProviderForModel(selectedModel) : undefined)) ===
    'opencode';
  const cursor = !isCopilot && (isCursor ?? isCursorModel(usageModel ?? ''));
  // Only a Claude session reports what fills its window; Codex, Cursor and
  // Copilot report totals.
  const { breakdown: contextBreakdown, onOpenChange: onContextOpenChange } =
    useContextBreakdown(
      isCodex || cursor || isCopilot || opencode ? undefined : contextTarget,
    );
  // A reserved chat scope, such as the Pipeline Assistant's, keeps no cost
  // and has no panel grid to show a breakdown in.
  const costTarget =
    contextTarget !== undefined &&
    isCostWorkScope(contextTarget.projectId, contextTarget.worktreeId)
      ? contextTarget
      : undefined;
  const costScope: CostScopeRef = {
    kind: 'entry',
    projectId: costTarget?.projectId ?? '',
    worktreeId: costTarget?.worktreeId ?? '',
  };
  const costSummaryStore = useCostChatSummaryStore(
    desktopCostClient,
    costScope,
    costTarget?.chatId ?? '',
    {
      enabled: costTarget !== undefined && popoverOpen,
    },
  );
  const costPreview = costSummaryStore((state) =>
    state.problem === null ? state.value?.totals : undefined,
  );
  const proxyAccounts = costSummaryStore((state) =>
    state.problem === null ? state.value?.proxyAccounts : undefined,
  );
  const onOpenChange = useCallback(
    (open: boolean): void => {
      setPopoverOpen(open);
      onContextOpenChange(open);
    },
    [onContextOpenChange],
  );
  const onSeeDetails = useCallback((): void => {
    const openUsagePage = (): void => navigate('usage');
    if (costTarget === undefined) {
      openUsagePage();
      return;
    }
    // The link always lands somewhere: a breakdown no group took gives way
    // to the Usage page.
    void openSessionBreakdownPanel(
      { projectId: costTarget.projectId, worktreeId: costTarget.worktreeId },
      costTarget.chatId,
    ).then((result) => {
      if (result.status !== 'placed' && result.status !== 'revealed') {
        openUsagePage();
      }
    }, openUsagePage);
  }, [costTarget, navigate]);
  // Plan limits only describe a chat that runs on a Claude or Codex plan; an
  // AI Credits route bills elsewhere. When the account proxy serves the chat,
  // its accounts' limits bound it, not the user's own sign-in.
  const planProvider = resolvePlanAccountProvider(
    usageModel,
    cursor || opencode,
    aiCreditsRouted,
  );
  // The proxy routes by the chat's execution harness, as main decides it; the
  // shared resolver owns which harnesses and models it can take.
  const chatProviderType =
    providerType ?? (usageModel ? getProviderForModel(usageModel) : undefined);
  const proxyHarness = accountProxyHarnessForChat({
    providerType: chatProviderType,
    model: usageModel,
  });
  const accountSource = useChatAccountSource({
    providerType: chatProviderType,
    model: usageModel,
    sessionAccountProxyRouted: accountProxyRouted,
    chatChoseAiCredits: aiCreditsRouted,
    subscriptionBillingOverride,
  });
  // Copilot reports cumulative token buckets, but no dollar cost or current
  // context occupancy. Keep its totals visible without inventing those figures.
  const displayUsage = isCopilot
    ? {
        ...usage,
        contextTokens: 0,
        contextWindow: 0,
        totalCostUsd: undefined,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
        numTurns: usage?.numTurns ?? 0,
        model: usageModel ?? '',
      }
    : usage;

  return (
    <SharedUsageIndicator
      usage={displayUsage}
      accountUsage={
        isCopilot ? (
          <CopilotAccountUsage />
        ) : proxyHarness && accountSource === 'account-proxy' ? (
          <ProxyAccountUsage
            accounts={proxyAccounts ?? []}
            harness={proxyHarness}
            {...(contextTarget ? { chat: contextTarget } : {})}
          />
        ) : cursor ? (
          <CursorAccountUsage />
        ) : planProvider ? (
          <PlanAccountUsage provider={planProvider} />
        ) : undefined
      }
      {...(!opencode ? { onSeeDetails } : {})}
      {...(contextBreakdown ? { contextBreakdown } : {})}
      {...(contextTarget !== undefined && costPreview !== undefined
        ? { costPreview: <UsageCostPreviewRow preview={costPreview} /> }
        : {})}
      onOpenChange={onOpenChange}
      capsule
      {...(alignRef ? { alignRef } : {})}
      responseUsage={
        opencode
          ? createOpenCodeUsageResponse(usage?.opencodeReportedUsage)
          : cursor
            ? {
                message: usage?.cursorReportedUsage
                  ? 'Latest reported response. Input includes cached tokens.'
                  : 'Cursor has not reported token usage.',
                note: 'Response cost and context limit are unavailable.',
                usage: usage?.cursorReportedUsage,
              }
            : undefined
      }
      isCodex={isCodex}
      // An id with no display name stays unnamed rather than showing raw.
      modelLabel={modelLabel === usageModel ? '' : (modelLabel ?? '')}
      seedUsage={createSeededTabUsage(model, aiCreditsRouted)}
    />
  );
}

function resolvePlanAccountProvider(
  model: string | undefined,
  cursor: boolean,
  aiCreditsRouted: boolean,
): PlanAccountProvider | undefined {
  if (cursor || aiCreditsRouted || !model) return undefined;
  const provider = getProviderForModel(model);
  return provider === 'claude' || provider === 'codex' ? provider : undefined;
}

/**
 * Fetches the live session's context breakdown each time the popover opens,
 * so it reflects the latest turn. A chat without a live session (or one on a
 * harness that reports totals only) keeps the plain meter.
 */
function useContextBreakdown(target: ChatContextUsageRequest | undefined): {
  breakdown: UsageIndicatorContextBreakdown | null;
  onOpenChange: (open: boolean) => void;
} {
  const [breakdown, setBreakdown] =
    useState<UsageIndicatorContextBreakdown | null>(null);
  const projectId = target?.projectId;
  const worktreeId = target?.worktreeId;
  const chatId = target?.chatId;
  // A different chat's categories never carry over.
  useEffect(() => {
    setBreakdown(null);
  }, [projectId, worktreeId, chatId]);
  const onOpenChange = useCallback(
    (open: boolean): void => {
      if (!open || !projectId || !worktreeId || !chatId) return;
      void window.api.chat
        .getContextUsage({ projectId, worktreeId, chatId })
        .then((next) => {
          setBreakdown(
            next
              ? { categories: next.categories, maxTokens: next.maxTokens }
              : null,
          );
        })
        .catch(() => setBreakdown(null));
    },
    [projectId, worktreeId, chatId],
  );
  return { breakdown, onOpenChange };
}
