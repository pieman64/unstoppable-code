import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  composeClaudeCronFireWakeFixture,
  composeClaudeTwoAgentStopFixture,
  createClaudeMaterializer,
  REPLAY_TEXT,
} from '../fixtures/lifecycle-replay-claude.mjs';
import {
  loadReplayFixture,
  scheduleSteps,
} from '../fixtures/lifecycle-replay.mjs';

const fakePath = fileURLToPath(
  new URL('../fixtures/fake-claude-pressure-cli.mjs', import.meta.url),
);
const modulePath = fileURLToPath(
  new URL('../fixtures/lifecycle-replay.mjs', import.meta.url),
);
const fixtureDir = fileURLToPath(
  new URL(
    '../../../../../scripts/harness-contract/lifecycle/fixtures/claude/',
    import.meta.url,
  ),
);
const sessionId = 'demo-ts-pnpm-vite/demo-main/claude-pressure-chat';
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function readLog(logPath) {
  return existsSync(logPath)
    ? readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

function composeAgentStopFixture() {
  return composeClaudeTwoAgentStopFixture({
    agentFixture: loadReplayFixture(
      path.join(fixtureDir, 'agent-default-background.json'),
    ),
    interruptFixture: loadReplayFixture(
      path.join(fixtureDir, 'interrupt-with-background-agents.json'),
    ),
    stopTaskFixture: loadReplayFixture(path.join(fixtureDir, 'stop-task.json')),
  });
}

async function until(predicate, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await pause(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function startFake(
  t,
  {
    fixtureName = 'permission-wait',
    fixture,
    transform,
    gate,
    replay = true,
    target = true,
  } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), 'canopy-claude-lifecycle-'));
  const executable = path.join(dir, 'copied-fake.mjs');
  const logPath = path.join(dir, 'replay.jsonl');
  copyFileSync(fakePath, executable);
  let fixturePath = path.join(fixtureDir, `${fixtureName}.json`);
  if (fixture) {
    fixturePath = path.join(dir, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify(fixture));
  }
  if (transform) {
    const fixtureToTransform = loadReplayFixture(fixturePath);
    transform(fixtureToTransform);
    fixturePath = path.join(dir, 'fixture.json');
    writeFileSync(fixturePath, JSON.stringify(fixtureToTransform));
  }
  const gatesDir = path.join(dir, 'gates');
  mkdirSync(gatesDir);
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('CANOPY_LIFECYCLE_REPLAY_')) delete env[name];
  }
  if (replay)
    Object.assign(env, {
      CANOPY_LIFECYCLE_REPLAY_FIXTURE: fixturePath,
      CANOPY_LIFECYCLE_REPLAY_MODULE: modulePath,
      CANOPY_LIFECYCLE_REPLAY_LOG: logPath,
      CANOPY_LIFECYCLE_REPLAY_GATES: gatesDir,
      CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: JSON.stringify(gate ? [gate] : []),
    });
  env.CANOPY_CLAUDE_PRESSURE_COUNT = '2';
  env.CANOPY_CLAUDE_PRESSURE_LOG = path.join(dir, 'pressure.jsonl');
  const child = spawn(process.execPath, [executable], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  let stderr = '';
  let exited = false;
  const exit = once(child, 'exit').then(([code, signal]) => {
    exited = true;
    return { code, signal };
  });
  const output = createInterface({ input: child.stdout });
  output.on('line', (line) => frames.push(JSON.parse(line)));
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  // Errors such as a closed pipe are asserted via the process outcome below.
  child.stdin.on('error', () => {});
  t.after(async () => {
    if (!exited) child.kill();
    await exit;
    output.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    frames,
    send,
    exit,
    log: () => readLog(logPath),
    stderr: () => stderr,
    pressureLog: () => readLog(env.CANOPY_CLAUDE_PRESSURE_LOG),
    async initialize(options = {}) {
      send({
        type: 'control_request',
        request_id: 'initialize-1',
        request: { subtype: 'initialize', options },
      });
      await until(
        () =>
          frames.find((frame) => frame.response?.request_id === 'initialize-1'),
        `initialize ACK (${stderr})`,
      );
      assert.equal(
        frames.some(
          (frame) => frame.type === 'system' && frame.subtype === 'init',
        ),
        false,
      );
    },
    user(uuid = randomUUID()) {
      send({
        type: 'user',
        uuid,
        session_id: target ? sessionId : 'other-session',
        message: { role: 'user', content: 'Report Claude pressure status.' },
      });
      return uuid;
    },
    async permission() {
      return until(
        () =>
          frames.find(
            (frame) =>
              frame.type === 'control_request' &&
              frame.request?.subtype === 'can_use_tool',
          ),
        `permission request (${stderr})`,
      );
    },
    answer(request, behavior = 'allow', requestId = request.request_id) {
      send({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response:
            behavior === 'allow'
              ? { behavior, updatedInput: request.request.input }
              : { behavior, message: 'Synthetic denial' },
        },
      });
    },
    release() {
      writeFileSync(path.join(gatesDir, gate), '');
    },
    inputOpen() {
      return child.stdin.writable && !child.stdin.destroyed;
    },
    hasExited() {
      return exited;
    },
    async finish(expectedCode = 0) {
      child.stdin.end();
      const result = await exit;
      assert.equal(result.code, expectedCode, stderr);
    },
  };
}

