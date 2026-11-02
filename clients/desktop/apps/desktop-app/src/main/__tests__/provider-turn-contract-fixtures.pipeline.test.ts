/** Recorder contracts replay only fixture-owned envelopes through real worktree turns. */
import type {
  LifecycleFixture,
  LifecycleFrame,
  LifecycleFrameObservation,
  LifecycleGroup,
  LifecycleStep,
  ProviderTraceEvent,
} from './pipeline-harness/contracts';
import {
  assertFixtureFrames,
  expectedFrame,
  fixtureFrames,
  loadLifecycleFixtures,
  normalizedProviderFrames,
  parseLifecycleFixture,
  replayLifecycleGroup,
  replayLifecycleFixture,
} from './pipeline-harness/fixture-replay';
import * as scenarios from './pipeline-harness/scenarios';

const { SCENARIO_TEST_TIMEOUT_MS } = scenarios;

const fixtures = loadLifecycleFixtures();
const RENDERER_REPLAY_REASON =
  'requires a renderer window; replayed by the Electron replay in phase 30';
const CHILD_INTERRUPT_REPLAY_REASON =
  'a child-targeted interrupt needs Codex per-task Stop, which stays disabled (phase 20 gate)';
function requiresRenderer(steps: readonly LifecycleStep[]): boolean {
  return steps.some((entry) =>
    entry.kind === 'control'
      ? ['permission-allow', 'permission-deny', 'approve', 'deny'].includes(
          entry.action,
        )
      : entry.kind === 'group' && entry.lanes.some(requiresRenderer),
  );
}

function requiresUnavailableChildInterrupt(
  steps: readonly LifecycleStep[],
): boolean {
  return steps.some(
    (entry) =>
      entry.kind === 'evidence' &&
      entry.event === 'interrupt-sent' &&
      entry.role === 'child',
  );
}

function recordField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = record[key];
  return isReadonlyRecord(value) ? value : undefined;
}

function isReadonlyRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

const codexSubagentRegistration = (():
  | {
      fixture: LifecycleFixture;
      startedActivity: LifecycleFrame;
      alias: string;
      firstChildFrame: LifecycleFrame;
    }
  | undefined => {
  const fixture = fixtures.find(
    ({ fixture: candidate }) =>
      candidate.provider === 'codex' &&
      candidate.scenario === 'subagent-after-root-turn',
  )?.fixture;
  if (!fixture) return undefined;
  const frames = fixtureFrames(fixture.steps);
  const startedActivity = frames.find(
    (frame) =>
      frame.lane === 'root' &&
      frame.type === 'notification:item/started' &&
      frame.shape?.[0] === 'subAgentActivity' &&
      frame.fields?.subagentKind === 'started',
  );
  const alias = startedActivity?.ids?.agentThread;
  if (!startedActivity || !alias) return undefined;
  const firstChildFrame = frames.find(
    (frame) => frame.lane === `child:${alias}`,
  );
  return firstChildFrame
    ? { fixture, startedActivity, alias, firstChildFrame }
    : undefined;
})();

