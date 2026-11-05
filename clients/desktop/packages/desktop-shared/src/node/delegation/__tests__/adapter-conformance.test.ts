import {
  parseAgentDelegationSpawnRequest,
  type AgentDelegationResult,
  type AgentDelegationSnapshot,
} from '@canopy/protocol/delegation';
import { AgentRunnerRegistry } from '../runner-registry';
import { createDelegationRunState, reduceDelegationEvent } from '../lifecycle';
import { projectAgentRoute, validateAgentRoute } from '../route';
import { waitForDelegations } from '../wait';
import { FakeParent, FakeRunner, routeFixture } from './fixtures';

describe('third parent and two-mode runner contract', () => {
  it.each([
    {
      mode: 'local-sdk',
      modelId: 'logical-local',
      thinkingLevel: 'low' as const,
      capabilities: ['read'],
    },
    {
      mode: 'remote-test',
      modelId: 'logical-remote',
      thinkingLevel: 'high' as const,
      capabilities: ['read', 'progress'],
    },
  ])(
    'runs the same lifecycle through $mode without a provider branch',
    async ({ mode, modelId, thinkingLevel, capabilities }) => {
      const parent = new FakeParent();
      const registry = new AgentRunnerRegistry();
      const runner = new FakeRunner(mode);
      const registrationId = `third-${mode}`;
      registry.register({ apiVersion: 1, registrationId, adapter: runner });
      const route = routeFixture({
        selectedModelId: modelId,
        runtimeKind: mode,
        runnerRegistrationId: registrationId,
        supportedThinkingLevels: [thinkingLevel],
        capabilities,
      });
      const context = {
        harnessId: parent.harnessId,
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'parent-chat',
        sessionKey: 'root-session',
        turnId: 'root-turn',
        toolCallId: 'native-call',
        runtimeGeneration: 1,
        depth: 0,
      };
      parent.callers.set('opaque-native-call', context);
      const originalContext = { ...context };
      const controller = new AbortController();
      const task = parseAgentDelegationSpawnRequest({
        modelId,
        description: 'review',
        prompt: 'Read the file',
        thinkingLevel,
      });
      if (!task.ok) throw new Error(task.error.message);
      expect(validateAgentRoute(modelId, thinkingLevel, route).ok).toBe(true);
      expect(validateAgentRoute(modelId, 'ultra', route).ok).toBe(false);
      await parent.replaceTools(
        ['managed-spawn', 'managed-wait', 'managed-stop'],
        1,
        controller.signal,
      );
      const acquired = registry.acquire(route);
      if (!acquired.ok) throw new Error(acquired.error.message);
      let state = createDelegationRunState('child', 1);
      try {
        expect(await acquired.value.adapter.canRun(route)).toEqual({
          available: true,
        });
        const native = await acquired.value.adapter.start(
          {
            delegationId: 'child',
            runGeneration: 1,
            launchKey: 'stable-reservation',
            parent: parent.getParentContext('opaque-native-call'),
            task: task.value,
            route,
            cwd: '/fixture/worktree',
            effectivePermission: 'read-only',
            signal: controller.signal,
          },
          (event): Promise<void> => {
            state = reduceDelegationEvent(state, event);
            return Promise.resolve();
          },
        );
        await runner.sink?.({
          delegationId: 'child',
          runGeneration: 1,
          sequence: 1,
          occurredAt: 1,
          event: { type: 'started', nativeSessionId: 'child-session' },
        });
        const snapshot = (): AgentDelegationSnapshot => ({
          ...state,
          routeSnapshot: projectAgentRoute(route),
        });
        expect(
          await waitForDelegations(
            { delegationIds: ['child'], timeoutMs: 0 },
            {
              getSnapshot: snapshot,
              subscribe: (): (() => void) => (): void => {},
            },
          ),
        ).toMatchObject({ ok: true, value: { timedOut: true } });
        expect(runner.stopped).toEqual([]);
        await runner.sink?.({
          delegationId: 'child',
          runGeneration: 1,
          sequence: 2,
          occurredAt: 2,
          event: {
            type: 'terminal',
            status: 'completed',
            finalText: 'Child report',
          },
        });
        const delivery = {
          deliveryId: 'delivery-child',
          text: state.finalText ?? '',
        };
        expect(await parent.deliverNotification(context, delivery)).toEqual(
          await parent.deliverNotification(context, delivery),
        );
        expect(parent.notifications.size).toBe(1);
        expect(context).toEqual(originalContext);
        expect(state.nativeSessionId).toBe('child-session');
        expect(runner.starts[0]?.task.contextPolicy).toBe('task_only');
        expect(runner.starts[0]?.effectivePermission).toBe('read-only');
        registry.unregister(registrationId);
        expect(registry.acquire(route).ok).toBe(false);
        await acquired.value.adapter.close(native);
        expect(runner.closed).toEqual(['child']);
      } finally {
        acquired.value.release();
      }
    },
  );

  it('rolls back a failed fake capability replacement and preserves the original owner', async () => {
    const parent = new FakeParent();
    const current = new AbortController();
    await parent.replaceTools(['old-projection'], 1, current.signal);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      parent.replaceTools(['new-projection'], 2, cancelled.signal),
    ).rejects.toThrow();
    expect(parent.generation).toBe(1);
    expect(parent.tools).toEqual(['old-projection']);
    await expect(
      parent.replaceTools(['stale-projection'], 1, current.signal),
    ).rejects.toThrow();
  });
});