test('all recorded Claude fixture frames materialize from their content-free skeletons', () => {
  const files = readdirSync(fixtureDir).filter((file) =>
    file.endsWith('.json'),
  );
  assert.ok(files.length >= 11);
  const templates = new Set();
  for (const file of files) {
    const fixture = loadReplayFixture(path.join(fixtureDir, file));
    const materializer = createClaudeMaterializer({ sessionId, fixture });
    const liveBindings = new Map();
    for (const { step, index } of scheduleSteps(fixture)) {
      if (step.kind === 'control') {
        if (step.action === 'send' || step.action === 'steer') {
          const uuid = randomUUID();
          liveBindings.set(step.ids.message, uuid);
          materializer.bindMessage(step.ids.message, uuid);
        }
        continue;
      }
      templates.add(step.template);
      const envelope = materializer.materialize(step, index);
      assert.equal(envelope.session_id, sessionId, `${file}:${index}`);
      assert.ok(envelope.type, `${file}:${index}`);
      if (step.consumed?.length) {
        const expected = step.consumed.map((alias) => liveBindings.get(alias));
        assert.ok(
          expected.every(Boolean),
          `${file}:${index} consumes live input`,
        );
        assert.deepEqual(
          envelope.user_message_uuids,
          expected,
          `${file}:${index}`,
        );
        assert.equal(
          envelope.user_message_uuid,
          expected.at(-1),
          `${file}:${index}`,
        );
      }
      assert.doesNotThrow(() => JSON.stringify(envelope), `${file}:${index}`);
    }
  }
  assert.ok(templates.has('claude.assistant.tool_use'));
  assert.ok(templates.has('claude.stream-event'));
  assert.ok(templates.has('claude.result'));
});

test('recorded native-agent frames materialize real Agent calls without inventing capabilities', () => {
  const fixture = loadReplayFixture(
    path.join(fixtureDir, 'agent-default-background.json'),
  );
  const materializer = createClaudeMaterializer({ sessionId, fixture });
  const envelopes = scheduleSteps(fixture)
    .filter(({ step }) => step.kind === 'frame')
    .map(({ step }, index) => materializer.materialize(step, index));
  const init = envelopes.find(
    (frame) => frame.type === 'system' && frame.subtype === 'init',
  );
  const streamTool = envelopes.find(
    (frame) => frame.event?.content_block?.type === 'tool_use',
  );
  const agentTool = envelopes
    .filter((frame) => frame.type === 'assistant')
    .flatMap((frame) => frame.message.content)
    .find((block) => block.type === 'tool_use');

  assert.equal(agentTool?.name, 'Agent');
  assert.match(agentTool.input.description, /^Claude lifecycle replay agent /);
  assert.equal(streamTool.event.content_block.name, 'Agent');
  assert.equal(init.capabilities, undefined);
});