it(
  'Codex subagent lane is registered on the real pooled connection before its first child frame',
  async () => {
    const registration = codexSubagentRegistration;
    if (!registration) throw new Error('Missing re-recorded subagent fixture');
    let materializedAlias: string | undefined;
    let materializedAgentThreadId: string | undefined;
    let firstChildLiveThreadId: string | undefined;
    let registrationWasVisibleBeforeChildFrame = false;

    await replayLifecycleFixture(registration.fixture, {
      registerAdditionalCodexPoolOwner: true,
      onBeforeCodexFrameWrite: ({
        frame,
        envelope,
        liveId,
        connection,
        registeredSubagentThreadIds,
      }) => {
        if (
          frame.lane === 'root' &&
          frame.type === registration.startedActivity.type &&
          frame.shape?.[0] === 'subAgentActivity' &&
          frame.fields?.subagentKind === 'started'
        ) {
          const alias = frame.ids?.agentThread;
          if (!alias)
            throw new Error('Subagent started frame lacks agentThread alias');
          const item = recordField(
            recordField(envelope, 'params') ?? {},
            'item',
          );
          materializedAlias = alias;
          materializedAgentThreadId = stringField(item, 'agentThreadId');
          expect(materializedAgentThreadId).toBe(liveId('thread', alias));
        }

        if (
          !registrationWasVisibleBeforeChildFrame &&
          frame.lane === `child:${registration.alias}`
        ) {
          const childId = liveId('thread', registration.alias);
          if (!childId)
            throw new Error(
              `No live thread id was materialized for ${registration.alias}`,
            );
          if (!connection)
            throw new Error(
              'The real Codex app-server connection was not observed',
            );
          firstChildLiveThreadId = childId;
          expect(connection.clientCount()).toBeGreaterThan(1);
          expect(registeredSubagentThreadIds).toContain(childId);
          expect(connection.resolveOwnerForThread(childId)).not.toBeNull();
          registrationWasVisibleBeforeChildFrame = true;
        }
      },
    });

    expect(materializedAlias).toBe(registration.alias);
    expect(materializedAgentThreadId).toBe(firstChildLiveThreadId);
    expect(registrationWasVisibleBeforeChildFrame).toBe(true);
  },
  SCENARIO_TEST_TIMEOUT_MS * 2,
);

function mutateTerminal(
  steps: readonly LifecycleStep[],
  terminal: LifecycleStep,
): LifecycleStep[] {
  return steps.map((entry) =>
    entry.kind === 'group'
      ? {
          ...entry,
          lanes: entry.lanes.map((lane) => mutateTerminal(lane, terminal)),
        }
      : entry === terminal && entry.kind === 'frame'
        ? {
            ...entry,
            fields: { ...entry.fields, terminalReason: 'mutated-terminal' },
          }
        : entry,
  );
}

it('has lifecycle fixtures (absence must never silently skip contract coverage)', () => {
  expect(fixtures.length).toBeGreaterThan(0);
}, 5000);

it('evidence interrupt responses must project the product request target', () => {
  const fixture = fixtures.find(
    ({ fixture: candidate }) =>
      candidate.scenario === 'interrupt-root-with-held-child',
  )?.fixture;
  if (!fixture) throw new Error('Missing D10 root-interrupt fixture');

  const target = {
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
  };
  let seq = 0;
  const trace: ProviderTraceEvent[] = [];
  for (const frame of fixtureFrames(fixture.steps)) {
    if (frame.type === 'response:turn/interrupt') {
      seq += 1;
      trace.push({
        kind: 'provider',
        seq,
        at: seq,
        logicalAt: seq,
        provider: 'codex',
        target,
        direction: 'to-provider',
        type: 'client:turn/interrupt',
        ids: { requestId: 'interrupt-request' },
        replayFrame: {
          lane: 'child:h2',
          type: 'request:turn/interrupt',
          ids: { thread: 'h2', turn: 't2' },
        },
      });
    }
    seq += 1;
    trace.push({
      kind: 'provider',
      seq,
      at: seq,
      logicalAt: seq,
      provider: 'codex',
      target,
      direction: 'to-canopy',
      type: frame.type,
      ...(frame.type === 'response:turn/interrupt'
        ? { ids: { requestId: 'interrupt-request' } }
        : {}),
      replayFrame: expectedFrame(frame),
    });
  }

  expect(() =>
    assertFixtureFrames(fixture, normalizedProviderFrames(trace, fixture)),
  ).toThrow('frame 16 differs');
});

