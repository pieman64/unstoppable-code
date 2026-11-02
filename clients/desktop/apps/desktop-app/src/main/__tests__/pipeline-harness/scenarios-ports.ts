/** Real-host scenarios for the queue, stop, and input-delivery ports. */
import type {
  PipelineChatTarget,
  QueueTraceEvent,
  PipelineGeneratedInput,
  ScriptedProviderTurn,
} from './contracts';
import { pumpUntil, startRoot } from './scenarios';
import type { ScenarioEnvironment } from './scenarios';

export const RAT_VARIANTS = [
  'normal',
  'prior-terminal',
  'stop-overlap',
] as const;

const PORT_TIMEOUT_MS = 10_000;

type RatVariant = (typeof RAT_VARIANTS)[number];

function isRatVariant(value: string | undefined): value is RatVariant {
  return RAT_VARIANTS.some((variant) => variant === value);
}

function hasEffect(
  env: ScenarioEnvironment,
  name: string,
  text?: string,
): boolean {
  return env.harness.recorder.events.some(
    (event) =>
      event.kind === 'effect' &&
      event.effect.name === name &&
      (text === undefined ||
        (event.effect.name === 'steer-settled' && event.effect.text === text)),
  );
}

async function directRouterDrain(target: PipelineChatTarget): Promise<void> {
  const { drainCurrentSessionEvents } =
    await import('../../agents/session-event-router');
  await drainCurrentSessionEvents(target);
}

async function advanceWithoutBlockedStorage(
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
      `Logical deadline ${boundMs}ms exceeded while durable commits were held: ${JSON.stringify(env.harness.recorder.events.slice(-12))}`,
    );
  }
}

