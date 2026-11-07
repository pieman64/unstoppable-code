import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CodexSpeedRouteFacts } from '@canopy/desktop-shared/lib/codex-speed-availability';
import {
  CODEX_CONTEXT_WINDOW_FLOOR,
  CODEX_LONG_CONTEXT_THRESHOLD,
  codexAutoCompactTokens,
  codexContextWindowPresets,
  resolveCodexContextWindowSupport,
  resolveCodexContextWindowTokens,
  type CodexContextWindowBounds,
  type CodexContextWindowSetting,
} from '@canopy/desktop-shared/lib/codex-context-window';
import type { ChatContextUsageRequest } from '@canopy/desktop-shared/types';
import type {
  CodexContextWindowControlState,
  UsageIndicatorContextBreakdown,
} from '@canopy/ui-shared/components';
import { useCodexSpeedRoute } from '@/hooks/useCodexSpeedRoute';
import {
  retainCodexSpeedSubscription,
  useCodexSpeedStore,
} from '@/stores/codexSpeedStore';
import { useChatStore } from '@/stores/chatStore';

/** Codex's own share of a window that is usable, when no catalog says. */
const CODEX_DEFAULT_USABLE_PERCENT = 95;

export interface CodexContextWindowControl {
  state: CodexContextWindowControlState;
  onSelect: (tokens: number, source: 'preset' | 'custom') => void;
}

/** The configured window behind the usable window Codex reports. */
function appliedWindow(
  reportedTokens: number,
  bounds: Pick<CodexContextWindowBounds, 'usablePercent'>,
): number | undefined {
  return reportedTokens > 0
    ? Math.round((reportedTokens * 100) / bounds.usablePercent)
    : undefined;
}

/** The setting a picked window stands for, so presets follow the model. */
function settingForTokens(
  tokens: number,
  source: 'preset' | 'custom',
  bounds: CodexContextWindowBounds,
): CodexContextWindowSetting {
  if (tokens === bounds.defaultTokens) return 'model-default';
  if (source === 'preset' && tokens === bounds.maxTokens) return 'maximum';
  if (source === 'preset' && tokens === CODEX_LONG_CONTEXT_THRESHOLD) {
    return 'standard-pricing';
  }
  return tokens;
}

/**
 * The context window control and breakdown for a Codex chat's usage
 * popover, from the chat's route and the Codex catalog the speed system
 * reads. Reads while the chat is mounted, as the speed picker does, so the
 * control is ready when the popover opens.
 */
