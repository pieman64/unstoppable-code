// Canonical root turns start and end only from the lifecycle receipts a
// provider session publishes (turn-state phase 35c5d). Events injected through
// the E2E chat ingress carry content only, so a spec that fakes a turn
// publishes its receipts through the E2E-only seam in `src/main/index.ts`,
// which hands them to the production lifecycle producer as a Claude session
// unless `providerType` names another provider.

import { injectChatEvent } from './injectChatEvent.mjs';

const E2E_TURN_LIFECYCLE_PUBLISHER_KEY =
  '__CANOPY_E2E_PUBLISH_TURN_LIFECYCLE__';

/**
 * Publish a root turn's start or end, bound to `turnUserMessageId`. A start
 * opens the turn's canonical timer row; an end closes it.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {{
 *   projectId: string,
 *   worktreeId: string,
 *   chatId: string,
 *   turnUserMessageId: string,
 *   phase: 'start' | 'end',
 *   outcome?: 'completed' | 'failed',
 *   atMs?: number,
 *   providerType?: 'claude' | 'codex',
 * }} input
 * @returns {Promise<void>}
 */
export async function publishTurnLifecycle(electronApp, input) {
  await electronApp.evaluate(
    async (_electron, { key, payload }) => {
      const publish = globalThis[key];
      if (typeof publish !== 'function') {
        throw new Error('E2E turn lifecycle publisher is unavailable');
      }
      await publish(payload);
    },
    { key: E2E_TURN_LIFECYCLE_PUBLISHER_KEY, payload: input },
  );
}

/**
 * Inject Claude provider events attributed to one turn. A root result ends the
 * turn first, in a Claude session's receipt order.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {{
 *   projectId: string,
 *   worktreeId: string,
 *   chatId: string,
 *   turnUserMessageId: string,
 * }} target
 * @returns {(data: Record<string, unknown>) => Promise<void>}
 */
export function turnEventInjector(electronApp, target) {
  return async (data) => {
    if (data.type === 'result' && data.parent_tool_use_id == null)
      await publishTurnLifecycle(electronApp, {
        ...target,
        phase: 'end',
        outcome: data.is_error ? 'failed' : 'completed',
      });
    await injectChatEvent(electronApp, {
      ...target,
      providerType: 'claude',
      data: { ...data, canopy_turn_user_message_id: target.turnUserMessageId },
    });
  };
}
