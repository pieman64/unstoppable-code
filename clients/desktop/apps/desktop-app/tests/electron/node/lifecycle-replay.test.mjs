import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createGates,
  createReplayLog,
  loadReplayFixture,
  readReplayEnv,
  runReplay,
  scheduleSteps,
} from '../fixtures/lifecycle-replay.mjs';

const lifecycleFixturePath = path.resolve(
  'scripts/harness-contract/lifecycle/fixtures/codex/subagent-after-root-turn.json',
);

function temporaryDirectory() {
  return mkdtempSync(path.join(tmpdir(), 'canopy-lifecycle-replay-'));
}

function frame(lane, type, extra = {}) {
  return {
    kind: 'frame',
    lane,
    type,
    template: 'codex.notification',
    ...extra,
  };
}

function scheduleFixture(steps) {
  return { steps };
}

test('exports only the lifecycle replay API', async () => {
  const replay = await import('../fixtures/lifecycle-replay.mjs');
  assert.deepEqual(Object.keys(replay).sort(), [
    'createGates',
    'createReplayLog',
    'loadReplayFixture',
    'readReplayEnv',
    'runReplay',
    'scheduleSteps',
  ]);
});

test('readReplayEnv returns undefined when replay was not requested', () => {
  assert.equal(readReplayEnv({}), undefined);
});

test('readReplayEnv rejects an empty fixture path and invalid armed gate names', () => {
  assert.throws(
    () => readReplayEnv({ CANOPY_LIFECYCLE_REPLAY_FIXTURE: '' }),
    /absolute path/i,
  );
  assert.throws(
    () =>
      readReplayEnv({
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: '/fixture.json',
        CANOPY_LIFECYCLE_REPLAY_GATES: '/gates',
        CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: '["release-../secret"]',
      }),
    /Invalid replay gate name/i,
  );
});

