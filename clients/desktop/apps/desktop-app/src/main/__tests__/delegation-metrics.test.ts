import {
  DelegationMetrics,
  type DelegationMetric,
} from '../agents/delegation/metrics';
import type {
  AgentDelegationPhase,
  AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
const transcript = (
  status: AgentDelegationTranscript['snapshot']['status'],
): AgentDelegationTranscript => ({
  delegationId: 'child',
  runGeneration: 1,
  sequence: 1,
  parentHarnessId: 'claude',
  parentTurnId: 'turn',
  parentToolCallId: 'call',
  createdAt: 100,
  task: {
    description: 'PRIVATE TASK',
    prompt: 'PRIVATE PROMPT',
    executionMode: 'foreground',
  },
  transcript: [],
  snapshot: {
    delegationId: 'child',
    status,
    routeSnapshot: routeFixture(),
    outputTruncated: false,
  },
});
it.each(['completed', 'failed', 'cancelled', 'deadline_exceeded'] as const)(
  'records %s once and distinguishes native receipt from parent follow-through',
  (status) => {
    let now = 100;
    const events: DelegationMetric[] = [];
    const metrics = new DelegationMetrics(
      (event) => events.push(event),
      () => now,
    );
    metrics.transcript(transcript(status));
    expect(events).toEqual([]);
    metrics.transcript(transcript('pending'));
    const task = {
      modelId: 'logical',
      description: 'SECRET',
      prompt: 'SECRET',
      executionMode: 'foreground' as const,
      contextPolicy: 'task_only' as const,
      isolation: 'shared_worktree' as const,
      thinkingLevel: 'low' as const,
    };
    metrics.invocation('native-call', task, {
      ok: true,
      value: transcript('pending').snapshot,
    });
    metrics.invocation('native-call', task, {
      ok: true,
      value: transcript('pending').snapshot,
    });
    now = 350;
    metrics.transcript(transcript(status));
    metrics.transcript(transcript(status));
    metrics.rootOutput();
    expect(events.map((event) => event.event)).toEqual([
      'invocation',
      'terminal',
    ]);
    expect(events[1]).toMatchObject({ status, durationMs: 250 });
    metrics.acknowledged('child');
    metrics.acknowledged('child');
    metrics.rootOutput();
    metrics.rootOutput();
    expect(events.map((event) => event.event)).toEqual([
      'invocation',
      'terminal',
      'delivery_acknowledged',
      'parent_follow_through',
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /SECRET|PRIVATE|private-account/,
    );
  },
);
it('counts rejected invocations without raw errors or task text', () => {
  const emit = jest.fn();
  const metrics = new DelegationMetrics(emit);
  metrics.invocation(
    'call',
    {
      modelId: 'id',
      prompt: 'secret',
      description: 'secret',
      executionMode: 'background',
      contextPolicy: 'task_only',
      isolation: 'shared_worktree',
    },
    {
      ok: false,
      error: {
        code: 'auth_required',
        message: 'private detail',
        retryable: false,
      },
    },
  );
  expect(emit).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'invocation',
      status: 'rejected',
      errorCode: 'auth_required',
    }),
  );
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(/secret|private detail/);
});

it('does not count a later unrelated user turn as follow-through', () => {
  const events: DelegationMetric[] = [];
  const metrics = new DelegationMetrics((event) => events.push(event));
  metrics.transcript(transcript('pending'));
  metrics.transcript(transcript('completed'));
  metrics.acknowledged('child', 'delivery-turn');
  metrics.rootOutput('unrelated-turn');
  expect(events.some((event) => event.event === 'parent_follow_through')).toBe(
    false,
  );
  metrics.rootOutput('delivery-turn');
  expect(
    events.filter((event) => event.event === 'parent_follow_through'),
  ).toHaveLength(1);
});

const phased = (
  status: AgentDelegationTranscript['snapshot']['status'],
  phase: AgentDelegationPhase,
  extra: Partial<AgentDelegationTranscript['snapshot']> = {},
): AgentDelegationTranscript => {
  const base = transcript(status);
  return {
    ...base,
    snapshot: { ...base.snapshot, phase, ...extra },
  };
};

const queueTask = {
  modelId: 'logical',
  description: 'SECRET',
  prompt: 'SECRET',
  executionMode: 'background' as const,
  contextPolicy: 'task_only' as const,
  isolation: 'shared_worktree' as const,
};