it('routes both third-harness modes through the durable broker and replays third-parent results without relaunch', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { AgentDelegationBroker } = await import('../broker');
  const { FileDelegationStorage } = await import('../storage');
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'third-delegation-'),
  );
  const parent = new FakeParent();
  const registry = new AgentRunnerRegistry();
  const local = new FakeRunner('local-sdk');
  const remote = new FakeRunner('remote-test');
  registry.register({
    apiVersion: 1,
    registrationId: 'third-local',
    adapter: local,
  });
  registry.register({
    apiVersion: 1,
    registrationId: 'third-remote',
    adapter: remote,
  });
  const routes = new Map([
    [
      'local-model',
      routeFixture({
        selectedModelId: 'local-model',
        supportedThinkingLevels: ['low'],
        capabilities: ['read'],
      }),
    ],
    [
      'remote-model',
      routeFixture({
        selectedModelId: 'remote-model',
        runtimeKind: 'remote-test',
        runnerRegistrationId: 'third-remote',
        supportedThinkingLevels: ['high'],
        capabilities: ['read', 'progress'],
      }),
    ],
  ]);
  const context = {
    harnessId: parent.harnessId,
    projectId: 'p',
    worktreeId: 'w',
    chatId: 'c',
    sessionKey: 'p/w/c',
    turnId: 't',
    toolCallId: 'call',
    depth: 0,
    runtimeGeneration: 1,
  };
  parent.callers.set('native', context);
  const storage = new FileDelegationStorage(directory);
  const options = {
    registry,
    storage,
    cwd: directory,
    capacity: 2,
    resolveRoute: (
      _parent: unknown,
      task: { modelId: string },
    ): Promise<AgentDelegationResult<ReturnType<typeof routeFixture>>> => {
      const route = routes.get(task.modelId);
      return Promise.resolve(
        route
          ? { ok: true, value: route }
          : {
              ok: false,
              error: {
                code: 'route_unavailable',
                message: 'No configured route',
                retryable: false,
              },
            },
      );
    },
    authorize: (): Promise<{ ok: true; value: undefined }> =>
      Promise.resolve({
        ok: true,
        value: undefined,
      }),
  };
  const broker = new AgentDelegationBroker(options);
  let brokerClosed = false;
  const ids: string[] = [];
  try {
    await broker.initialize();
    for (const [index, modelId] of Array.from(
      ['local-model', 'remote-model'].entries(),
    )) {
      const owner = {
        ...parent.getParentContext('native'),
        toolCallId: `call-${index}`,
      };
      const input = {
        modelId,
        description: 'Independent review',
        prompt: 'Read the error handling.',
        thinkingLevel: index === 0 ? 'low' : 'high',
      };
      const runner = index === 0 ? local : remote;
      const start = runner.start.bind(runner);
      let started: () => void = () => undefined;
      const nativeStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      jest.spyOn(runner, 'start').mockImplementation(async (request, sink) => {
        const handle = await start(request, sink);
        started();
        return handle;
      });
      const result = await broker.spawn(owner, input);
      if (!result.ok) throw new Error(result.error.message);
      const id = result.value.delegationId;
      ids.push(id);
      expect(await broker.spawn(owner, input)).toMatchObject({
        ok: true,
        value: { delegationId: id },
      });
      await nativeStarted;
      expect(runner.starts).toHaveLength(1);
      registry.unregister(index === 0 ? 'third-local' : 'third-remote');
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 1,
        occurredAt: 1,
        event: { type: 'started', nativeSessionId: `native-${index}` },
      });
      await runner.sink?.({
        delegationId: id,
        runGeneration: 1,
        sequence: 2,
        occurredAt: 2,
        event: {
          type: 'terminal',
          status: 'completed',
          finalText: `Finding ${index}`,
        },
      });
      expect(await broker.getOutput(owner, { delegationId: id })).toMatchObject(
        {
          ok: true,
          value: { result: { resultIndex: 1, finalText: `Finding ${index}` } },
        },
      );
    }
    await broker.close();
    brokerClosed = true;
    expect(parent.notifications.size).toBe(0);
    const recovered = new AgentDelegationBroker(options);
    await recovered.initialize();
    try {
      const history = await recovered.transcripts(context);
      expect(
        history
          .map((item) => {
            const routeSnapshot = item.snapshot.routeSnapshot;
            if (!routeSnapshot)
              throw new Error('Expected persisted route snapshot');
            return routeSnapshot.runtimeKind;
          })
          .sort(),
      ).toEqual(['local-sdk', 'remote-test']);
      expect(
        history.every((item) => item.snapshot.status === 'completed'),
      ).toBe(true);
      expect(JSON.stringify(history)).not.toContain('private-account');
      expect(
        (await storage.load()).every(
          (record) => record.delivery.status === 'suppressed',
        ),
      ).toBe(true);
      expect(local.starts).toHaveLength(1);
      expect(remote.starts).toHaveLength(1);
      expect(local.closed).toEqual([ids[0]]);
      expect(remote.closed).toEqual([ids[1]]);
    } finally {
      await recovered.close();
    }
  } finally {
    if (!brokerClosed) await broker.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