test(
  'composed two-agent replay holds the sibling and records the exact stop_task target',
  { timeout: 15_000 },
  async (t) => {
    const fixture = composeAgentStopFixture();
    const fake = startFake(t, {
      fixture,
      gate: 'release-sibling-finish',
    });
    const initializeOptions = { harnessMarker: 'synthetic-node-test' };
    await fake.initialize(initializeOptions);
    fake.user();

    await until(
      () =>
        fake.pressureLog().filter((entry) => entry.type === 'task_started')
          .length === 2,
      'both native agents started',
    );
    const startedTasks = fake
      .pressureLog()
      .filter((entry) => entry.type === 'task_started');
    assert.deepEqual(
      startedTasks.map((entry) => entry.taskAlias),
      ['k1', 'k2'],
    );
    assert.notEqual(startedTasks[0].taskId, startedTasks[1].taskId);

    fake.send({
      type: 'control_request',
      request_id: 'foreground-interrupt',
      request: { subtype: 'interrupt' },
    });
    await until(
      () =>
        fake.frames.some(
          (frame) =>
            frame.type === 'result' &&
            frame.subtype === 'error_during_execution',
        ),
      'foreground cancellation result',
    );

    const initializeEntry = fake
      .pressureLog()
      .find((entry) => entry.type === 'initialize');
    assert.deepEqual(initializeEntry.options, initializeOptions);
    // The fake CLI, not the recording, advertises the pinned CLI's interrupt
    // receipt so production Stop can take its native interrupt path.
    assert.deepEqual(
      fake.frames.find(
        (frame) => frame.type === 'system' && frame.subtype === 'init',
      ).capabilities,
      ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
    );
    assert.deepEqual(
      fake.frames.find(
        (frame) =>
          frame.type === 'control_response' &&
          frame.response?.request_id === 'foreground-interrupt',
      )?.response.response,
      { still_queued: [], cancelled: [] },
    );

    fake.send({
      type: 'control_request',
      request_id: 'stop-agent-two',
      request: { subtype: 'stop_task', task_id: startedTasks[1].taskId },
    });
    await until(
      () =>
        fake
          .pressureLog()
          .some(
            (entry) =>
              entry.type === 'control_request' && entry.subtype === 'stop_task',
          ),
      'logged native-agent stop target',
    );
    assert.deepEqual(
      fake
        .pressureLog()
        .filter(
          (entry) =>
            entry.type === 'control_request' && entry.subtype === 'stop_task',
        ),
      [
        {
          type: 'control_request',
          subtype: 'stop_task',
          requestId: 'stop-agent-two',
          taskId: startedTasks[1].taskId,
        },
      ],
    );
    await until(
      () =>
        fake.frames.some(
          (frame) =>
            frame.type === 'system' &&
            frame.subtype === 'task_notification' &&
            frame.task_id === startedTasks[1].taskId &&
            frame.status === 'stopped',
        ),
      'targeted agent stopped',
    );
    assert.deepEqual(
      fake.pressureLog().filter((entry) => entry.type === 'task_notification'),
      [
        {
          type: 'task_notification',
          taskAlias: 'k2',
          taskId: startedTasks[1].taskId,
          status: 'stopped',
        },
      ],
    );
    await until(
      () =>
        fake
          .log()
          .some(
            (entry) =>
              entry.kind === 'gate' && entry.name === 'release-sibling-finish',
          ),
      'sibling completion gate',
    );
    assert.equal(
      fake.frames.some(
        (frame) =>
          frame.type === 'system' &&
          frame.subtype === 'task_notification' &&
          frame.task_id === startedTasks[0].taskId,
      ),
      false,
    );
    assert.equal(fake.inputOpen(), true);
    assert.equal(fake.hasExited(), false);

    fake.release();
    await until(
      () => fake.log().some((entry) => entry.kind === 'done'),
      'released sibling completion',
    );
    assert.ok(
      fake.frames.some(
        (frame) =>
          frame.type === 'system' &&
          frame.subtype === 'task_notification' &&
          frame.task_id === startedTasks[0].taskId &&
          frame.status === 'completed',
      ),
    );
    assert.deepEqual(
      fake.pressureLog().filter((entry) => entry.type === 'task_notification'),
      [
        {
          type: 'task_notification',
          taskAlias: 'k2',
          taskId: startedTasks[1].taskId,
          status: 'stopped',
        },
        {
          type: 'task_notification',
          taskAlias: 'k1',
          taskId: startedTasks[0].taskId,
          status: 'completed',
        },
      ],
    );
    await fake.finish();
  },
);

