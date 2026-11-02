import type { ActivityLiveBgTask } from '@canopy/desktop-shared/types/activity-panel';
import type { ProviderEventInput } from '../../services/chat-state-service';
import type { AgentSession, AgentSessionOptions } from '../types';
import {
  getOrCreateRoutedSession,
  sessionEventRouterTestExports,
} from '../session-event-router';
import { getOrCreateSession } from '../session-manager';
import {
  startChildToolsSettlement,
  type ChildToolsSettlementDependencies,
} from '../child-tools-settlement';
import type { LiveBackgroundTaskOwner } from '../session-manager';

jest.mock('../session-manager', () => ({
  buildSessionKey: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string => `${projectId}/${worktreeId}/${chatId}`,
  getOrCreateSession: jest.fn(),
  listLiveBackgroundTaskOwners: jest.fn(() => []),
  subscribeLiveBackgroundTasks: jest.fn(() => (): void => undefined),
}));

const SESSION_KEY = 'project/worktree/chat';
const TARGET = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

function owner(liveTasks: ActivityLiveBgTask[]): LiveBackgroundTaskOwner {
  return {
    sessionKey: SESSION_KEY,
    ...TARGET,
    liveTasks,
  };
}

function task(
  taskId: string,
  toolUseId: string | undefined,
  taskType?: string,
): ActivityLiveBgTask {
  return {
    taskId,
    ...(toolUseId === undefined ? {} : { toolUseId }),
    ...(taskType === undefined ? {} : { taskType }),
  };
}

function testDependencies(options: {
  getOwners: () => LiveBackgroundTaskOwner[];
  drain?: ChildToolsSettlementDependencies['drainCurrentSessionEvents'];
  ingest?: ChildToolsSettlementDependencies['ingestProviderEvent'];
}): {
  dependencies: Partial<ChildToolsSettlementDependencies>;
  notifyLiveTasks(sessionKey?: string): void;
  events: ProviderEventInput[];
  drainCalls: string[];
} {
  const liveListeners = new Set<(sessionKey: string) => void>();
  const events: ProviderEventInput[] = [];
  const drainCalls: string[] = [];
  const dependencies: Partial<ChildToolsSettlementDependencies> = {
    listLiveBackgroundTaskOwners: options.getOwners,
    subscribeLiveBackgroundTasks: (listener) => {
      liveListeners.add(listener);
      return () => liveListeners.delete(listener);
    },
    drainCurrentSessionEvents:
      options.drain ?? ((): Promise<void> => Promise.resolve()),
    ingestProviderEvent: async (input) => {
      events.push(input);
      return options.ingest ? options.ingest(input) : { outcome: 'applied' };
    },
  };
  if (!options.drain) {
    dependencies.drainCurrentSessionEvents = (target): Promise<void> => {
      drainCalls.push(
        `${target.projectId}/${target.worktreeId}/${target.chatId}`,
      );
      return Promise.resolve();
    };
  }
  return {
    dependencies,
    notifyLiveTasks: (sessionKey = SESSION_KEY): void => {
      for (const listener of Array.from(liveListeners)) listener(sessionKey);
    },
    events,
    drainCalls,
  };
}