export function useCodexContextWindowControl({
  chat,
  setting,
  usedTokens,
  reportedWindowTokens,
}: {
  /** The Codex chat; absent for other chats. */
  chat: ChatContextUsageRequest | undefined;
  /** The chat's own choice; absent uses the Codex default. */
  setting: CodexContextWindowSetting | undefined;
  usedTokens: number;
  /** The usable window Codex last reported for the chat, or 0. */
  reportedWindowTokens: number;
}): {
  control: CodexContextWindowControl | undefined;
  breakdown: UsageIndicatorContextBreakdown | undefined;
} {
  const enabled = chat !== undefined;
  const defaultSetting = useChatStore(
    (state) =>
      state.modelDefaults?.modelConfigDefaultsByProvider?.codex?.contextWindow,
  );
  const effectiveSetting = setting ?? defaultSetting;
  const { route: liveRoute, status: routeStatus } = useCodexSpeedRoute({
    request: chat ? { context: { kind: 'chat', ...chat } } : null,
    enabled,
  });
  // Each revalidation (catalog change, focus) clears the route until the
  // answer returns; keep this chat's last route meanwhile so the control
  // doesn't unmount and remount.
  const chatKey = chat ? JSON.stringify(chat) : null;
  const [held, setHeld] = useState<{
    chatKey: string | null;
    route: CodexSpeedRouteFacts;
  } | null>(null);
  if (liveRoute && (held?.route !== liveRoute || held.chatKey !== chatKey)) {
    setHeld({ chatKey, route: liveRoute });
  }
  const route = liveRoute ?? (held?.chatKey === chatKey ? held.route : null);
  const catalog = useCodexSpeedStore((state) => state.catalog);
  const proxyRoute = route?.routeProfile === 'account-proxy';
  useEffect(() => {
    if (!enabled) return undefined;
    const release = retainCodexSpeedSubscription();
    void useCodexSpeedStore
      .getState()
      .read(proxyRoute ? { route: 'account-proxy' } : undefined);
    return release;
  }, [enabled, proxyRoute]);

  const support = useMemo(
    () => (route ? resolveCodexContextWindowSupport(catalog, route) : null),
    [catalog, route],
  );

  const onSelect = useCallback(
    (tokens: number, source: 'preset' | 'custom'): void => {
      if (!chat || support?.kind !== 'adjustable') return;
      void useChatStore
        .getState()
        .setContextWindow(
          settingForTokens(tokens, source, support.bounds),
          chat,
        );
    },
    [chat, support],
  );

  const breakdown = useMemo((): UsageIndicatorContextBreakdown | undefined => {
    if (!chat || reportedWindowTokens <= 0) return undefined;
    const bounds =
      support && support.kind !== 'unavailable'
        ? support.bounds
        : { usablePercent: CODEX_DEFAULT_USABLE_PERCENT };
    const configured = appliedWindow(reportedWindowTokens, bounds);
    if (configured === undefined) return undefined;
    // Codex compacts at 90% of the configured window, inside the usable
    // window it reports, so the rest of the usable window is the buffer.
    const buffer = Math.max(
      0,
      reportedWindowTokens -
        codexAutoCompactTokens(
          configured,
          support && support.kind !== 'unavailable' ? support.bounds : {},
        ),
    );
    const used = Math.min(usedTokens, reportedWindowTokens);
    return {
      maxTokens: reportedWindowTokens,
      categories: [
        { name: 'Used', tokens: used, kind: 'used' },
        { name: 'Autocompact buffer', tokens: buffer, kind: 'buffer' },
        {
          name: 'Free space',
          tokens: Math.max(0, reportedWindowTokens - used - buffer),
          kind: 'free',
        },
      ],
    };
  }, [chat, reportedWindowTokens, support, usedTokens]);

  if (!chat) return { control: undefined, breakdown };
  if (!route || !support) {
    // Still reading the route: show nothing rather than a guess.
    return {
      control:
        routeStatus === 'loading'
          ? undefined
          : {
              state: {
                kind: 'unavailable',
                reason: "Couldn't check this chat's context window options.",
              },
              onSelect,
            },
      breakdown,
    };
  }
  if (support.kind === 'unavailable') {
    const reason =
      support.reason === 'route'
        ? route.routeProfile === 'ai-credits'
          ? "AI Credits chats use the model's default context window."
          : "This chat's route uses the model's default context window."
        : support.reason === 'model'
          ? "This model's context window can't be changed."
          : route.routeProfile === 'account-proxy'
            ? "The account proxy doesn't list a larger context window for this model."
            : "Couldn't read this model's context window limits.";
    return {
      control:
        support.reason === 'catalog' && catalog?.status !== 'ready'
          ? undefined
          : { state: { kind: 'unavailable', reason }, onSelect },
      breakdown,
    };
  }
  if (support.kind === 'fixed') {
    return {
      control: {
        state: { kind: 'fixed', tokens: support.bounds.defaultTokens },
        onSelect,
      },
      breakdown,
    };
  }
  const presets = codexContextWindowPresets(support.bounds);
  const selectedTokens = resolveCodexContextWindowTokens(
    effectiveSetting,
    support.bounds,
  );
  const applied = appliedWindow(reportedWindowTokens, support.bounds);
  return {
    control: {
      state: {
        kind: 'adjustable',
        presets,
        selectedTokens,
        custom: !presets.includes(selectedTokens),
        defaultTokens: support.bounds.defaultTokens,
        maxTokens: support.bounds.maxTokens,
        floorTokens: Math.min(
          CODEX_CONTEXT_WINDOW_FLOOR,
          support.bounds.defaultTokens,
        ),
        thresholdTokens: CODEX_LONG_CONTEXT_THRESHOLD,
        usablePercent: support.bounds.usablePercent,
        // Account proxy accounts are ChatGPT plans; a native sign-in can be
        // either, and the renderer can't tell which.
        billing: proxyRoute ? 'plan' : 'unknown',
        ...(applied !== undefined ? { appliedTokens: applied } : {}),
        usedTokens,
      },
      onSelect,
    },
    breakdown,
  };
}