test('readReplayEnv parses absolute paths, armed gates, and delays', () => {
  const root = temporaryDirectory();
  try {
    const env = {
      CANOPY_LIFECYCLE_REPLAY_FIXTURE: path.join(root, 'fixture.json'),
      CANOPY_LIFECYCLE_REPLAY_MODULE: path.join(root, 'fake.mjs'),
      CANOPY_LIFECYCLE_REPLAY_LOG: path.join(root, 'replay.jsonl'),
      CANOPY_LIFECYCLE_REPLAY_GATES: path.join(root, 'gates'),
      CANOPY_LIFECYCLE_REPLAY_ARMED_GATES:
        '["before-0","release-subagent-child"]',
      CANOPY_LIFECYCLE_REPLAY_DELAYS: '{"0":0,"2":45}',
    };

    assert.deepEqual(readReplayEnv(env), {
      fixturePath: env.CANOPY_LIFECYCLE_REPLAY_FIXTURE,
      modulePath: env.CANOPY_LIFECYCLE_REPLAY_MODULE,
      logPath: env.CANOPY_LIFECYCLE_REPLAY_LOG,
      gatesDir: env.CANOPY_LIFECYCLE_REPLAY_GATES,
      armedGates: ['before-0', 'release-subagent-child'],
      delays: { 0: 0, 2: 45 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readReplayEnv accepts omitted optional values and defaults collections', () => {
  const root = temporaryDirectory();
  try {
    assert.deepEqual(
      readReplayEnv({
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: path.join(root, 'fixture.json'),
      }),
      {
        fixturePath: path.join(root, 'fixture.json'),
        modulePath: undefined,
        logPath: undefined,
        gatesDir: undefined,
        armedGates: [],
        delays: {},
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readReplayEnv rejects relative paths for every path setting', () => {
  const pathVariables = [
    'CANOPY_LIFECYCLE_REPLAY_FIXTURE',
    'CANOPY_LIFECYCLE_REPLAY_MODULE',
    'CANOPY_LIFECYCLE_REPLAY_LOG',
    'CANOPY_LIFECYCLE_REPLAY_GATES',
  ];
  for (const variable of pathVariables) {
    assert.throws(
      () =>
        readReplayEnv({
          CANOPY_LIFECYCLE_REPLAY_FIXTURE: '/absolute/fixture.json',
          [variable]: 'relative/path',
        }),
      /absolute/i,
      variable,
    );
  }
});

test('readReplayEnv rejects malformed or incorrectly shaped JSON', () => {
  for (const [variable, value] of [
    ['CANOPY_LIFECYCLE_REPLAY_ARMED_GATES', '{'],
    ['CANOPY_LIFECYCLE_REPLAY_ARMED_GATES', '{}'],
    ['CANOPY_LIFECYCLE_REPLAY_ARMED_GATES', '["before-0",7]'],
    ['CANOPY_LIFECYCLE_REPLAY_DELAYS', '{'],
    ['CANOPY_LIFECYCLE_REPLAY_DELAYS', '[]'],
  ]) {
    assert.throws(
      () =>
        readReplayEnv({
          CANOPY_LIFECYCLE_REPLAY_FIXTURE: '/fixture.json',
          [variable]: value,
        }),
      /JSON|array|object|string/i,
      `${variable}=${value}`,
    );
  }
});

test('readReplayEnv requires a gates directory for armed gates', () => {
  assert.throws(
    () =>
      readReplayEnv({
        CANOPY_LIFECYCLE_REPLAY_FIXTURE: '/fixture.json',
        CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: '["before-0"]',
      }),
    /gates.*directory/i,
  );
});

test('readReplayEnv rejects invalid delay indices and non-negative-integer violations', () => {
  for (const value of [
    '{"-1":1}',
    '{"1.5":1}',
    '{"01":1}',
    '{"1":-1}',
    '{"1":1.5}',
    '{"1":"5"}',
  ]) {
    assert.throws(
      () =>
        readReplayEnv({
          CANOPY_LIFECYCLE_REPLAY_FIXTURE: '/fixture.json',
          CANOPY_LIFECYCLE_REPLAY_DELAYS: value,
        }),
      /delay|index|integer/i,
      value,
    );
  }
});

test('loadReplayFixture reports fixture validation errors clearly', () => {
  const root = temporaryDirectory();
  const fixturePath = path.join(root, 'invalid.json');
  try {
    writeFileSync(fixturePath, JSON.stringify({ schemaVersion: 1 }), 'utf8');
    assert.throws(
      () => loadReplayFixture(fixturePath),
      /Invalid lifecycle fixture/,
    );
    writeFileSync(fixturePath, '{', 'utf8');
    assert.throws(
      () => loadReplayFixture(fixturePath),
      /Could not parse lifecycle fixture/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scheduleSteps dependency-orders a recorded subagent group when registration fields exist', () => {
  const fixture = loadReplayFixture(lifecycleFixturePath);
  const group = fixture.steps.find((step) => step.kind === 'group');
  assert.ok(group);

  const groupSteps = scheduleSteps(scheduleFixture([group])).map(
    ({ step }) => step,
  );
  const registration = group.lanes
    .flat()
    .find(
      (step) =>
        step.ids?.agentThread === 'h2' &&
        step.fields?.subagentKind === 'started',
    );
  if (registration) {
    const registrationIndex = groupSteps.indexOf(registration);
    const childIndex = groupSteps.findIndex((step) => step.lane === 'child:h2');
    assert.ok(registrationIndex >= 0);
    assert.ok(childIndex > registrationIndex);
    assert.equal(
      groupSteps[registrationIndex].shape?.includes('subAgentActivity'),
      true,
    );
  } else {
    // This checked-in recording predates agentThread/subagentKind registration metadata.
    assert.equal(group.lanes[0][0].lane, 'child:h2');
    assert.equal(groupSteps[0].lane, 'child:h2');
    assert.deepEqual(
      groupSteps.slice(0, group.lanes[0].length),
      group.lanes[0],
    );
    assert.ok(
      groupSteps.findIndex((step) => step.lane === 'root') >=
        group.lanes[0].length,
    );
  }
});

test('scheduleSteps delays child frames until their registered agentThread starts', () => {
  const childFirst = frame('child:h2', 'child:event');
  const rootBefore = frame('root', 'root:before');
  const rootRegistration = frame('root', 'root:register', {
    shape: ['subAgentActivity'],
    ids: { agentThread: 'h2' },
    fields: { subagentKind: 'started' },
  });
  const rootAfter = frame('root', 'root:after');
  const scheduled = scheduleSteps(
    scheduleFixture([
      {
        kind: 'group',
        lanes: [[childFirst], [rootBefore, rootRegistration, rootAfter]],
      },
    ]),
  );

  assert.deepEqual(
    scheduled.map(({ step }) => step.type),
    ['root:before', 'root:register', 'child:event', 'root:after'],
  );
  assert.deepEqual(
    scheduled.map(({ index }) => index),
    [0, 1, 2, 3],
  );
});

test('scheduleSteps preserves listed lane order when no registration is present', () => {
  const child = frame('child:h2', 'child:event');
  const root = frame('root', 'root:event');
  assert.deepEqual(
    scheduleSteps(
      scheduleFixture([{ kind: 'group', lanes: [[child], [root]] }]),
    ).map(({ step }) => step.type),
    ['child:event', 'root:event'],
  );
});

test('scheduleSteps recursively unblocks a nested group from its enclosing group', () => {
  const child = frame('child:h2', 'child:event');
  const registration = frame('root', 'root:register', {
    ids: { agentThread: 'h2' },
    fields: { subagentKind: 'started' },
  });
  const scheduled = scheduleSteps(
    scheduleFixture([
      {
        kind: 'group',
        lanes: [[{ kind: 'group', lanes: [[child]] }], [registration]],
      },
    ]),
  );
  assert.deepEqual(
    scheduled.map(({ step }) => step.type),
    ['root:register', 'child:event'],
  );
});

test('scheduleSteps rejects a dependency cycle', () => {
  const group = {
    kind: 'group',
    lanes: [
      [
        frame('child:h2', 'child:h2:event'),
        frame('child:h2', 'child:h2:start-h3', {
          ids: { agentThread: 'h3' },
          fields: { subagentKind: 'started' },
        }),
      ],
      [
        frame('child:h3', 'child:h3:event'),
        frame('child:h3', 'child:h3:start-h2', {
          ids: { agentThread: 'h2' },
          fields: { subagentKind: 'started' },
        }),
      ],
    ],
  };
  assert.throws(
    () => scheduleSteps(scheduleFixture([group])),
    /cycle|blocked/i,
  );
});

test('createGates lets unarmed waits pass and blocks armed waits until release', async () => {
  const root = temporaryDirectory();
  try {
    const unarmed = createGates({ dir: root });
    await unarmed.wait('before-0');
    assert.equal(unarmed.isArmed('before-0'), false);

    const armed = createGates({ dir: root, armed: ['release-ready'] });
    let advanced = false;
    const waiting = armed.wait('release-ready').then(() => {
      advanced = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(advanced, false);
    armed.release('release-ready');
    await waiting;
    assert.equal(advanced, true);
    assert.equal(existsSync(path.join(root, 'release-ready')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createGates times out and rejects invalid armed or requested names', async () => {
  const root = temporaryDirectory();
  try {
    assert.throws(
      () => createGates({ dir: root, armed: ['../secret'] }),
      /gate|name/i,
    );
    assert.throws(
      () => createGates({ dir: root, armed: ['before--1'] }),
      /gate|name/i,
    );
    const gates = createGates({
      dir: root,
      armed: ['before-5'],
      timeoutMs: 25,
    });
    await assert.rejects(gates.wait('before-5'), /replay_gate_timeout/);
    await assert.rejects(gates.wait('../secret'), /gate|name/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runReplay honors delays, gate order, adapter calls, and completion logging', async () => {
  const events = [];
  const startedAt = Date.now();
  const log = { write: (record) => events.push(['log', record]) };
  const gates = { wait: async (name) => events.push(['gate', name]) };
  const adapter = {
    emitFrame: async (step, index) => events.push(['frame', step.type, index]),
    handleControl: async (step, index) =>
      events.push(['control', step.action, index]),
  };
  const fixture = scheduleFixture([
    frame('root', 'first'),
    { kind: 'control', action: 'release', barrier: 'child-ready' },
    { kind: 'control', action: 'send' },
    frame('root', 'last'),
  ]);

  await runReplay({ fixture, adapter, log, gates, delays: { 0: 20 } });

  // libuv schedules timers from its cached loop time, so a 20 ms timer can
  // measure a few milliseconds short on a busy runner.
  assert.ok(Date.now() - startedAt >= 15);
  assert.deepEqual(
    events.filter(([kind]) => kind === 'frame' || kind === 'control'),
    [
      ['frame', 'first', 0],
      ['control', 'release', 1],
      ['control', 'send', 2],
      ['frame', 'last', 3],
    ],
  );
  assert.deepEqual(
    events.filter(([kind]) => kind === 'gate').map(([, name]) => name),
    ['before-0', 'before-1', 'release-child-ready', 'before-2', 'before-3'],
  );
  assert.ok(
    events.some(([kind, record]) => kind === 'log' && record.kind === 'delay'),
  );
  assert.ok(
    events.some(([kind, record]) => kind === 'log' && record.kind === 'done'),
  );
});

test('runReplay propagates adapter failures and logs an error without payload text', async () => {
  const root = temporaryDirectory();
  const logPath = path.join(root, 'replay.jsonl');
  const expectedError = new Error('adapter failed: private payload text');
  try {
    await assert.rejects(
      runReplay({
        fixture: scheduleFixture([frame('root', 'failure')]),
        adapter: {
          emitFrame: async () => {
            throw expectedError;
          },
          handleControl: async () => assert.fail('unexpected control'),
        },
        gates: { wait: async () => {} },
        log: createReplayLog(logPath),
      }),
      (error) => error === expectedError,
    );

    const records = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(records.some((record) => record.kind === 'error'));
    assert.equal(
      records.some((record) => record.kind === 'done'),
      false,
    );
    assert.equal(
      readFileSync(logPath, 'utf8').includes('private payload text'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createReplayLog appends JSON lines, filters payload fields, and supports no-op mode', () => {
  const root = temporaryDirectory();
  const logPath = path.join(root, 'replay.jsonl');
  try {
    createReplayLog(undefined).write({ kind: 'frame', type: 'noop' });
    const log = createReplayLog(logPath);
    log.write({
      kind: 'frame',
      index: 3,
      type: 'notification:item/started',
      payload: 'secret',
    });
    log.write({ kind: 'control', index: 4, action: 'send' });
    const content = readFileSync(logPath, 'utf8');
    assert.equal(content.trim().split('\n').length, 2);
    assert.equal(content.includes('secret'), false);
    assert.deepEqual(
      content
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [
        { kind: 'frame', index: 3, type: 'notification:item/started' },
        { kind: 'control', index: 4, action: 'send' },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