test('unknown Claude envelope types, templates and shapes fail closed', () => {
  const materializer = createClaudeMaterializer({ sessionId });
  const frame = {
    kind: 'frame',
    lane: 'root',
    type: 'sdk:assistant',
    shape: ['text'],
    template: 'claude.assistant.text',
  };
  for (const extra of [
    { type: 'sdk:unknown' },
    { template: 'claude.unknown' },
    { shape: ['unknown'] },
  ]) {
    assert.throws(
      () => materializer.materialize({ ...frame, ...extra }, 0),
      /unsupported|unknown|invalid/i,
    );
  }
});

test('grouped stream tool aliases follow shared scheduled frame indexes', () => {
  const lane = (message, toolUse) => [
    {
      kind: 'frame',
      lane: 'root',
      type: 'sdk:stream_event',
      shape: ['message_start'],
      ids: { message },
      template: 'claude.stream-event',
    },
    {
      kind: 'frame',
      lane: 'root',
      type: 'sdk:stream_event',
      shape: ['content_block_start', 'tool_use'],
      ids: { message },
      template: 'claude.stream-event',
    },
    {
      kind: 'frame',
      lane: 'root',
      type: 'sdk:assistant',
      shape: ['tool_use'],
      ids: { message, toolUse },
      template: 'claude.assistant.tool_use',
    },
  ];
  const fixture = {
    provider: 'claude',
    steps: [{ kind: 'group', lanes: [lane('m1', 'u1'), lane('m2', 'u2')] }],
  };
  const materializer = createClaudeMaterializer({ sessionId, fixture });
  const streams = new Map();
  for (const { step, index } of scheduleSteps(fixture)) {
    const envelope = materializer.materialize(step, index);
    if (envelope.event?.content_block?.type === 'tool_use')
      streams.set(step.ids.message, envelope.event.content_block.id);
    if (envelope.type === 'assistant')
      assert.equal(
        envelope.message.content[0].id,
        streams.get(step.ids.message),
      );
  }
  assert.equal(new Set(streams.values()).size, 2);
});

test("a receipt no send names is the CLI's own command, one uuid across its states", () => {
  const fixture = composeClaudeCronFireWakeFixture({
    wakeFixture: loadReplayFixture(
      path.join(fixtureDir, 'background-bash-wake.json'),
    ),
  });
  const materializer = createClaudeMaterializer({ sessionId, fixture });
  const receipts = scheduleSteps(fixture)
    .filter(({ step }) => step.type === 'sdk:command_lifecycle')
    .map(({ step, index }) => materializer.materialize(step, index));
  assert.deepEqual(
    receipts.map((receipt) => receipt.state),
    ['started', 'completed'],
  );
  assert.match(receipts[0].command_uuid, /^[0-9a-f-]{36}$/);
  assert.equal(receipts[1].command_uuid, receipts[0].command_uuid);
});

test('message receipts must bind to actual SDK input UUIDs, not generated aliases', () => {
  const fixture = loadReplayFixture(path.join(fixtureDir, 'compaction.json'));
  const materializer = createClaudeMaterializer({ sessionId, fixture });
  const receipt = scheduleSteps(fixture).find(
    ({ step }) => step.type === 'sdk:command_lifecycle',
  );
  assert.throws(
    () => materializer.materialize(receipt.step, receipt.index),
    /bind|input|uuid/i,
  );
  const uuid = randomUUID();
  materializer.bindMessage(receipt.step.ids.message, uuid);
  assert.equal(
    materializer.materialize(receipt.step, receipt.index).command_uuid,
    uuid,
  );
});