for (const { path, fixture } of fixtures) {
  if (requiresRenderer(fixture.steps)) {
    process.stdout.write(
      `[lifecycle replay skipped] ${fixture.provider}/${fixture.scenario}: ${RENDERER_REPLAY_REASON}\n`,
    );
    it(`${fixture.provider}/${fixture.scenario}: replay skipped — ${RENDERER_REPLAY_REASON}`, () => {
      expect(requiresRenderer(fixture.steps)).toBe(true);
      expect(RENDERER_REPLAY_REASON).toBe(
        'requires a renderer window; replayed by the Electron replay in phase 30',
      );
    }, 5000);
    it.skip(
      `${fixture.provider}/${fixture.scenario}: ${RENDERER_REPLAY_REASON}`,
      () => {},
      SCENARIO_TEST_TIMEOUT_MS,
    );
    continue;
  }
  if (requiresUnavailableChildInterrupt(fixture.steps)) {
    process.stdout.write(
      `[lifecycle replay skipped] ${fixture.provider}/${fixture.scenario}: ${CHILD_INTERRUPT_REPLAY_REASON}\n`,
    );
    it(`${fixture.provider}/${fixture.scenario}: replay skipped — ${CHILD_INTERRUPT_REPLAY_REASON}`, () => {
      expect(requiresUnavailableChildInterrupt(fixture.steps)).toBe(true);
      expect(CHILD_INTERRUPT_REPLAY_REASON).toBe(
        'a child-targeted interrupt needs Codex per-task Stop, which stays disabled (phase 20 gate)',
      );
    }, 5000);
    it.skip(
      `${fixture.provider}/${fixture.scenario}: ${CHILD_INTERRUPT_REPLAY_REASON}`,
      () => {},
      SCENARIO_TEST_TIMEOUT_MS,
    );
    continue;
  }
  it(
    `${fixture.provider}/${fixture.scenario}: exact frames, invariants and deterministic fresh replay (${path})`,
    async () => {
      const first = await replayLifecycleFixture(fixture);
      const second = await replayLifecycleFixture(fixture);
      expect(second).toEqual(first);
      const terminal = fixtureFrames(fixture.steps).at(-1);
      if (!terminal) throw new Error('Fixture has no terminal frame');
      const changed: LifecycleFixture = {
        ...fixture,
        steps: mutateTerminal(fixture.steps, terminal),
      };
      expect(() => assertFixtureFrames(changed, first)).toThrow('differs');
      const withWrongOrigin = first.map((frame, index) =>
        index === 0
          ? {
              ...frame,
              fields: { ...frame.fields, originKind: 'unclassified' },
            }
          : frame,
      );
      expect(() => assertFixtureFrames(fixture, withWrongOrigin)).toThrow(
        'differs',
      );
      expect(() => assertFixtureFrames(fixture, first.slice(0, -1))).toThrow(
        'differs',
      );
      expect(() =>
        assertFixtureFrames(fixture, [
          ...first,
          first[0] ?? { lane: 'root', type: 'extra' },
        ]),
      ).toThrow('extra provider frames');
      const reordered = [...first];
      if (reordered.length > 1) {
        const last = reordered.pop();
        if (last) reordered.unshift(last);
        expect(() => assertFixtureFrames(fixture, reordered)).toThrow(
          'differs',
        );
      }
    },
    SCENARIO_TEST_TIMEOUT_MS * 2,
  );
}

