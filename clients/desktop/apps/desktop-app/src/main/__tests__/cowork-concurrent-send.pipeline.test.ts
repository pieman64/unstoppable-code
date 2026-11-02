/** Concurrent ordinary sends through the Cowork service ingress. */
import {
  createScenarioEnvironment,
  disposeScenario,
  finishScenario,
  pumpUntil,
  SCENARIO_TEST_TIMEOUT_MS,
} from './pipeline-harness/scenarios';
import type { PipelineTraceEvent } from './pipeline-harness/contracts';

const providers = ['claude', 'codex'] as const;
const idleStates = ['new', 'existing'] as const;

function isRootFrame(
  event: PipelineTraceEvent,
): event is Extract<PipelineTraceEvent, { kind: 'provider' }> {
  return (
    event.kind === 'provider' &&
    event.direction === 'to-provider' &&
    (event.type === 'prompt' || event.type === 'client:turn/start')
  );
}

function isUserInputFrame(
  event: PipelineTraceEvent,
): event is Extract<PipelineTraceEvent, { kind: 'provider' }> {
  return (
    event.kind === 'provider' &&
    event.direction === 'to-provider' &&
    (event.type === 'prompt' ||
      event.type === 'client:turn/start' ||
      event.type === 'steer' ||
      event.type.includes('steer'))
  );
}

for (const provider of providers) {
  for (const idleState of idleStates) {
    // Every native send takes ordinary admission before its prompt effects
    // (35c6a), so the second send waits in the host queue for its own root.
    it(
      `${provider} serializes simultaneous sends to a ${idleState} idle Cowork chat`,
      async (): Promise<void> => {
        const env = await createScenarioEnvironment('cowork', provider, {
          // Root-receipt emulation is fixture fidelity, independent of whether
          // shadow assertions or the dormant census are enabled.
          emulateClaudeRootReceipt: provider === 'claude',
          hostOptions: { createInitialChat: idleState !== 'new' },
        });
        try {
          if (idleState === 'new') {
            const { readChatTabsFile } =
              await import('../lib/chat-tabs-reader');
            const before = await readChatTabsFile(
              env.target.projectId,
              env.target.worktreeId,
            );
            expect(
              before.tabs.some((tab) => tab.id === env.target.chatId),
            ).toBe(false);
          }
          if (idleState === 'existing') {
            const warmupText = 'completed Cowork warmup root';
            const warmupSend = env.host.send({ text: warmupText });
            const warmupRoot = await env.driver.nextTurn({ timeoutMs: 10_000 });
            expect(warmupRoot.prompt).toContain(warmupText);
            await warmupRoot.emitText('The existing chat is now idle.');
            await warmupSend;
            await warmupRoot.complete();
            await env.host.drain();
          }

          const firstText = 'first simultaneous Cowork send';
          const secondText = 'second simultaneous Cowork send';
          const eventStart = env.harness.recorder.events.length;
          const sending = Promise.all([
            env.host.send({ text: firstText }),
            env.host.send({ text: secondText }),
          ]);
          const firstRoot = await env.driver.nextTurn({ timeoutMs: 10_000 });
          const firstRootText = firstRoot.prompt.includes(firstText)
            ? firstText
            : firstRoot.prompt.includes(secondText)
              ? secondText
              : undefined;
          if (!firstRootText)
            throw new Error(
              'Provider root did not contain either simultaneous send',
            );

          await firstRoot.emitText('The first accepted Cowork root is active.');
          const results = await sending;
          expect(results).toHaveLength(2);
          const firstId = results[0]?.userMessageId;
          const secondId = results[1]?.userMessageId;
          if (!firstId || !secondId)
            throw new Error(
              'Concurrent Cowork sends did not receive message ids',
            );
          expect(firstId).not.toBe(secondId);
          const firstRootId = firstRootText === firstText ? firstId : secondId;
          const queuedText = firstRootId === firstId ? secondText : firstText;
          await env.host.drain();

          const eventsWhileRootActive =
            env.harness.recorder.events.slice(eventStart);
          expect(eventsWhileRootActive.filter(isRootFrame)).toHaveLength(1);
          expect(
            eventsWhileRootActive.filter(
              (event) =>
                isUserInputFrame(event) && event.text?.includes(queuedText),
            ),
          ).toHaveLength(0);
          expect(
            eventsWhileRootActive.some(
              (event) =>
                event.kind === 'queue' &&
                event.event.queue.some((row) => row.text === queuedText),
            ),
          ).toBe(true);

          const nextRoot = env.driver.nextTurn({ timeoutMs: 10_000 });
          await firstRoot.complete();
          // The first root's end admits the queued send; queue timers run on
          // logical time.
          await pumpUntil(env, () =>
            env.harness.recorder.events.some(
              (event) => isRootFrame(event) && event.text?.includes(queuedText),
            ),
          );
          const secondRoot = await nextRoot;
          expect(secondRoot.prompt).toContain(queuedText);
          await secondRoot.emitText(
            'The queued Cowork send became one new root.',
          );
          await secondRoot.complete();
          await env.host.drain();

          const userInputFrames =
            env.harness.recorder.events.filter(isUserInputFrame);
          for (const text of [firstText, secondText]) {
            expect(
              userInputFrames.filter((event) => event.text?.includes(text)),
            ).toHaveLength(1);
          }

          const latestRevision = [...env.harness.recorder.events]
            .reverse()
            .find(
              (event) =>
                event.kind === 'revision' &&
                event.chats[env.target.chatId]?.rows !== undefined,
            );
          if (latestRevision?.kind !== 'revision')
            throw new Error('Final Cowork transcript rows were not captured');
          const rows = latestRevision.chats[env.target.chatId]?.rows ?? [];
          for (const id of [firstId, secondId]) {
            expect(
              rows.filter((row) => row.id === id && row.role === 'user'),
            ).toHaveLength(1);
          }

          await finishScenario(
            env,
            [],
            false,
            'service-concurrent',
            `simultaneous-service-sends-${idleState}`,
          );
        } finally {
          await disposeScenario(env);
        }
      },
      SCENARIO_TEST_TIMEOUT_MS,
    );
  }
}