describe('child tools settlement emitter', () => {
  beforeEach(() => {
    sessionEventRouterTestExports.reset();
    jest.mocked(getOrCreateSession).mockReset();
  });

  afterEach(() => {
    sessionEventRouterTestExports.reset();
  });

  it('emits one event for removed agent, unknown, and missing-type tasks only', async () => {
    let owners = [
      owner([
        task('local-agent', 'local-parent', 'local_agent'),
        task('remote-agent', 'remote-parent', 'remote_agent'),
        task('future-agent', 'future-parent', 'future_agent'),
        task('missing-type', 'missing-parent'),
        task('local-bash', 'shell-parent', 'local_bash'),
        task('mcp-task', 'mcp-parent', 'mcp_task'),
        task('uncorrelated', undefined, 'future_agent'),
      ]),
    ];
    const test = testDependencies({ getOwners: () => owners });
    const settlement = startChildToolsSettlement(test.dependencies);

    owners = [owner([])];
    test.notifyLiveTasks();
    await settlement.drain();

    expect(test.events).toHaveLength(1);
    expect(test.events[0]).toMatchObject({
      ...TARGET,
      data: {
        type: 'canopy_child_tools_ended',
        parent_tool_use_ids: [
          'local-parent',
          'remote-parent',
          'future-parent',
          'missing-parent',
        ],
      },
    });

    test.notifyLiveTasks();
    await settlement.drain();
    expect(test.events).toHaveLength(1);
    settlement.stop();
  });

  it('snapshots each live-set change synchronously and preserves separate events', async () => {
    let owners = [owner([task('first', 'parent-first', 'local_agent')])];
    const test = testDependencies({ getOwners: () => owners });
    const settlement = startChildToolsSettlement(test.dependencies);

    owners = [owner([])];
    test.notifyLiveTasks();
    owners = [owner([task('second', 'parent-second', 'in_process_teammate')])];
    test.notifyLiveTasks();
    owners = [owner([])];
    test.notifyLiveTasks();
    await settlement.drain();

    expect(test.events).toHaveLength(2);
    expect(
      test.events.map((event) => {
        if (
          typeof event.data === 'object' &&
          event.data !== null &&
          'parent_tool_use_ids' in event.data &&
          Array.isArray(event.data.parent_tool_use_ids)
        ) {
          return event.data.parent_tool_use_ids.filter(
            (value: unknown): value is string => typeof value === 'string',
          );
        }
        return [];
      }),
    ).toEqual([['parent-first'], ['parent-second']]);
    settlement.stop();
  });

  it('treats a disappeared task owner as an empty current live set', async () => {
    let owners = [
      owner([task('gone-owner-task', 'gone-parent', 'local_agent')]),
    ];
    const test = testDependencies({ getOwners: () => owners });
    const settlement = startChildToolsSettlement(test.dependencies);

    owners = [];
    test.notifyLiveTasks();
    await settlement.drain();

    expect(test.events).toHaveLength(1);
    expect(test.events[0]?.data).toMatchObject({
      type: 'canopy_child_tools_ended',
      parent_tool_use_ids: ['gone-parent'],
    });
    settlement.stop();
  });

  it('ingests a removal while the provider callback is active, after the router prefix drains', async () => {
    let owners = [owner([task('agent', 'agent-parent', 'local_agent')])];
    let routeProviderEvent:
      | ((data: unknown) => void | Promise<void>)
      | undefined;
    let releaseProviderEvent: () => void = () => undefined;
    let signalProviderEventStarted: () => void = () => undefined;
    const providerEventStarted = new Promise<void>((resolve) => {
      signalProviderEventStarted = resolve;
    });
    const blockedProviderEvent = new Promise<void>((resolve) => {
      releaseProviderEvent = resolve;
    });
    const order: string[] = [];
    const session: AgentSession = {
      sendMessage: () => undefined,
      cancel: () => Promise.resolve(),
      destroy: () => Promise.resolve(),
      setPlanMode: () => Promise.resolve(),
      setApprovalMode: () => Promise.resolve(),
      setThinkingLevel: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
    };
    jest.mocked(getOrCreateSession).mockImplementation((_options, onEvent) => {
      routeProviderEvent = onEvent;
      return Promise.resolve(session);
    });
    const routeOptions: AgentSessionOptions = {
      cwd: '/workspace',
      ...TARGET,
      providerType: 'claude',
    };
    await getOrCreateRoutedSession(
      routeOptions,
      async () => {
        order.push('provider-started');
        signalProviderEventStarted();
        await blockedProviderEvent;
        order.push('provider-delivered');
      },
      () => null,
      {
        turnUserMessageId: 'turn',
        drainEventsBeforeRemoval: () => Promise.resolve(),
      },
    );
    const ingress = routeProviderEvent;
    if (!ingress) throw new Error('Expected the provider route callback');
    const test = testDependencies({
      getOwners: () => owners,
      drain: async (target) => {
        await import('../session-event-router').then(
          ({ drainCurrentSessionEvents }) => drainCurrentSessionEvents(target),
        );
        order.push('router-prefix-drained');
      },
      ingest: (input) => {
        order.push('settlement-ingested');
        void input;
        return Promise.resolve({ outcome: 'applied' });
      },
    });
    const settlement = startChildToolsSettlement(test.dependencies);

    void ingress({ type: 'provider-frame' });
    await providerEventStarted;
    owners = [owner([])];
    test.notifyLiveTasks();
    await Promise.resolve();
    await Promise.resolve();
    expect(test.events).toHaveLength(0);

    releaseProviderEvent();
    await settlement.drain();

    expect(order.indexOf('provider-delivered')).toBeLessThan(
      order.indexOf('router-prefix-drained'),
    );
    expect(order.indexOf('router-prefix-drained')).toBeLessThan(
      order.indexOf('settlement-ingested'),
    );
    expect(test.events).toHaveLength(1);
    expect(test.events[0]?.data).toMatchObject({
      type: 'canopy_child_tools_ended',
      parent_tool_use_ids: ['agent-parent'],
    });
    settlement.stop();
  });
});