it('emits queued and admitted events, excluding the queue wait from terminal duration', () => {
  let now = 1000;
  const events: DelegationMetric[] = [];
  const metrics = new DelegationMetrics(
    (event) => events.push(event),
    () => now,
  );
  metrics.transcript(phased('pending', 'queued'));
  now = 1200;
  metrics.transcript(phased('pending', 'starting'));
  now = 1500;
  metrics.transcript(phased('running', 'running'));
  now = 2500;
  metrics.transcript(phased('completed', 'idle'));
  expect(events.map((event) => event.event)).toEqual([
    'queued',
    'admitted',
    'terminal',
  ]);
  expect(events[1]).toMatchObject({ event: 'admitted', queueWaitMs: 200 });
  // Excludes the 500ms spent queued/starting: measured from the first
  // running sighting (1500), not the original queued sighting (1000).
  expect(events[2]).toMatchObject({
    event: 'terminal',
    status: 'completed',
    durationMs: 1000,
  });
});

it('emits queue_withdrawn with the stop reason when a queued run is cancelled before it starts', () => {
  const events: DelegationMetric[] = [];
  const metrics = new DelegationMetrics((event) => events.push(event));
  metrics.transcript(phased('pending', 'queued'));
  metrics.transcript(
    phased('cancelled', 'idle', { stopReason: 'user_cancelled' }),
  );
  expect(events.map((event) => event.event)).toEqual([
    'queued',
    'queue_withdrawn',
    'terminal',
  ]);
  expect(events[1]).toMatchObject({
    event: 'queue_withdrawn',
    reason: 'user_cancelled',
  });
  expect(events[2]).toMatchObject({ event: 'terminal', status: 'cancelled' });
});

it('falls back to the snapshot status as the queue_withdrawn reason when no stop reason is recorded', () => {
  const events: DelegationMetric[] = [];
  const metrics = new DelegationMetrics((event) => events.push(event));
  metrics.transcript(phased('pending', 'queued'));
  metrics.transcript(phased('failed', 'idle'));
  expect(
    events.find((event) => event.event === 'queue_withdrawn'),
  ).toMatchObject({ reason: 'failed' });
});

it('records admission on invocation and propagates its live queue position to the queued event', () => {
  const events: DelegationMetric[] = [];
  const metrics = new DelegationMetrics((event) => events.push(event));
  metrics.invocation('spawn-call-queued', queueTask, {
    ok: true,
    value: {
      delegationId: 'child',
      runGeneration: 1,
      status: 'pending',
      outputTruncated: false,
      phase: 'queued',
      queue: {
        id: 'default',
        name: 'Default',
        position: 4,
        waitingFor: 'app',
      },
    },
  });
  expect(events[0]).toMatchObject({
    event: 'invocation',
    admission: 'queued',
  });
  metrics.transcript(phased('pending', 'queued'));
  expect(events[1]).toMatchObject({
    event: 'queued',
    position: 4,
    waitingFor: 'app',
  });
  expect(JSON.stringify(events)).not.toMatch(/SECRET|PRIVATE|private-account/);
});

it('records granted admission on an invocation that started immediately', () => {
  const events: DelegationMetric[] = [];
  const metrics = new DelegationMetrics((event) => events.push(event));
  metrics.invocation('spawn-call-granted', queueTask, {
    ok: true,
    value: {
      delegationId: 'child-granted',
      runGeneration: 1,
      status: 'pending',
      outputTruncated: false,
      phase: 'starting',
    },
  });
  expect(events[0]).toMatchObject({
    event: 'invocation',
    admission: 'granted',
  });
});

it('observes separate run generations without emitting private identifiers', () => {
  const events: DelegationMetric[] = [];
  const metrics = new DelegationMetrics((event) => events.push(event));
  metrics.transcript(transcript('pending'));
  metrics.transcript(transcript('completed'));
  metrics.acknowledged('child', 'first-turn');
  metrics.rootOutput('first-turn');
  metrics.transcript({ ...transcript('pending'), runGeneration: 2 });
  metrics.transcript({ ...transcript('completed'), runGeneration: 2 });
  expect(events.filter((event) => event.event === 'terminal')).toHaveLength(2);
});