test(
  'copied CLI replays permission-wait over stdio and holds until the correlated Allow response',
  { timeout: 15_000 },
  async (t) => {
    const fake = startFake(t);
    await fake.initialize();
    fake.user();
    const request = await fake.permission();
    assert.equal(request.request.tool_name, 'Bash');
    assert.deepEqual(request.request.input, {
      command: 'printf canopy-lifecycle-replay',
    });
    const tool = fake.frames
      .flatMap((frame) =>
        frame.type === 'assistant' ? frame.message.content : [],
      )
      .find((block) => block.type === 'tool_use');
    assert.equal(request.request.tool_use_id, tool.id);
    assert.deepEqual(request.request.input, tool.input);
    const streamTool = fake.frames.find(
      (frame) => frame.event?.content_block?.type === 'tool_use',
    );
    assert.equal(streamTool.event.content_block.id, tool.id);
    fake.answer(request, 'allow', 'unrelated-request');
    for (const subtype of ['set_permission_mode', 'interrupt', 'stop_task']) {
      fake.send({
        type: 'control_request',
        request_id: `control-${subtype}`,
        request: { subtype, mode: 'default', task_id: 'synthetic-task' },
      });
      await until(
        () =>
          fake.frames.some(
            (frame) => frame.response?.request_id === `control-${subtype}`,
          ),
        `${subtype} ACK while permission waits`,
      );
    }
    await pause(60);
    assert.equal(
      fake.frames.some((frame) => frame.type === 'result'),
      false,
    );
    assert.equal(
      fake.log().some((entry) => entry.kind === 'done'),
      false,
    );
    assert.equal(
      fake.log().filter((entry) => entry.kind === 'permission_response').length,
      0,
    );
    fake.answer(request);
    await until(
      () => fake.log().some((entry) => entry.kind === 'done'),
      `replay done (${fake.stderr()})`,
    );
    assert.equal(
      fake.frames.filter(
        (frame) => frame.type === 'system' && frame.subtype === 'init',
      ).length,
      1,
    );
    assert.ok(
      fake.frames.some(
        (frame) => frame.type === 'result' && frame.result === REPLAY_TEXT,
      ),
    );
    assert.ok(
      fake.frames
        .filter((frame) => frame.session_id)
        .every((frame) => frame.session_id === sessionId),
    );
    assert.deepEqual(
      fake.log().filter((entry) => entry.kind === 'permission_response'),
      [
        {
          kind: 'permission_response',
          requestId: request.request_id,
          behavior: 'allow',
        },
      ],
    );
    await fake.finish();
  },
);

test(
  'stdin remains responsive while a filesystem gate holds a replay frame',
  { timeout: 15_000 },
  async (t) => {
    const fake = startFake(t, { gate: 'before-0' });
    await fake.initialize();
    fake.user();
    await until(
      () =>
        fake.log().some((entry) => entry.kind === 'gate' && entry.index === 0),
      'armed first-frame gate',
    );
    fake.send({
      type: 'control_request',
      request_id: 'gated-mode',
      request: { subtype: 'set_permission_mode', mode: 'default' },
    });
    await until(
      () =>
        fake.frames.some(
          (frame) => frame.response?.request_id === 'gated-mode',
        ),
      'control ACK at gate',
    );
    assert.equal(
      fake.frames.some((frame) => frame.type === 'system'),
      false,
    );
    fake.release();
    fake.answer(await fake.permission());
    await until(
      () => fake.log().some((entry) => entry.kind === 'done'),
      'released replay done',
    );
    await fake.finish();
  },
);

test(
  'recorded permission-deny waits for and asserts a Deny decision',
  { timeout: 15_000 },
  async (t) => {
    const fake = startFake(t, {
      transform(fixture) {
        fixture.steps.find(
          (step) => step.action === 'permission-allow',
        ).action = 'permission-deny';
      },
    });
    await fake.initialize();
    fake.user();
    fake.answer(await fake.permission(), 'deny');
    await until(
      () => fake.log().some((entry) => entry.kind === 'done'),
      'denied replay done',
    );
    assert.ok(
      fake
        .log()
        .some(
          (entry) =>
            entry.kind === 'permission_response' && entry.behavior === 'deny',
        ),
    );
    await fake.finish();
  },
);

