/** End-to-end lifecycle scenarios driven through real pipeline hosts. */
import type {
  PipelineHost,
  PipelineProvider,
  PipelineTraceEvent,
  PipelineGeneratedInput,
  ScriptedProviderTurn,
} from './contracts';
import type { ScenarioEnvironment } from './scenarios';
import { pumpUntil, startRoot } from './scenarios';

type CoreScenarioId = 1 | 2 | 3 | 4 | 8 | 9 | 10 | 11 | 12 | 13;

const SCENARIO_TIMEOUT_MS = 5000;

function requireEnvironment(
  env: ScenarioEnvironment,
  host: PipelineHost,
  provider: PipelineProvider,
): void {
  if (env.host.host !== host || env.host.provider !== provider) {
    throw new Error(
      `Scenario requires ${host}/${provider}, received ${env.host.host}/${env.host.provider}`,
    );
  }
}

function hasEffect(
  env: ScenarioEnvironment,
  predicate: (
    effect: Extract<PipelineTraceEvent, { kind: 'effect' }>['effect'],
  ) => boolean,
): boolean {
  return env.harness.recorder.events.some(
    (event) => event.kind === 'effect' && predicate(event.effect),
  );
}

function hasProviderFrame(
  env: ScenarioEnvironment,
  predicate: (
    frame: Extract<PipelineTraceEvent, { kind: 'provider' }>,
  ) => boolean,
): boolean {
  return env.harness.recorder.events.some(
    (event) => event.kind === 'provider' && predicate(event),
  );
}

async function waitForEffect(
  env: ScenarioEnvironment,
  predicate: (
    effect: Extract<PipelineTraceEvent, { kind: 'effect' }>['effect'],
  ) => boolean,
): Promise<void> {
  await pumpUntil(env, () => hasEffect(env, predicate), SCENARIO_TIMEOUT_MS);
}

async function waitForProviderFrame(
  env: ScenarioEnvironment,
  predicate: (
    frame: Extract<PipelineTraceEvent, { kind: 'provider' }>,
  ) => boolean,
): Promise<void> {
  await pumpUntil(
    env,
    () => hasProviderFrame(env, predicate),
    SCENARIO_TIMEOUT_MS,
  );
}

async function codexToolNames(): Promise<{
  scheduleWakeup: string;
}> {
  const { CANOPY_INJECTED_TOOL_REGISTRY } =
    await import('@canopy/desktop-shared/lib/canopy-injected-tools');
  return {
    scheduleWakeup: CANOPY_INJECTED_TOOL_REGISTRY.schedule_wakeup.codexToolName,
  };
}

async function runBasicTurn(env: ScenarioEnvironment): Promise<void> {
  const turn = await startRoot(env);
  await env.harness.checkpoint('active', env.target);
  await turn.complete();
  await env.host.drain();
}

async function acknowledgeGenerated(
  env: ScenarioEnvironment,
  turn: ScriptedProviderTurn,
  input: PipelineGeneratedInput,
): Promise<void> {
  let acknowledged = false;
  let delivered = false;
  const receipt = turn
    .nextSteer({ timeoutMs: SCENARIO_TIMEOUT_MS })
    .then(async (steer) => {
      await steer.acknowledge();
      acknowledged = true;
    });
  const delivery = env.host.deliverGenerated(input).then(() => {
    delivered = true;
  });
  void receipt.catch(() => undefined);
  void delivery.catch(() => undefined);
  await pumpUntil(env, () => acknowledged && delivered);
  await Promise.all([receipt, delivery]);
  await env.host.drain();
}

async function runAcknowledgedSteer(env: ScenarioEnvironment): Promise<void> {
  const turn = await startRoot(env);
  await acknowledgeGenerated(env, turn, {
    kind: 'watcher',
    text: 'A generated steer needs attention.',
    watcherId: 'row-2-watcher',
    deliveryId: 'row-2-delivery',
  });
  await turn.complete();
  await env.host.drain();
}

async function consumeQueued(
  env: ScenarioEnvironment,
  text: string,
): Promise<void> {
  let completed = false;
  const followup = env.driver
    .nextTurn({ timeoutMs: SCENARIO_TIMEOUT_MS })
    .then(async (turn) => {
      expect(turn.prompt).toContain(text);
      await turn.emitText('The generated prompt was handled.');
      await turn.complete();
      completed = true;
    });
  await pumpUntil(env, () => completed);
  await followup;
  await env.host.drain();
}