for (const { provider, deferInitialSteering } of [
  { provider: 'claude', deferInitialSteering: false },
  { provider: 'claude', deferInitialSteering: true },
  { provider: 'codex', deferInitialSteering: false },
] as const) {
  it(
    `${provider}: watcher mid-turn composed over a validated lifecycle fixture${deferInitialSteering ? ' with queued steering' : ''}`,
    async () => {
      const base = fixtures.find(
        ({ fixture }) => fixture.scenario === `handwritten-basic-${provider}`,
      )?.fixture;
      if (!base) throw new Error(`Missing ${provider} composition base`);
      const steps = structuredClone(base.steps);
      const terminal = steps.pop();
      if (!terminal || terminal.kind !== 'frame')
        throw new Error('Missing terminal composition boundary');
      steps.push({ kind: 'control', action: 'steer', ids: { message: 'm5' } });
      if (provider === 'claude') {
        // C5 must not synthesize acceptance. Declare the real SDK pickup
        // receipt explicitly; consumed aliases retire only at the terminal.
        steps.push({
          kind: 'frame',
          lane: 'root',
          type: 'sdk:command_lifecycle',
          ids: { message: 'm5' },
          fields: { commandState: 'started' },
          template: 'claude.sdk-message',
        });
        terminal.consumed = [...(terminal.consumed ?? []), 'm5'];
        steps.push({
          kind: 'frame',
          lane: 'root',
          type: 'sdk:assistant',
          shape: ['text'],
          ids: { session: 's1', message: 'm6' },
          fields: { stopReason: null },
          template: 'claude.assistant.text',
        });
      } else {
        steps.push({
          kind: 'frame',
          lane: 'root',
          type: 'response:turn/steer',
          ids: { request: 'r4' },
          template: 'codex.response',
        });
        steps.push({
          kind: 'frame',
          lane: 'root',
          type: 'notification:item/completed',
          shape: ['agentMessage'],
          ids: { thread: 'h1', turn: 't1', item: 'i2' },
          template: 'codex.notification',
        });
      }
      steps.push(terminal);
      const composed = parseLifecycleFixture({
        ...base,
        scenario: `watcher-mid-turn-${provider}`,
        steps,
      });
      const createEnvironment = scenarios.createScenarioEnvironment;
      let initialSteeringDeferred = false;
      let restoreSteering = (): void => undefined;
      const environmentSpy = deferInitialSteering
        ? jest
            .spyOn(scenarios, 'createScenarioEnvironment')
            .mockImplementationOnce(async (...args) => {
              const env = await createEnvironment(...args);
              const { getChatStateService } =
                await import('../services/chat-state-service');
              // A transient eligibility loss can defer initial steering. Keep
              // the real queue, its logical scheduler and SDK pickup intact.
              const steeringSpy = jest
                .spyOn(getChatStateService().inputDelivery, 'steerGenerated')
                .mockImplementationOnce(() => {
                  initialSteeringDeferred = true;
                  return Promise.resolve({ status: 'fallback' });
                });
              restoreSteering = (): void => steeringSpy.mockRestore();
              return env;
            })
        : undefined;
      try {
        await replayLifecycleFixture(composed);
        expect(initialSteeringDeferred).toBe(deferInitialSteering);
      } finally {
        restoreSteering();
        environmentSpy?.mockRestore();
      }
    },
    SCENARIO_TEST_TIMEOUT_MS * 2,
  );
}

it('groups compare a multiset of ordered lanes, retaining duplicates and order', () => {
  const fixture = parseLifecycleFixture({
    schemaVersion: 1,
    scenario: 'group-comparator',
    provider: 'codex',
    tier: 'fast',
    profile: 'codex-chat',
    provenance: { binaryVersion: 'synthetic' },
    semantics: [],
    steps: [
      {
        kind: 'group',
        lanes: [
          [
            {
              kind: 'frame',
              lane: 'child:a',
              type: 'notification:a1',
              template: 'a1',
            },
            {
              kind: 'frame',
              lane: 'child:a',
              type: 'notification:a2',
              template: 'a2',
            },
          ],
          [
            {
              kind: 'frame',
              lane: 'child:b',
              type: 'notification:b1',
              template: 'b1',
            },
          ],
        ],
      },
    ],
  });
  const [a1, a2, b1] = fixtureFrames(fixture.steps).map(expectedFrame);
  if (!a1 || !a2 || !b1) throw new Error('Missing group frames');
  const shuffled: LifecycleFrameObservation[] = [b1, a1, a2];
  expect(() => assertFixtureFrames(fixture, shuffled)).not.toThrow();
  expect(() => assertFixtureFrames(fixture, [a2, b1, a1])).toThrow(
    'lane order',
  );
  expect(() => assertFixtureFrames(fixture, [a1, b1, b1])).toThrow(
    'multiplicity',
  );
}, 5000);

