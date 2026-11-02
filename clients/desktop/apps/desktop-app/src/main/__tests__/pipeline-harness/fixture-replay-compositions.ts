/** Real-host compositions for incidents not yet expressible by fixture replay. */
import type { PipelineGeneratedInput, ScriptedProviderTurn } from './contracts';
import { pumpUntil, startRoot } from './scenarios';
import type { ScenarioEnvironment } from './scenarios';

const COMPOSITION_TIMEOUT_MS = 5000;

async function advanceWithoutStorageDrain(
  env: ScenarioEnvironment,
  predicate: () => boolean,
  boundMs = 2000,
): Promise<void> {
  for (let elapsed = 0; !predicate() && elapsed < boundMs; elapsed += 25) {
    await env.harness.advanceLogicalClock(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!predicate()) {
    throw new Error(
      `Timed out after ${boundMs}ms advancing without storage drain`,
    );
  }
}

/** Run a watcher through the real host while a provider turn is active. */
export async function runWatcherMidTurnComposition(
  env: ScenarioEnvironment,
): Promise<ScriptedProviderTurn> {
  const root = await startRoot(env, 'watcher composition root');
  const generated: PipelineGeneratedInput = {
    kind: 'watcher',
    text: 'A watcher arrived while the root turn was active.',
    watcherId: 'composition-watcher',
    deliveryId: 'composition-watcher-delivery',
  };
  let acknowledged = false;
  let delivered = false;
  const receipt = root
    .nextSteer({ timeoutMs: COMPOSITION_TIMEOUT_MS })
    .then(async (steer) => {
      await steer.acknowledge();
      acknowledged = true;
    });
  const delivery = env.host.deliverGenerated(generated).then(() => {
    delivered = true;
  });
  await pumpUntil(env, () => acknowledged && delivered);
  await Promise.all([receipt, delivery]);
  await root.emitText('The active root retained its watcher update.');
  await env.host.drain();
  return root;
}

/** Send a user message and persist/answer an in-turn question. */
export async function runMessageAndQuestionAnswerComposition(
  env: ScenarioEnvironment,
): Promise<string> {
  const root = await startRoot(env, 'question composition root');
  const serviceModule = await import('../../services/chat-state-service');
  const service = serviceModule.getChatStateService();
  const requestId = 'composition-question';
  await service.upsertPendingQuestion(
    {
      projectId: env.target.projectId,
      worktreeId: env.target.worktreeId,
    },
    {
      requestId,
      chatId: env.target.chatId,
      questions: [
        {
          question: 'Choose a safe continuation.',
          options: ['continue', 'stop'],
        },
      ],
    },
  );
  const userSend = env.host.send({
    text: 'Continue with the selected option.',
  });
  const { userMessageId } = await userSend;
  const queuedState = await service.getState(env.target);
  expect(JSON.stringify(queuedState)).toContain(
    'Continue with the selected option.',
  );
  const answered = await service.answerPendingQuestion(requestId, [
    { question: 'Choose a safe continuation.', selectedOptions: ['continue'] },
  ]);
  if (!answered) throw new Error('The in-turn question was not answerable');
  const state = await service.getState(env.target);
  expect(
    state.tabsFile.pendingQuestions?.find(
      (question) => question.requestId === requestId,
    )?.answers,
  ).toEqual([
    { question: 'Choose a safe continuation.', selectedOptions: ['continue'] },
  ]);
  await root.emitText('The user message and question answer were handled.');
  await root.complete();
  await env.host.drain();
  return userMessageId;
}

/** Extend a root-end generated-input race while keeping its real terminal path. */
export async function runRootEndGeneratedComposition(
  env: ScenarioEnvironment,
): Promise<void> {
  const root = await startRoot(env, 'root-end composition root');
  const revisionsBeforeTerminal = env.harness.recorder.events.filter(
    (event) => event.kind === 'revision',
  ).length;
  env.harness.holdCommits();
  try {
    await root.complete();
    await advanceWithoutStorageDrain(env, () =>
      env.harness.recorder.events.some(
        (event) =>
          event.kind === 'provider' &&
          event.direction === 'to-canopy' &&
          event.target.chatId === env.target.chatId &&
          (event.type === 'sdk:result:success' ||
            event.type === 'notification:turn/completed'),
      ),
    );
    const delivery = env.host.deliverGenerated({
      kind: 'delegation-notice',
      text: 'A delegation result arrived at the root boundary.',
      deliveryId: 'composition-root-end-delegation',
    });
    await env.harness.advanceLogicalClock(50);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      env.harness.recorder.events.filter((event) => event.kind === 'revision'),
    ).toHaveLength(revisionsBeforeTerminal);
    env.harness.releaseCommits();
    await delivery;
    await env.host.drain();
    await pumpUntil(env, () =>
      env.harness.recorder.events.some(
        (event) =>
          event.kind === 'provider' &&
          event.direction === 'to-provider' &&
          event.type === 'prompt' &&
          event.text?.includes(
            'A delegation result arrived at the root boundary.',
          ),
      ),
    );
    const followup = await env.driver.nextTurn({
      timeoutMs: COMPOSITION_TIMEOUT_MS,
    });
    await followup.emitText(
      'The delayed terminal did not lose delegation output.',
    );
    await followup.complete();
    await env.host.drain();
  } finally {
    env.harness.releaseCommits();
  }
}