async function runRefusedGeneratedSteer(
  env: ScenarioEnvironment,
): Promise<void> {
  const turn = await startRoot(env);
  const text = 'A generated update declined by the active turn.';
  await env.host.deliverGenerated({
    kind: 'delegation-notice',
    text,
    deliveryId: 'row-3-delivery',
  });
  const nextSteer = turn.nextSteer({ timeoutMs: SCENARIO_TIMEOUT_MS });
  await env.harness.advanceLogicalClock(25);
  const steer = await nextSteer;
  await steer.refuse();
  await env.host.drain();
  await turn.complete();
  const { drainCurrentSessionEvents } =
    await import('../../agents/session-event-router');
  await drainCurrentSessionEvents(env.target);
  await env.harness.checkpoint('delivery-eligible', env.target);
  await consumeQueued(env, text);
  const ordinary = env.harness.recorder.events.filter(
    (event) =>
      event.kind === 'provider' &&
      event.direction === 'to-provider' &&
      (event.type === 'prompt' || event.type === 'client:turn/start') &&
      event.text?.includes(text),
  );
  expect(ordinary).toHaveLength(1);
}

async function runGeneratedForegroundWatcher(
  env: ScenarioEnvironment,
): Promise<void> {
  const turn = await startRoot(env);
  const secret = 'scenario-only-watcher-context-4e18';
  env.secrets.push(secret);
  await env.harness.checkpoint('delivery-eligible', env.target);
  await acknowledgeGenerated(env, turn, {
    kind: 'watcher',
    text: 'A watcher update is ready for the active turn.',
    hiddenContextText: secret,
    watcherId: 'row-4-watcher',
    deliveryId: 'row-4-delivery',
  });
  await turn.complete();
  await env.host.drain();
}

async function runLiveNativeChild(env: ScenarioEnvironment): Promise<void> {
  requireEnvironment(env, 'worktree', 'claude');
  const turn = await startRoot(env);
  await turn.emitToolCall({ callId: 'row-8-agent', name: 'Agent' });
  await turn.startNativeTask({
    taskId: 'row-8-native-task',
    toolUseId: 'row-8-agent',
    kind: 'agent',
  });
  await turn.emitToolCall({
    callId: 'row-8-child-read',
    name: 'Read',
    parentCallId: 'row-8-agent',
  });
  await env.host.drain();

  // Leave the child active across the root terminal. The result must not be
  // fabricated by that terminal; the native task owns its later completion.
  await turn.complete();
  await env.host.drain();
  await turn.endNativeTask('row-8-native-task', 'completed');
  await env.host.drain();
}

async function runSettingsChangeWithLiveNativeWork(
  env: ScenarioEnvironment,
): Promise<void> {
  requireEnvironment(env, 'worktree', 'claude');
  const turn = await startRoot(env);
  await turn.emitToolCall({ callId: 'row-9-agent', name: 'Agent' });
  await turn.startNativeTask({
    taskId: 'row-9-native-task',
    toolUseId: 'row-9-agent',
    kind: 'agent',
  });
  await env.host.drain();

  await env.host.changeSettings({ model: 'sonnet' });
  await env.harness.checkpoint('settings-changed', env.target);
  const changed = [...env.harness.recorder.events]
    .reverse()
    .find(
      (event) =>
        event.kind === 'checkpoint' &&
        event.label === 'settings-changed' &&
        event.target?.chatId === env.target.chatId,
    );
  if (changed?.kind !== 'checkpoint' || changed.liveness?.background !== true) {
    throw new Error('Settings change did not preserve live native work.');
  }

  await turn.complete();
  await env.host.drain();
  await turn.endNativeTask('row-9-native-task', 'completed');
  await env.host.drain();
  const before = env.harness.recorder.events.filter(
    (event) =>
      event.kind === 'effect' && event.effect.name === 'session-created',
  ).length;
  const next = await startRoot(env, 'new model after native work completes');
  expect(
    env.harness.recorder.events.filter(
      (event) =>
        event.kind === 'effect' && event.effect.name === 'session-created',
    ).length,
  ).toBe(before + 1);
  await next.complete();
  await env.host.drain();
}

