import { useMemo, useSyncExternalStore } from 'react';
import type { ChatModel, ThinkingLevel } from '@canopy/desktop-shared/types';
import {
  resolveHomeEffectiveModelSettings,
  useHomeComposerStore,
} from '@/stores/homeComposerStore';
import { useChatStore } from '@/stores/chatStore';
import {
  getRendererBillingLaneFactsVersion,
  subscribeRendererBillingLaneFacts,
} from '@/stores/billingLaneRuntime';
import {
  getRendererModelFactsVersion,
  subscribeRendererModelFacts,
} from '@/stores/modelPolicyRuntime';

/**
 * The model and thinking level a Home send would actually run with.
 *
 * Extracted from `HomeComposerControls` so `HomeSurface` can ask the same
 * question for the composer's banners without a second copy of the
 * subscription set: `resolveHomeEffectiveModelSettings` reads a fresh
 * `useChatStore.getState()` snapshot plus two module-level renderer
 * singletons, none of which React can see on its own, and getting that input
 * set wrong is how Home ends up displaying (and sending) a default resolved
 * against stale auth, credits, policy, or harness facts.
 */
export function useHomeEffectiveModelSettings(
  workspaceId: string | null,
  model: ChatModel | undefined,
  thinkingLevel: ThinkingLevel | undefined,
): ReturnType<typeof resolveHomeEffectiveModelSettings> {
  // Subscribed only to trigger a re-render when settings-derived defaults
  // change while Home is open (e.g. the user edits default model/thinking
  // preferences in Settings) — the resolver reads its own fresh snapshot, so
  // this value is otherwise unused.
  const modelDefaults = useChatStore((s) => s.modelDefaults);
  const executionHarness = useHomeComposerStore((s) => s.executionHarness);
  // The third argument is the same getter: these are module-level renderer
  // singletons with no server counterpart, and the static-markup render path
  // used by the component health tests requires it to be present.
  const laneFactsVersion = useSyncExternalStore(
    subscribeRendererBillingLaneFacts,
    getRendererBillingLaneFactsVersion,
    getRendererBillingLaneFactsVersion,
  );
  const modelFactsVersion = useSyncExternalStore(
    subscribeRendererModelFacts,
    getRendererModelFactsVersion,
    getRendererModelFactsVersion,
  );
  // Memoized on the four inputs it actually reads. Unmemoized, every render
  // ran TWO full `resolveLaneForTarget` passes (one through
  // `resolveTabDefaults`, one through `resolveBillingSeed`), each of which
  // walks `repairLaneDefaults` over CLAUDE_MODELS / CODEX_MODELS /
  // AI_GATEWAY_MODELS. `ChatInput` memoizes its equivalent; this is the same
  // treatment.
  return useMemo(
    () =>
      resolveHomeEffectiveModelSettings(
        workspaceId,
        model,
        thinkingLevel,
        executionHarness,
      ),
    // The resolver reads the store snapshot and the two fact singletons, so
    // these versions/values are the complete input set even though they are
    // not all passed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      workspaceId,
      model,
      thinkingLevel,
      executionHarness,
      modelDefaults,
      laneFactsVersion,
      modelFactsVersion,
    ],
  );
}