/** Await provider receipt while keeping a deliberately unacknowledged steer pending. */
async function pendingSteer(
  env: ScenarioEnvironment,
  pending: ReturnType<ScriptedProviderTurn['nextSteer']>,
): Promise<Awaited<ReturnType<ScriptedProviderTurn['nextSteer']>>> {
  let received = false;
  const observed = pending.then((steer) => {
    received = true;
    return steer;
  });
  const { getChatStateService } =
    await import('../../services/chat-state-service');
  for (let elapsed = 0; !received && elapsed < 2000; elapsed += 25) {
    await env.harness.advanceLogicalClock(25);
    await getChatStateService().flushScope(
      env.target.projectId,
      env.target.worktreeId,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!received)
    throw new Error('Provider steer receipt missed its logical deadline');
  return observed;
}

function queueEvents(env: ScenarioEnvironment): QueueTraceEvent[] {
  return env.harness.recorder.events.filter(
    (event): event is QueueTraceEvent =>
      event.kind === 'queue' &&
      event.event.chatId === env.target.chatId &&
      event.event.projectId === env.target.projectId &&
      event.event.worktreeId === env.target.worktreeId,
  );
}

function assertPickedUpBy(
  env: ScenarioEnvironment,
  userMessageId: string,
): void {
  const pickedUp = env.harness.recorder.events.some(
    (event) =>
      event.kind === 'revision' &&
      event.chats[env.target.chatId]?.inputDelivery?.rows.some(
        (row) =>
          row.payload.userMessageId === userMessageId &&
          row.attempts.some((attempt) => attempt.pickedUpAt !== undefined),
      ),
  );
  expect(pickedUp).toBe(true);
}

async function refuseGenerated(
  env: ScenarioEnvironment,
  root: ScriptedProviderTurn,
  input: PipelineGeneratedInput,
): Promise<void> {
  let refused = false;
  let delivered = false;
  const receipt = root
    .nextSteer({ timeoutMs: PORT_TIMEOUT_MS })
    .then(async (steer) => {
      await steer.refuse();
      refused = true;
    });
  const delivery = env.host.deliverGenerated(input).then(() => {
    delivered = true;
  });
  await pumpUntil(env, () => refused && delivered);
  await Promise.all([receipt, delivery]);
  await env.host.drain();
}

async function row5(env: ScenarioEnvironment): Promise<void> {
  const root = await startRoot(env);
  await env.harness.checkpoint('active', env.target);
  const watcherText = 'Monkey visible watcher';
  const watcherSecret = 'Monkey private watcher context';
  const delegationSecret = 'Monkey private delegation payload';
  env.secrets.push(watcherSecret, delegationSecret);
  // Proven refusal leaves ordinary-only durable rows. Enqueue the hidden row
  // first: visible watcher priority must still win after the terminal.
  await refuseGenerated(env, root, {
    kind: 'delegation-notice',
    text: 'Monkey delegation notice',
    hiddenContextText: delegationSecret,
    deliveryId: 'monkey-delegation',
  });
  await refuseGenerated(env, root, {
    kind: 'watcher',
    text: watcherText,
    hiddenContextText: watcherSecret,
    watcherId: 'monkey-watcher',
    deliveryId: 'monkey-watcher',
  });
  env.harness.holdDrainBarrier(env.target);
  try {
    await root.complete();
    await directRouterDrain(env.target);
    const queued = queueEvents(env);
    if (
      !queued.some((event) =>
        event.event.queue.some((row) => row.text === watcherText),
      )
    )
      throw new Error(
        `Monkey watcher missing from visible queue: ${JSON.stringify(queued)}`,
      );
    if (
      !queued.some((event) =>
        event.event.waitingDelegationIds?.includes('monkey-delegation'),
      )
    )
      throw new Error(
        `Monkey hidden notice missing from waiting delegation ids: ${JSON.stringify(queued)}`,
      );
    expect(JSON.stringify(queued)).not.toContain(delegationSecret);
    let delivered = 0;
    const watcher = env.driver
      .nextTurn({ timeoutMs: PORT_TIMEOUT_MS })
      .then(async (turn) => {
        expect(turn.prompt).toContain(watcherText);
        await turn.emitText('Monkey watcher response');
        await turn.complete();
        delivered += 1;
      });
    const hidden = env.driver
      .nextTurn({ timeoutMs: PORT_TIMEOUT_MS })
      .then(async (turn) => {
        expect(turn.prompt).toContain(delegationSecret);
        await turn.emitText('Monkey delegation response');
        await turn.complete();
        delivered += 1;
      });
    env.harness.holdCommits();
    env.harness.releaseDrainBarrier(env.target);
    await env.harness.checkpoint('delivery-eligible', env.target);
    const eligible =
      env.harness.recorder.events[env.harness.recorder.events.length - 1];
    await env.harness.advanceLogicalClock(750);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(delivered).toBe(0);
    env.harness.releaseCommits();
    await pumpUntil(env, () => delivered === 2, 1250);
    await Promise.all([watcher, hidden]);
    const frame = env.harness.recorder.events.find(
      (event) =>
        event.kind === 'provider' &&
        event.direction === 'to-provider' &&
        (event.type === 'prompt' || event.type === 'client:turn/start') &&
        event.text?.includes(watcherText),
    );
    expect(frame).toBeDefined();
    if (frame && eligible)
      expect(frame.logicalAt - eligible.logicalAt).toBeLessThanOrEqual(2000);
    await env.host.drain();
    const revisions = env.harness.recorder.events.filter(
      (event) => event.kind === 'revision',
    );
    // Develop integration D12: the delegate's notice stays out of the
    // transcript while it waits, and shows once its own turn is sent.
    const delegationRevisions = revisions.filter((event) =>
      event.chats[env.target.chatId]?.rows?.some(
        (row) => row.id === 'monkey-delegation',
      ),
    );
    const delegationRows = delegationRevisions.flatMap(
      (event) =>
        event.chats[env.target.chatId]?.rows?.filter(
          (row) => row.id === 'monkey-delegation',
        ) ?? [],
    );
    if (
      delegationRows.length === 0 ||
      delegationRows.some((row) => row.hidden === true) ||
      (eligible !== undefined &&
        delegationRevisions.some((event) => event.seq <= eligible.seq))
    )
      throw new Error(
        `Monkey delegation row was not shown only once sent: ${JSON.stringify(delegationRows)}`,
      );
  } finally {
    env.harness.releaseCommits();
    env.harness.releaseDrainBarrier(env.target);
  }
}

async function rat(
  env: ScenarioEnvironment,
  priorTerminal: boolean,
): Promise<void> {
  const root = await startRoot(env);
  const watcherText = 'Rat watcher notice';
  const watcherPending = root.nextSteer({ timeoutMs: PORT_TIMEOUT_MS });
  const watcherDelivery = env.host.deliverGenerated({
    kind: 'watcher',
    text: watcherText,
    watcherId: 'rat-watcher',
    deliveryId: 'rat-watcher',
  });
  const watcherSteer = await pendingSteer(env, watcherPending);
  await env.host.deliverGenerated({
    kind: 'delegation-notice',
    text: 'Rat internal notice',
    deliveryId: 'rat-delegation',
  });
  env.harness.holdDrainBarrier(env.target);
  try {
    await root.complete();
    if (priorTerminal) {
      await directRouterDrain(env.target);
      await env.harness.checkpoint('prior-terminal-durable', env.target);
    }
    await watcherSteer.acknowledge();
    await watcherDelivery;
    const watcherTurn = await env.driver.startTurnByItself();
    await watcherTurn.emitText('Rat watcher own-turn output');
    await directRouterDrain(env.target);
    assertPickedUpBy(env, 'watcher-rat-watcher');
    const delegationPending = watcherTurn.nextSteer({
      timeoutMs: PORT_TIMEOUT_MS,
    });
    const delegationSteer = await pendingSteer(env, delegationPending);
    await env.host.send({ text: 'Rat queued typed prompt' });
    await watcherTurn.complete();
    await directRouterDrain(env.target);
    await delegationSteer.acknowledge();
    const delegationTurn = await env.driver.startTurnByItself();
    await delegationTurn.emitText('Rat delegation own-turn output');
    await directRouterDrain(env.target);
    assertPickedUpBy(env, 'rat-delegation');
    await delegationTurn.complete();
    await directRouterDrain(env.target);
    let completed = false;
    const typed = env.driver
      .nextTurn({ timeoutMs: PORT_TIMEOUT_MS })
      .then(async (turn) => {
        expect(turn.prompt).toContain('Rat queued typed prompt');
        await turn.emitText('Rat typed response');
        await turn.complete();
        completed = true;
      });
    env.harness.releaseDrainBarrier(env.target);
    await env.harness.checkpoint('delivery-eligible', env.target);
    await pumpUntil(env, () => completed);
    await typed;
    await env.host.drain();
    const rows = env.harness.recorder.events
      .filter((event) => event.kind === 'revision')
      .flatMap((event) => event.chats[env.target.chatId]?.rows ?? []);
    expect(
      rows.some((row) =>
        row.blocks.some(
          (block) =>
            block.type === 'text' &&
            block.text.includes('Rat watcher own-turn output'),
        ),
      ),
    ).toBe(true);
    expect(
      rows.some((row) =>
        row.blocks.some(
          (block) =>
            block.type === 'text' &&
            block.text.includes('Rat delegation own-turn output'),
        ),
      ),
    ).toBe(true);
  } finally {
    env.harness.releaseDrainBarrier(env.target);
  }
}

async function row6Normal(env: ScenarioEnvironment): Promise<void> {
  await rat(env, false);
}

async function row6PriorTerminal(env: ScenarioEnvironment): Promise<void> {
  await rat(env, true);
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function row6StopOverlap(env: ScenarioEnvironment): Promise<void> {
  const root = await startRoot(env);
  const pending = root.nextSteer({ timeoutMs: PORT_TIMEOUT_MS });
  const delivery = env.host.deliverGenerated({
    kind: 'watcher',
    text: 'Rat Stop watcher',
    watcherId: 'rat-stop',
    deliveryId: 'rat-stop',
  });
  const steer = await pendingSteer(env, pending);
  env.harness.holdDrainBarrier(env.target);
  const { getChatStateService } =
    await import('../../services/chat-state-service');
  const observer = getChatStateService().inputDelivery;
  const original = observer.observeWithResult.bind(observer);
  const entered = latch();
  const release = latch();
  const spy = jest
    .spyOn(observer, 'observeWithResult')
    .mockImplementation(async (...args) => {
      if (args[1].phase === 'picked-up') {
        entered.release();
        await release.promise;
      }
      return original(...args);
    });
  try {
    await root.complete();
    await directRouterDrain(env.target);
    const acknowledged = steer.acknowledge();
    await entered.promise;
    await env.host.send({ text: 'Rat typed after Stop' });
    const stopping = env.host.stop();
    await env.harness.checkpoint('user-stop-intent', env.target, {
      userInitiated: true,
    });
    release.release();
    await acknowledged;
    await stopping;
    await delivery;
    await env.harness.checkpoint('user-stop', env.target, {
      userInitiated: true,
    });
    let completed = false;
    const typed = env.driver
      .nextTurn({ timeoutMs: PORT_TIMEOUT_MS })
      .then(async (turn) => {
        expect(turn.prompt).toContain('Rat typed after Stop');
        await turn.emitText('Rat post-Stop ordinary response');
        await turn.complete();
        completed = true;
      });
    env.harness.releaseDrainBarrier(env.target);
    await env.harness.checkpoint('delivery-eligible', env.target);
    await pumpUntil(env, () => completed);
    await typed;
    await env.host.drain();
  } finally {
    release.release();
    spy.mockRestore();
    env.harness.releaseDrainBarrier(env.target);
  }
}

async function row7(env: ScenarioEnvironment): Promise<void> {
  const root = await startRoot(env);
  await env.harness.checkpoint('active', env.target);
  const text = 'slow-commit generated steer';
  const waiting = root.nextSteer({ timeoutMs: PORT_TIMEOUT_MS });
  const delivery = env.host.deliverGenerated({
    kind: 'watcher',
    text,
    watcherId: 'slow-commit',
    deliveryId: 'slow-commit',
  });
  const steer = await pendingSteer(env, waiting);
  env.harness.holdCommits();
  const held = env.harness.recorder.events.length;
  try {
    await steer.acknowledge();
    await advanceWithoutBlockedStorage(env, () =>
      hasEffect(env, 'steer-settled', text),
    );
    expect(
      env.harness.recorder.events
        .slice(held)
        .some(
          (event) =>
            event.kind === 'revision' &&
            event.chats[env.target.chatId]?.inputDelivery?.rows.some(
              (row) =>
                row.id === 'watcher-slow-commit' &&
                (row.state === 'picked-up' || row.state === 'uncertain'),
            ),
        ),
    ).toBe(false);
  } finally {
    env.harness.releaseCommits();
  }
  await delivery;
  await env.host.drain();
  const afterAck = env.harness.recorder.events
    .slice(held)
    .filter((event) => event.kind === 'revision');
  expect(
    afterAck.some((event) =>
      event.chats[env.target.chatId]?.inputDelivery?.rows.some(
        (row) => row.id === 'watcher-slow-commit' && row.state === 'uncertain',
      ),
    ),
  ).toBe(false);
  assertPickedUpBy(env, 'watcher-slow-commit');
  await root.complete();
  await env.host.drain();
}

export async function runPortScenario(
  id: 5 | 6 | 7,
  env: ScenarioEnvironment,
  variant?: string,
): Promise<void> {
  if (id === 5) {
    await row5(env);
    return;
  }
  if (id === 7) {
    if (env.driver.provider !== 'claude')
      throw new Error('Scenario row 7 requires Claude');
    await row7(env);
    return;
  }
  if (!isRatVariant(variant))
    throw new Error(`Unsupported Rat variant ${JSON.stringify(variant)}`);
  if (env.driver.provider !== 'claude')
    throw new Error('Scenario row 6 requires Claude');
  switch (variant) {
    case 'normal':
      await row6Normal(env);
      break;
    case 'prior-terminal':
      await row6PriorTerminal(env);
      break;
    case 'stop-overlap':
      await row6StopOverlap(env);
      break;
  }
}