function latch(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function configureToolAccess(env: ScenarioEnvironment): Promise<void> {
  const { getChatStateService } =
    await import('../../services/chat-state-service');
  await getChatStateService().command({
    schemaVersion: 1,
    commandId: 'scenario-tool-access',
    ...env.target,
    command: {
      type: 'chat.set_approval_mode',
      tabId: env.target.chatId,
      approvalMode: 'full-access',
    },
  });
  const state = await getChatStateService().getState({
    projectId: env.target.projectId,
    worktreeId: env.target.worktreeId,
  });
  expect(
    state.tabsFile.tabs.find((tab) => tab.id === env.target.chatId)
      ?.approvalMode,
  ).toBe('full-access');
}

async function runServerRequestCancellation(
  env: ScenarioEnvironment,
): Promise<void> {
  requireEnvironment(env, 'worktree', 'codex');
  if (!env.driver.resolveServerRequest)
    throw new Error('Missing server cancellation');
  await configureToolAccess(env);
  const names = await codexToolNames();
  const turn = await startRoot(env);
  // First let one real registration finish so the side-effect rule is active.
  await turn.emitToolCall({
    callId: 'row-10-control',
    name: names.scheduleWakeup,
    input: { delaySeconds: 60 },
  });
  await waitForEffect(
    env,
    (effect) =>
      effect.name === 'watcher-registered' &&
      effect.callId === 'codex-row-10-control',
  );
  await turn.emitToolResult('row-10-control', 'registered');
  const { getAppAdvisorWatcherService } =
    await import('../../app-advisor/watchers');
  const service = getAppAdvisorWatcherService();
  // The harness already observes this sink with a Jest spy. Capture that
  // implementation, not the mutable mock function, before adding the hold.
  /* eslint-disable @typescript-eslint/unbound-method -- Inspect the existing Jest wrapper; production implementation below is bound. */
  const existingSpy = jest.isMockFunction(service.createLocalWatcher);
  const original = existingSpy
    ? jest.mocked(service.createLocalWatcher).getMockImplementation()
    : service.createLocalWatcher.bind(service);
  /* eslint-enable @typescript-eslint/unbound-method */
  if (!original) throw new Error('Watcher observer has no implementation');
  const entered = latch();
  const release = latch();
  const aborted = latch();
  const finished = latch();
  const holding = jest
    .spyOn(service, 'createLocalWatcher')
    .mockImplementation(async (...args) => {
      const signal = args[5]?.signal;
      if (!signal)
        throw new Error(
          'Watcher registration did not receive cancellation signal',
        );
      signal.addEventListener('abort', aborted.release, { once: true });
      entered.release();
      await release.promise;
      try {
        return await original(...args);
      } finally {
        finished.release();
      }
    });
  try {
    await turn.emitToolCall({
      callId: 'row-10-cancelled',
      name: names.scheduleWakeup,
      input: { delaySeconds: 120 },
    });
    await entered.promise;
    await env.driver.resolveServerRequest('row-10-cancelled');
    await aborted.promise;
    release.release();
    await finished.promise;
    await env.host.drain();
    expect(
      env.harness.recorder.events.filter(
        (event) =>
          event.kind === 'effect' &&
          event.effect.name === 'tool-side-effect' &&
          event.effect.callId === 'codex-row-10-cancelled',
      ),
    ).toHaveLength(0);
  } finally {
    release.release();
    if (existingSpy) holding.mockImplementation(original);
    else holding.mockRestore();
  }
  await turn.complete();
  await env.host.drain();
}

async function runWatcherRegistrationRetry(
  env: ScenarioEnvironment,
): Promise<void> {
  requireEnvironment(env, 'worktree', 'codex');
  if (!env.driver.sendServerRequest)
    throw new Error('Missing server request sender');
  await configureToolAccess(env);
  const names = await codexToolNames();
  const turn = await startRoot(env, 'register watcher and retry transport');
  const callId = 'row-11-stable-watcher-call';
  await turn.emitToolCall({
    callId,
    name: names.scheduleWakeup,
    input: { delaySeconds: 60 },
  });
  await waitForEffect(
    env,
    (effect) =>
      effect.name === 'watcher-registered' &&
      effect.callId === `codex-${callId}` &&
      effect.created,
  );
  await waitForProviderFrame(
    env,
    (frame) =>
      frame.direction === 'to-provider' &&
      frame.type === 'client-response:item/tool/call' &&
      frame.ids?.callId === callId,
  );
  await turn.emitToolResult(callId, 'registered');
  await env.driver.sendServerRequest({
    method: 'item/tool/call',
    callId: 'row-11-transport-retry',
    params: {
      callId,
      namespace: null,
      tool: names.scheduleWakeup,
      arguments: { delaySeconds: 60 },
    },
  });
  await waitForEffect(
    env,
    (effect) =>
      effect.name === 'watcher-registered' &&
      effect.callId === `codex-${callId}` &&
      !effect.created,
  );
  await waitForProviderFrame(
    env,
    (frame) =>
      frame.direction === 'to-provider' &&
      frame.type === 'client-response:item/tool/call' &&
      frame.ids?.requestId === 'row-11-transport-retry',
  );
  const registrations = env.harness.recorder.events.filter(
    (event) =>
      event.kind === 'effect' && event.effect.name === 'watcher-registered',
  );
  expect(registrations).toHaveLength(2);
  const ids = registrations.flatMap((event) =>
    event.kind === 'effect' && event.effect.name === 'watcher-registered'
      ? [event.effect.watcherId]
      : [],
  );
  expect(new Set(ids).size).toBe(1);
  expect(
    registrations.filter(
      (event) =>
        event.kind === 'effect' &&
        event.effect.name === 'watcher-registered' &&
        event.effect.created,
    ),
  ).toHaveLength(1);
  await turn.complete();
  await env.host.drain();
}

async function runSelfStartedWakeTurn(env: ScenarioEnvironment): Promise<void> {
  const initial = await startRoot(env, 'establish the provider session');
  await initial.complete();
  await env.host.drain();

  const wake = await env.driver.startTurnByItself({ text: 'wake prefix' });
  await wake.emitText('The provider completed its self-started wake turn.');
  await env.harness.checkpoint('active', env.target);
  await wake.complete();
  await env.host.drain();
}

async function runUserStopMidTurn(env: ScenarioEnvironment): Promise<void> {
  const turn = await startRoot(env);
  await env.harness.checkpoint('user-stop-intent', env.target, {
    userInitiated: true,
  });
  const interrupted = env.driver.nextInterrupt({
    timeoutMs: SCENARIO_TIMEOUT_MS,
  });
  const stopping = env.host.stop();
  await interrupted;
  // Claude ends an interrupted foreground turn with its aborted-streaming
  // result and keeps the process (D5).
  if (env.driver.provider === 'codex') await turn.complete();
  else if (turn.emitAbortedStreamingResult)
    await turn.emitAbortedStreamingResult();
  else throw new Error('The Claude turn cannot script an interrupted result');
  await stopping;
  await env.harness.checkpoint('user-stop', env.target, {
    userInitiated: true,
  });
  await env.host.drain();
  // Any model other than DEFAULT_CODEX_MODEL recreates the session.
  if (env.driver.provider === 'codex')
    await env.host.changeSettings({ model: 'gpt-6-sol' });
  const next = await startRoot(env, 'new user prompt after Stop');
  await next.complete();
  await env.host.drain();
  if (env.driver.provider === 'claude') {
    // Stop keeps the Claude process; still exercise a settings recreation.
    await env.host.changeSettings({ model: 'sonnet' });
    const replaced = await startRoot(env, 'post-Stop settings recreation');
    await replaced.complete();
    await env.host.drain();
  }
}

export async function runCoreScenario(
  id: CoreScenarioId,
  env: ScenarioEnvironment,
): Promise<void> {
  switch (id) {
    case 1:
      await runBasicTurn(env);
      return;
    case 2:
      await runAcknowledgedSteer(env);
      return;
    case 3:
      await runRefusedGeneratedSteer(env);
      return;
    case 4:
      await runGeneratedForegroundWatcher(env);
      return;
    case 8:
      await runLiveNativeChild(env);
      return;
    case 9:
      await runSettingsChangeWithLiveNativeWork(env);
      return;
    case 10:
      await runServerRequestCancellation(env);
      return;
    case 11:
      await runWatcherRegistrationRetry(env);
      return;
    case 12:
      await runSelfStartedWakeTurn(env);
      return;
    case 13:
      await runUserStopMidTurn(env);
      return;
    default: {
      const exhaustive: never = id;
      throw new Error(`Unsupported core scenario ${String(exhaustive)}`);
    }
  }
}
