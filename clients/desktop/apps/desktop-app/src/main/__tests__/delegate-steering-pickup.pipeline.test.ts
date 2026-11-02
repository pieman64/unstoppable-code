/**
 * Real-host coverage for a delegate's message to its busy Claude root chat.
 * The message steers on arrival; Claude queues it behind the running model
 * call, the root ends its turn, and Claude starts a new turn for it on the
 * same query (as CLI 2.1.293 does: `queued` after the result, then `started`
 * and the new turn's init).
 */
import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import type { ScriptedProviderTurn } from './pipeline-harness/contracts';
import {
  createScenarioEnvironment,
  disposeScenario,
  pumpUntil,
  SCENARIO_TEST_TIMEOUT_MS,
  startRoot,
} from './pipeline-harness/scenarios';
import type { ScenarioEnvironment } from './pipeline-harness/scenarios';
import { emitScriptedClaudeAssistantMessage } from './pipeline-harness/scripted-claude';

interface ClaudeCommandLifecycleTurn extends ScriptedProviderTurn {
  emitCommandLifecycle(
    messageUuid: string,
    state: 'queued' | 'started' | 'cancelled',
  ): Promise<void>;
}

function hasCommandLifecycle(
  turn: ScriptedProviderTurn,
): turn is ClaudeCommandLifecycleTurn {
  return typeof Reflect.get(turn, 'emitCommandLifecycle') === 'function';
}

const deliveryId = 'delegate-pickup-delivery';
const replyText = 'Answered the delegate steering request.';

/**
 * Steers a delegate's message into a busy root turn, ends that turn while
 * Claude holds the message, and has Claude pick it up as a new turn.
 */
async function steerIntoBusyRootAndPickUp(
  env: ScenarioEnvironment,
): Promise<string> {
  const root = await startRoot(env, 'delegate pickup root');
  if (!hasCommandLifecycle(root))
    throw new Error('Claude scripted turn lacks command lifecycle frames');
  const text = 'A delegate asks its busy root chat for steering.';
  const nextSteer = root.nextSteer({ timeoutMs: 5000 });
  let delivered = false;
  const delivery = env.host
    .deliverGenerated({ kind: 'delegation-notice', text, deliveryId })
    .then(() => {
      delivered = true;
    });
  void delivery.catch(() => undefined);
  const steer = await nextSteer;
  const messageUuid = steer.ids.messageUuid;
  if (!messageUuid) throw new Error('The steer has no message UUID');
  // The delegate is answered once its message is durably owned, and its
  // root turn ends while Claude still holds the message.
  await pumpUntil(env, () => delivered);
  await delivery;
  await root.emitText('root finished');
  await root.complete();
  await root.emitCommandLifecycle(messageUuid, 'queued');
  await root.emitCommandLifecycle(messageUuid, 'started');
  return messageUuid;
}

async function readRootTab(
  env: ScenarioEnvironment,
): Promise<PersistedChatTab | undefined> {
  const { getChatStateService } =
    await import('../services/chat-state-service');
  return (await getChatStateService().getState(env.target)).tabsFile.tabs.find(
    (candidate) => candidate.id === env.target.chatId,
  );
}

describe('delegate steering pickup', () => {
  it(
    'records a delegate message that Claude queues and starts as its own root turn',
    async () => {
      const env = await createScenarioEnvironment('worktree', 'claude');
      try {
        const messageUuid = await steerIntoBusyRootAndPickUp(env);
        const pickedUp = await env.driver.startTurnByItself();
        await emitScriptedClaudeAssistantMessage(pickedUp, {
          id: 'delegate-pickup-reply',
          text: replyText,
          userMessageUuids: [messageUuid],
        });
        await pickedUp.complete();
        await env.host.drain();

        const tab = await readRootTab(env);
        const row = tab?.inputDelivery?.rows.find(
          (candidate) => candidate.id === deliveryId,
        );
        expect({
          state: row?.state,
          pickedUp: row?.attempts.some(
            (attempt) => attempt.pickedUpAt !== undefined,
          ),
        }).toEqual({ state: 'picked-up', pickedUp: true });
        const message = tab?.messages.find(
          (candidate) => candidate.id === deliveryId,
        );
        expect(message).toMatchObject({ role: 'user' });
        expect(message?.hidden).toBeUndefined();
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );

  // Receipt publishes lifecycle ahead of admission: under load, a fast pickup
  // turn has started and ended in canonical state before its reply is admitted.
  it(
    'keeps the reply of a pickup turn that ended before its output was admitted',
    async () => {
      const env = await createScenarioEnvironment('worktree', 'claude');
      try {
        const messageUuid = await steerIntoBusyRootAndPickUp(env);
        const { getChatStateService } =
          await import('../services/chat-state-service');
        env.harness.holdCommits();
        try {
          const pickedUp = await env.driver.startTurnByItself();
          await emitScriptedClaudeAssistantMessage(pickedUp, {
            id: 'delegate-pickup-reply',
            text: replyText,
            userMessageUuids: [messageUuid],
          });
          await pickedUp.complete();
          const pickupTurnEnded = (): boolean => {
            const turn = getChatStateService().getTurnState(env.target);
            return (
              turn?.current === undefined &&
              turn?.lastEnded?.userMessageId === deliveryId
            );
          };
          for (let step = 0; !pickupTurnEnded() && step < 80; step += 1) {
            await env.harness.advanceLogicalClock(25);
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
          expect(pickupTurnEnded()).toBe(true);
        } finally {
          env.harness.releaseCommits();
        }
        await env.host.drain();

        const tab = await readRootTab(env);
        expect(
          tab?.messages
            .filter((message) => message.role === 'assistant')
            .flatMap((message) => message.blocks)
            .some(
              (block) =>
                block.type === 'text' && block.text.includes(replyText),
            ),
        ).toBe(true);
        // The root's trailing result is not the pickup turn's terminal, so it
        // does not fence the pickup turn's own frames.
        expect(
          env.harness.dropDiagnostics
            .filter(
              (record) =>
                record.chatEventDropGate === 'canonical_admission_rejected' &&
                record.eventTurnUserMessageId === deliveryId,
            )
            .map(
              (record) => `${record.eventType}: ${record.chatEventDropReason}`,
            ),
        ).toEqual([]);
      } finally {
        await disposeScenario(env);
      }
    },
    SCENARIO_TEST_TIMEOUT_MS,
  );
});