test(
  'a permission decision that contradicts the fixture fails closed before terminal frames',
  { timeout: 15_000 },
  async (t) => {
    const fake = startFake(t);
    await fake.initialize();
    fake.user();
    fake.answer(await fake.permission(), 'deny');
    await until(
      () => fake.log().some((entry) => entry.kind === 'error'),
      'permission mismatch error',
    );
    assert.equal(
      fake.frames.some((frame) => frame.type === 'result'),
      false,
    );
    await fake.finish(1);
    assert.match(fake.stderr(), /permission decision mismatch/i);
  },
);

for (const action of ['send', 'steer'])
  test(
    `${action} controls rebind command lifecycle receipts to the next SDK user UUID`,
    { timeout: 15_000 },
    async (t) => {
      const fake = startFake(t, {
        fixtureName: 'compaction',
        transform(fixture) {
          fixture.steps.find((step) => step.action === 'send').action = action;
        },
      });
      await fake.initialize();
      fake.user();
      await until(
        () =>
          fake
            .log()
            .some(
              (entry) => entry.kind === 'control' && entry.action === action,
            ),
        `${action} control`,
      );
      const uuid = fake.user();
      await until(
        () => fake.log().some((entry) => entry.kind === 'done'),
        `compaction done (${fake.stderr()})`,
      );
      const receipts = fake.frames.filter(
        (frame) => frame.type === 'command_lifecycle',
      );
      assert.ok(receipts.length > 0);
      assert.ok(receipts.every((frame) => frame.command_uuid === uuid));
      await fake.finish();
    },
  );

test(
  'send controls fail closed when the SDK user input has no actual UUID',
  { timeout: 15_000 },
  async (t) => {
    const fake = startFake(t, { fixtureName: 'compaction' });
    await fake.initialize();
    fake.user();
    await until(
      () =>
        fake
          .log()
          .some((entry) => entry.kind === 'control' && entry.action === 'send'),
      'send awaiting real input',
    );
    fake.send({
      type: 'user',
      session_id: sessionId,
      message: { role: 'user', content: 'Synthetic follow-up' },
    });
    await until(
      () => fake.log().some((entry) => entry.kind === 'error'),
      'missing input UUID error',
    );
    assert.equal(
      fake.frames.some((frame) => frame.type === 'command_lifecycle'),
      false,
    );
    await fake.finish(1);
    assert.match(fake.stderr(), /actual SDK user UUID/);
  },
);

test(
  'single-file pressure mode and auxiliary reply remain independent of replay modules',
  { timeout: 15_000 },
  async (t) => {
    const fake = startFake(t, { replay: false });
    await fake.initialize();
    fake.user();
    await until(
      () => fake.frames.some((frame) => frame.type === 'result'),
      'pressure terminal',
    );
    const assistants = fake.frames.filter(
      (frame) => frame.type === 'assistant',
    );
    assert.equal(assistants.length, 2);
    for (let index = 0; index < assistants.length; index += 1)
      assert.equal(
        assistants[index].message.content[0].text,
        `CANOPY-CLAUDE-PRESSURE-${String(index).padStart(3, '0')} ${'x'.repeat(2048)}`,
      );
    assert.deepEqual(
      fake.pressureLog().filter((entry) => entry.type === 'sent'),
      [
        { type: 'sent', index: 0, marker: 'CANOPY-CLAUDE-PRESSURE-000' },
        { type: 'sent', index: 1, marker: 'CANOPY-CLAUDE-PRESSURE-001' },
      ],
    );
    assert.deepEqual(fake.pressureLog().at(-1), { type: 'terminal' });
    await fake.finish();
    const auxiliary = startFake(t, { target: false });
    await auxiliary.initialize();
    auxiliary.user();
    await until(
      () => auxiliary.frames.some((frame) => frame.type === 'result'),
      'auxiliary terminal',
    );
    assert.equal(
      auxiliary.frames.find((frame) => frame.type === 'result').result,
      'Pressure helper ready',
    );
    assert.deepEqual(auxiliary.log(), []);
    await auxiliary.finish();
  },
);