function parseGroupForScheduler(
  scenario: string,
  group: LifecycleGroup,
): LifecycleGroup {
  const fixture = parseLifecycleFixture({
    schemaVersion: 1,
    scenario,
    provider: 'codex',
    tier: 'fast',
    profile: 'codex-chat',
    provenance: { binaryVersion: 'synthetic' },
    semantics: [],
    steps: [group],
  });
  const parsed = fixture.steps[0];
  if (!parsed || parsed.kind !== 'group')
    throw new Error('Missing parsed scheduler group');
  return parsed;
}

it('group scheduler emits each first-listed unblocked step while preserving lane order', async () => {
  const group = parseGroupForScheduler('scheduler-child-gate', {
    kind: 'group',
    lanes: [
      [
        {
          kind: 'frame',
          lane: 'child:h2',
          type: 'notification:thread/status/changed',
          template: 'codex.notification',
        },
        {
          kind: 'frame',
          lane: 'child:h2',
          type: 'notification:turn/started',
          template: 'codex.notification',
        },
      ],
      [
        {
          kind: 'frame',
          lane: 'root',
          type: 'notification:item/started',
          shape: ['subAgentActivity'],
          ids: { agentThread: 'h2' },
          fields: { subagentKind: 'started' },
          template: 'codex.notification',
        },
        {
          kind: 'frame',
          lane: 'root',
          type: 'notification:turn/completed',
          template: 'codex.notification',
        },
      ],
    ],
  });
  const observed: string[] = [];
  await replayLifecycleGroup(
    'scheduler-child-gate',
    group,
    (step): Promise<void> => {
      if (step.kind === 'frame') observed.push(step.type);
      return Promise.resolve();
    },
    new Set<LifecycleFrame>(),
  );
  expect(observed).toEqual([
    'notification:item/started',
    'notification:thread/status/changed',
    'notification:turn/started',
    'notification:turn/completed',
  ]);
}, 5000);

it('group scheduler fails instead of hanging when every child lane waits on an un-emitted start frame', async () => {
  const group = parseGroupForScheduler('scheduler-all-lanes-blocked', {
    kind: 'group',
    lanes: [
      [
        {
          kind: 'frame',
          lane: 'child:a',
          type: 'notification:item/started',
          shape: ['subAgentActivity'],
          ids: { agentThread: 'a' },
          fields: { subagentKind: 'started' },
          template: 'codex.notification',
        },
      ],
      [
        {
          kind: 'frame',
          lane: 'child:b',
          type: 'notification:item/started',
          shape: ['subAgentActivity'],
          ids: { agentThread: 'b' },
          fields: { subagentKind: 'started' },
          template: 'codex.notification',
        },
      ],
    ],
  });
  await expect(
    replayLifecycleGroup(
      'scheduler-all-lanes-blocked',
      group,
      (): Promise<void> => Promise.resolve(),
      new Set<LifecycleFrame>(),
    ),
  ).rejects.toThrow('no unblocked lane');
}, 5000);

it('rejects malformed, content-bearing, and unsorted-set contracts', () => {
  const fixture = fixtures[0]?.fixture;
  if (!fixture) throw new Error('No fixture available');
  expect(() =>
    parseLifecycleFixture({ ...fixture, schemaVersion: 2 }),
  ).toThrow();
  expect(() =>
    parseLifecycleFixture({ ...fixture, text: 'unredacted payload' }),
  ).toThrow();
  const first = fixtureFrames(fixture.steps)[0];
  if (!first) throw new Error('No frame available');
  expect(() =>
    parseLifecycleFixture({
      ...fixture,
      steps: [{ ...first, fields: { prompt: 'unredacted payload' } }],
    }),
  ).toThrow('not lifecycle data');
  expect(() =>
    parseLifecycleFixture({
      ...fixture,
      steps: [{ ...first, fields: { membersSet: ['z', 'a'] } }],
    }),
  ).toThrow('sorted set');
}, 5000);
