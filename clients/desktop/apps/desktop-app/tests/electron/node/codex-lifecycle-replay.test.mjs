import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createCodexReplay,
  dryRunCodexFixture,
  materializeCodexFrame,
  resolveCodexReplayTemplate,
} from '../fixtures/lifecycle-replay-codex.mjs';
import {
  loadReplayFixture,
  scheduleSteps,
} from '../fixtures/lifecycle-replay.mjs';

const fakePath = fileURLToPath(
  new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url),
);
const replayModulePath = fileURLToPath(
  new URL('../fixtures/lifecycle-replay.mjs', import.meta.url),
);
const fixtureDir = fileURLToPath(
  new URL(
    '../../../../../scripts/harness-contract/lifecycle/fixtures/codex/',
    import.meta.url,
  ),
);
const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function until(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await pause(10);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function startFake(
  t,
  {
    scenario = 'approval',
    armedGates = [],
    scenarioOptions,
    mode = 'replay',
  } = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), 'canopy-codex-lifecycle-'));
  const home = path.join(directory, 'home');
  const gatesDir = path.join(directory, 'gates');
  mkdirSync(home);
  mkdirSync(gatesDir);
  const replayLogPath = path.join(directory, 'replay.jsonl');
  const protocolLogPath = path.join(directory, 'protocol.jsonl');
  const statePath = path.join(directory, 'state.json');
  const env = {
    HOME: home,
    TMPDIR: directory,
    PATH: process.env.PATH ?? '',
    CANOPY_E2E_CODEX_MODE: mode,
    CANOPY_E2E_CODEX_STATE_PATH: statePath,
    CANOPY_E2E_CODEX_LOG_PATH: protocolLogPath,
    CANOPY_LIFECYCLE_REPLAY_FIXTURE: path.join(fixtureDir, `${scenario}.json`),
    // The fake imports the sibling adapter; this core module path only opts in
    // to its replay bootstrap and is intentionally not a credential location.
    CANOPY_LIFECYCLE_REPLAY_MODULE: replayModulePath,
    CANOPY_LIFECYCLE_REPLAY_LOG: replayLogPath,
    CANOPY_LIFECYCLE_REPLAY_GATES: gatesDir,
    CANOPY_LIFECYCLE_REPLAY_ARMED_GATES: JSON.stringify(armedGates),
    ...(scenarioOptions === undefined
      ? {}
      : {
          CANOPY_LIFECYCLE_REPLAY_SCENARIO_OPTIONS:
            JSON.stringify(scenarioOptions),
        }),
  };
  const child = spawn(process.execPath, [fakePath], {
    cwd: directory,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames = [];
  let stderr = '';
  let streamError;
  let exitResult;
  const output = createInterface({ input: child.stdout });
  output.on('line', (line) => {
    try {
      frames.push(JSON.parse(line));
    } catch (error) {
      streamError = error;
    }
  });
  child.stderr.setEncoding('utf8').on('data', (data) => {
    stderr += data;
  });
  child.stdin.on('error', () => {});
  const exit = once(child, 'exit').then(([code, signal]) => {
    exitResult = { code, signal };
    return exitResult;
  });

  const app = {
    child,
    directory,
    gatesDir,
    frames,
    replayLog: () => readLog(replayLogPath),
    protocolLog: () => readLog(protocolLogPath),
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      child.stdin.end();
      return exit;
    },
    assertHealthy() {
      assert.equal(
        streamError,
        undefined,
        `invalid fake stdio JSON: ${stderr}`,
      );
      assert.equal(
        app
          .protocolLog()
          .some((entry) => entry.direction === 'lifecycle-replay-error'),
        false,
        `Codex lifecycle replay failed: ${stderr}`,
      );
    },
    stderr: () => stderr,
  };

  assert.equal(
    Object.hasOwn(env, 'CANOPY_E2E_CODEX_CANONICAL_HOME'),
    false,
    'the stdio test must not configure a canonical Codex home',
  );
  t.after(async () => {
    if (!exitResult) child.kill('SIGTERM');
    await exit;
    output.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return app;
}

async function bootstrapConversation(app) {
  const initializeId = 'bootstrap-initialize-string-id';
  app.send({ id: initializeId, method: 'initialize', params: {} });
  const initialized = await until(
    () => app.frames.find((frame) => frame.id === initializeId && frame.result),
    'the initialize response',
  );
  assert.equal(typeof initialized.id, 'string');

  const threadStartId = 81;
  app.send({
    id: threadStartId,
    method: 'thread/start',
    params: { cwd: app.directory },
  });
  const started = await until(
    () =>
      app.frames.find((frame) => frame.id === threadStartId && frame.result),
    'the thread/start response',
  );
  const threadId = started.result?.thread?.id;
  assert.equal(typeof threadId, 'string');
  return { threadId, threadStartId };
}

async function startTurn(app, threadId, requestId) {
  app.send({
    id: requestId,
    method: 'turn/start',
    params: {
      threadId,
      input: [{ type: 'text', text: 'Run the synthetic lifecycle command.' }],
    },
  });
  const response = await until(
    () =>
      app.frames.find((frame) => frame.id === requestId && frame.result?.turn),
    `turn/start response for ${String(requestId)}`,
  );
  return response;
}

async function requestResult(app, id, method, params = {}) {
  app.send({ id, method, params });
  return until(
    () =>
      app.frames.find(
        (frame) =>
          frame.id === id &&
          (Object.hasOwn(frame, 'result') || Object.hasOwn(frame, 'error')),
      ),
    `${method} response for ${String(id)}`,
  );
}

function assertNoJsonRpcVersion(frames) {
  for (const frame of frames) {
    assert.equal(
      Object.hasOwn(frame, 'jsonrpc'),
      false,
      `Codex app-server stdio uses envelopes without jsonrpc: ${JSON.stringify(frame)}`,
    );
  }
}

async function approveRecordedCommand(
  app,
  { allowUnrelatedResponses = false } = {},
) {
  const approval = await until(
    () =>
      app.frames.find(
        (frame) => frame.method === 'item/commandExecution/requestApproval',
      ),
    'the recorded command approval request',
  );
  assert.ok(approval.params.itemId);
  assert.equal(typeof approval.params.command, 'string');
  assert.ok(approval.params.command.length > 0);
  assert.equal(path.isAbsolute(approval.params.cwd), true);
  assert.equal(statSync(approval.params.cwd).isDirectory(), true);

  if (allowUnrelatedResponses) {
    const wrongTypeId =
      typeof approval.id === 'number' ? String(approval.id) : 700_001;
    const unrelatedId =
      typeof approval.id === 'number'
        ? approval.id + 1
        : `${approval.id}-unrelated`;
    const wrongTypeResponse = {
      id: wrongTypeId,
      result: { decision: 'accept' },
    };
    const unrelatedResponse = {
      id: unrelatedId,
      result: { decision: 'accept' },
    };
    const unknownErrorResponse = {
      id: 'unknown-error-response',
      error: { code: -32000, message: 'Synthetic unrelated response' },
    };
    app.send(wrongTypeResponse);
    app.send(unrelatedResponse);
    app.send(unknownErrorResponse);
    await pause(60);
    assert.deepEqual(
      app
        .protocolLog()
        .filter(
          (entry) =>
            entry.direction === 'client-response' &&
            [wrongTypeId, unrelatedId, unknownErrorResponse.id].includes(
              entry.message?.id,
            ),
        )
        .map((entry) => entry.message),
      [wrongTypeResponse, unrelatedResponse, unknownErrorResponse],
      'the protocol log records stale/unknown results and errors before dispatch',
    );
    assert.equal(
      app.frames.some((frame) => frame.method === 'serverRequest/resolved'),
      false,
      'a string/number lookalike or unrelated id must not resolve the approval',
    );
    assert.equal(
      app.replayLog().some((record) => record.kind === 'approval-response'),
      false,
      'an unrelated response must not advance the recorded approval control',
    );
    assert.equal(
      app.frames.some((frame) => frame.method === 'turn/completed'),
      false,
      'the replay remains blocked until the exact approval response arrives',
    );
  }

  const approvalResponse = {
    id: approval.id,
    result: { decision: 'accept' },
  };
  app.send(approvalResponse);
  const resolved = await until(
    () =>
      app.frames.find(
        (frame) =>
          frame.method === 'serverRequest/resolved' &&
          frame.params?.requestId === approval.id,
      ),
    'serverRequest/resolved with the exact approval id',
  );
  assert.equal(resolved.params.requestId, approval.id);
  assert.equal(typeof resolved.params.requestId, typeof approval.id);
  const approvalResponses = app
    .replayLog()
    .filter((record) => record.kind === 'approval-response');
  assert.deepEqual(approvalResponses, [
    { kind: 'approval-response', type: 'accept', name: String(approval.id) },
  ]);
  assert.deepEqual(
    app
      .protocolLog()
      .filter(
        (entry) =>
          entry.direction === 'client-response' &&
          entry.message?.id === approval.id,
      )
      .map((entry) => entry.message),
    [approvalResponse],
    'the exact approval response is recorded before replay dispatch',
  );
  return approval;
}

test('dry-runs every Codex recording with finite synthetic item and child-thread shapes', () => {
  const fixtureNames = readdirSync(fixtureDir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.ok(fixtureNames.length > 0);

  const allSubagentActivities = [];
  let commandInProgress = 0;
  let commandCompleted = 0;
  let outputDeltas = 0;
  for (const name of fixtureNames) {
    const fixture = loadReplayFixture(path.join(fixtureDir, name));
    const replayed = dryRunCodexFixture(fixture);
    const scheduledFrameCount = scheduleSteps(fixture).filter(
      ({ step }) => step.kind === 'frame',
    ).length;
    assert.equal(replayed.length, scheduledFrameCount, name);

    for (const entry of replayed) {
      const { frame, value } = entry;
      assert.ok(['notification', 'request', 'response'].includes(value.kind));
      assert.equal(Object.hasOwn(value, 'jsonrpc'), false);
      assert.doesNotThrow(() => resolveCodexReplayTemplate(frame), name);
      if (frame.shape?.[0] === 'subAgentActivity') {
        allSubagentActivities.push({ name, frame, item: value.params.item });
        assert.equal(
          value.params.item.kind,
          frame.fields?.subagentKind ??
            (frame.type.endsWith('item/completed') ? 'completed' : 'started'),
        );
        assert.ok(value.params.item.agentThreadId);
        assert.notEqual(
          value.params.item.agentThreadId,
          'codex-dry-run-root-thread',
        );
        assert.equal(path.isAbsolute(value.params.item.agentPath), true);
        assert.equal(Object.hasOwn(value.params.item, 'subagentKind'), false);
      }
      if (value.params?.item?.type === 'commandExecution') {
        const item = value.params.item;
        assert.equal(item.command.length > 0, true);
        assert.equal(path.isAbsolute(item.cwd), true);
        assert.equal(statSync(item.cwd).isDirectory(), true);
        assert.deepEqual(item.commandActions, []);
        assert.equal(item.processId, null);
        if (item.status === 'inProgress') {
          commandInProgress += 1;
          assert.equal(item.aggregatedOutput, null);
          assert.equal(item.exitCode, null);
          assert.equal(item.durationMs, null);
        } else {
          commandCompleted += 1;
          assert.equal(typeof item.aggregatedOutput, 'string');
          assert.equal(item.aggregatedOutput.length > 0, true);
          assert.equal(item.exitCode, 0);
          assert.equal(item.durationMs, 0);
        }
      }
      if (frame.type === 'notification:item/commandExecution/outputDelta') {
        outputDeltas += 1;
        assert.ok(value.params.itemId);
        assert.equal(typeof value.params.delta, 'string');
        assert.ok(value.params.delta.length > 0);
      }
    }
  }

  assert.equal(commandInProgress > 0, true);
  assert.equal(commandCompleted > 0, true);
  assert.equal(outputDeltas > 0, true);
  // Each recording spawns one child; the D10 recordings add their own.
  const agentThreadsByFixture = new Map();
  for (const { name, frame, item } of allSubagentActivities) {
    if (frame.ids?.agentThread === undefined) continue;
    agentThreadsByFixture.set(name, [
      ...(agentThreadsByFixture.get(name) ?? []),
      item.agentThreadId,
    ]);
  }
  for (const [name, agentThreads] of agentThreadsByFixture) {
    assert.equal(new Set(agentThreads).size, 1, name);
  }
  assert.equal(
    agentThreadsByFixture.get('subagent-after-root-turn.json')?.length,
    4,
  );

  const olderRecording = structuredClone(
    loadReplayFixture(path.join(fixtureDir, 'subagent-after-root-turn.json')),
  );
  const stripRegistration = (steps) => {
    for (const step of steps) {
      if (step.kind === 'group') {
        step.lanes.forEach(stripRegistration);
      } else if (step.shape?.[0] === 'subAgentActivity') {
        delete step.ids.agentThread;
        delete step.fields.subagentKind;
      }
    }
  };
  stripRegistration(olderRecording.steps);
  const legacyActivities = dryRunCodexFixture(olderRecording)
    .filter(({ frame }) => frame.shape?.[0] === 'subAgentActivity')
    .map(({ frame, value }) => ({ frame, item: value.params.item }));
  assert.equal(legacyActivities.length, 4);
  const legacyChildByItem = new Map();
  for (const { frame, item } of legacyActivities) {
    assert.notEqual(item.agentThreadId, 'codex-dry-run-root-thread');
    assert.equal(
      item.kind,
      frame.type.endsWith('item/completed') ? 'completed' : 'started',
    );
    const previous = legacyChildByItem.get(frame.ids.item);
    if (previous !== undefined) assert.equal(item.agentThreadId, previous);
    else legacyChildByItem.set(frame.ids.item, item.agentThreadId);
  }
  assert.equal(legacyChildByItem.size, 2);

  const childStarted = materializeCodexFrame(
    {
      kind: 'frame',
      lane: 'root',
      type: 'notification:thread/started',
      ids: { thread: 'child' },
      template: 'codex.notification',
    },
    {
      ids: { thread: 'live-child-thread' },
      context: {
        rootThreadId: 'live-root-thread',
        threadResult: { thread: { id: 'live-root-thread', source: 'vscode' } },
      },
    },
  );
  assert.equal(childStarted.params.thread.id, 'live-child-thread');
  assert.equal(childStarted.params.thread.parentThreadId, 'live-root-thread');
  assert.equal(typeof childStarted.params.thread.source, 'object');
  assert.notEqual(childStarted.params.thread.source, 'vscode');

  assert.throws(
    () =>
      resolveCodexReplayTemplate({
        kind: 'frame',
        lane: 'root',
        type: 'notification:item/completed',
        shape: ['commandExecution', 'stillWorking'],
        template: 'codex.item.commandExecution.stillWorking',
      }),
    /status/i,
  );
});

test('materialization fails closed on unknown kinds, shapes, templates and wrong directions', () => {
  const frame = {
    kind: 'frame',
    lane: 'root',
    type: 'notification:item/started',
    shape: ['agentMessage'],
    template: 'codex.notification',
  };
  for (const invalid of [
    { ...frame, type: 'notification:unknown/event' },
    { ...frame, shape: ['unknownItem'] },
    { ...frame, shape: ['commandExecution', 'unknownStatus'] },
    { ...frame, template: 'codex.unknown' },
    { ...frame, type: 'notification:turn/start', shape: undefined },
    { ...frame, type: 'response:item/started', template: 'codex.response' },
  ]) {
    assert.throws(() => materializeCodexFrame(invalid), /Unsupported|requires/);
  }
});

test('fake Codex stdio waits for the exact typed approval response and stays live after terminal', async (t) => {
  const app = startFake(t);
  const { threadId } = await bootstrapConversation(app);
  const turnRequestId = 'conversation-turn-string-id';
  const turnResponse = await startTurn(app, threadId, turnRequestId);
  const startedTurn = await until(
    () => app.frames.find((frame) => frame.method === 'turn/started'),
    'the live turn/started notification',
  );
  assert.equal(turnResponse.id, turnRequestId);
  assert.equal(typeof turnResponse.id, 'string');
  assert.equal(turnResponse.result.turn.id, startedTurn.params.turn.id);

  const approval = await approveRecordedCommand(app, {
    allowUnrelatedResponses: true,
  });
  const approvalResponse = {
    id: approval.id,
    result: { decision: 'accept' },
  };
  const completedTurn = await until(
    () => app.frames.find((frame) => frame.method === 'turn/completed'),
    'the approval fixture terminal turn notification',
  );
  assert.equal(completedTurn.params.turn.status, 'completed');
  assert.equal(
    app.frames.filter(
      (frame) => frame.method === 'item/commandExecution/requestApproval',
    ).length,
    1,
  );
  const commandCompleted = app.frames.find(
    (frame) =>
      frame.method === 'item/completed' &&
      frame.params?.item?.id === approval.params.itemId &&
      frame.params?.item?.type === 'commandExecution',
  );
  assert.equal(commandCompleted?.params.item.status, 'completed');
  assert.equal(typeof commandCompleted?.params.item.aggregatedOutput, 'string');
  assert.equal(commandCompleted?.params.item.exitCode, 0);
  await until(
    () => app.replayLog().some((record) => record.kind === 'done'),
    'the replay terminal marker',
  );
  assert.deepEqual(
    app.frames.filter((frame) => frame.id === approval.id),
    [approval],
    'the approval response frame consumes the client decision and emits nothing',
  );
  assertNoJsonRpcVersion(app.frames);
  app.assertHealthy();
  assert.equal(
    app.child.exitCode,
    null,
    'terminal replay must not end the stdio process',
  );

  const staleApprovalResponse = {
    id: approval.id,
    error: { code: -32001, message: 'Synthetic stale response' },
  };
  app.send(staleApprovalResponse);
  await until(
    () =>
      app
        .protocolLog()
        .some(
          (entry) =>
            entry.direction === 'client-response' &&
            entry.message?.id === approval.id &&
            entry.message?.error?.message ===
              staleApprovalResponse.error.message,
        ),
    'the late stale approval error response to be logged',
  );
  assert.deepEqual(
    app
      .protocolLog()
      .filter(
        (entry) =>
          entry.direction === 'client-response' &&
          entry.message?.id === approval.id,
      )
      .map((entry) => entry.message),
    [approvalResponse, staleApprovalResponse],
  );

  const readId = 'post-terminal-read';
  app.send({ id: readId, method: 'thread/read', params: { threadId } });
  const readAfterTerminal = await until(
    () => app.frames.find((frame) => frame.id === readId && frame.result),
    'a normal request after the replay terminal marker',
  );
  assert.equal(readAfterTerminal.result.thread.id, threadId);
  assert.equal(app.child.exitCode, null);
  assert.deepEqual(await app.close(), { code: 0, signal: null });
});

test('fake Codex stdio holds built-in request_user_input until its exact reply and records the answer', async (t) => {
  const app = startFake(t, { scenarioOptions: { requestUserInput: true } });
  const { threadId } = await bootstrapConversation(app);
  await startTurn(app, threadId, 'request-user-input-turn');
  await approveRecordedCommand(app);

  const question = await until(
    () =>
      app.frames.find((frame) => frame.method === 'item/tool/requestUserInput'),
    'the built-in request_user_input server request',
  );
  assert.equal(question.params.threadId, threadId);
  assert.equal(question.params.itemId, 'codex-lifecycle-item-4');
  assert.deepEqual(question.params.questions, [
    {
      id: 'lifecycle-choice',
      header: 'Choice',
      question: 'Choose an option for the synthetic task.',
      isOther: false,
      isSecret: false,
      options: [
        { label: 'Continue', description: 'Continue the recorded task' },
        { label: 'Pause', description: 'Pause the recorded task' },
      ],
    },
  ]);
  assert.equal(question.params.isBlocking, true);
  assert.equal(question.params.autoResolutionMs, null);
  assert.equal(
    app.frames.some((frame) => frame.method === 'turn/completed'),
    false,
    'the replay must hold completion while the built-in question is unanswered',
  );
  assert.equal(
    app
      .protocolLog()
      .some(
        (entry) =>
          entry.direction === 'client-response' &&
          entry.message?.id === question.id,
      ),
    false,
    'the fake must not record a reply before the user answers',
  );
  assert.equal(
    app
      .replayLog()
      .some((record) => record.kind === 'request-user-input-response'),
    false,
  );

  app.send({
    id: question.id,
    result: { answers: { 'lifecycle-choice': { answers: ['Continue'] } } },
  });
  const resolved = await until(
    () =>
      app.frames.find(
        (frame) =>
          frame.method === 'serverRequest/resolved' &&
          frame.params?.requestId === question.id,
      ),
    'serverRequest/resolved for the exact built-in question request',
  );
  assert.deepEqual(resolved.params, {
    threadId,
    requestId: question.id,
  });
  const reply = await until(
    () =>
      app
        .protocolLog()
        .find(
          (entry) =>
            entry.direction === 'client-response' &&
            entry.message?.id === question.id,
        ),
    'the recorded request_user_input answer',
  );
  assert.deepEqual(reply.message.result, {
    answers: { 'lifecycle-choice': { answers: ['Continue'] } },
  });
  assert.deepEqual(
    app
      .replayLog()
      .filter((record) => record.kind === 'request-user-input-response'),
    [
      {
        kind: 'request-user-input-response',
        type: 'answered',
        name: String(question.id),
      },
    ],
  );
  await until(
    () => app.frames.find((frame) => frame.method === 'turn/completed'),
    'the turn to finish after the built-in question answer',
  );
  assert.deepEqual(
    app.frames.filter((frame) => frame.id === question.id),
    [question],
    'the fake consumes the client reply without sending a JSON-RPC reply',
  );
  await until(
    () => app.replayLog().some((record) => record.kind === 'done'),
    'the request_user_input replay terminal marker',
  );
  assertNoJsonRpcVersion(app.frames);
  app.assertHealthy();
  assert.deepEqual(await app.close(), { code: 0, signal: null });
});

test('fake Codex stdio lets the provider resolve a held approval without a client response', async (t) => {
  const app = startFake(t, {
    armedGates: ['release-provider-resolution'],
    scenarioOptions: { providerResolvesRequest: true },
  });
  const { threadId } = await bootstrapConversation(app);
  await startTurn(app, threadId, 'provider-resolved-approval-turn');

  const approval = await until(
    () =>
      app.frames.find(
        (frame) => frame.method === 'item/commandExecution/requestApproval',
      ),
    'the provider-resolved command approval request',
  );
  assert.equal(approval.params.threadId, threadId);
  await until(
    () =>
      app
        .replayLog()
        .find(
          (record) =>
            record.kind === 'gate' &&
            record.name === 'release-provider-resolution',
        ),
    'the provider-resolution gate to hold the approval',
  );
  assert.equal(
    app
      .replayLog()
      .some(
        (record) =>
          record.kind === 'gate' &&
          record.name === 'release-provider-resolution',
      ),
    true,
    'the request stays held at the provider-resolution gate',
  );
  assert.equal(
    app.frames.some((frame) => frame.method === 'turn/completed'),
    false,
  );
  assert.equal(
    app
      .protocolLog()
      .some(
        (entry) =>
          entry.direction === 'client-response' &&
          entry.message?.id === approval.id,
      ),
    false,
  );
  assert.deepEqual(
    app.frames.filter((frame) => frame.id === approval.id),
    [approval],
  );

  writeFileSync(
    path.join(app.gatesDir, 'release-provider-resolution'),
    '',
    'utf8',
  );
  const resolved = await until(
    () =>
      app.frames.find(
        (frame) =>
          frame.method === 'serverRequest/resolved' &&
          frame.params?.requestId === approval.id,
      ),
    'provider serverRequest/resolved for the exact approval request',
  );
  assert.deepEqual(resolved.params, {
    threadId,
    requestId: approval.id,
  });
  await until(
    () => app.frames.find((frame) => frame.method === 'turn/completed'),
    'the turn to finish after provider resolution',
  );
  assert.equal(
    app
      .protocolLog()
      .some(
        (entry) =>
          entry.direction === 'client-response' &&
          entry.message?.id === approval.id,
      ),
    false,
  );
  assert.deepEqual(
    app.frames.filter((frame) => frame.id === approval.id),
    [approval],
    'provider resolution sends no JSON-RPC reply',
  );
  await until(
    () => app.replayLog().some((record) => record.kind === 'done'),
    'the provider-resolved approval replay terminal marker',
  );
  app.assertHealthy();
  assert.deepEqual(await app.close(), { code: 0, signal: null });
});

test('fake Codex stdio lets the provider resolve a held built-in question without an answer', async (t) => {
  const app = startFake(t, {
    armedGates: ['release-provider-resolution'],
    scenarioOptions: {
      requestUserInput: true,
      providerResolvesRequest: true,
    },
  });
  const { threadId } = await bootstrapConversation(app);
  await startTurn(app, threadId, 'provider-resolved-question-turn');
  await approveRecordedCommand(app);

  const question = await until(
    () =>
      app.frames.find((frame) => frame.method === 'item/tool/requestUserInput'),
    'the provider-resolved built-in question request',
  );
  assert.equal(question.params.threadId, threadId);
  await until(
    () =>
      app
        .replayLog()
        .find(
          (record) =>
            record.kind === 'gate' &&
            record.name === 'release-provider-resolution',
        ),
    'the provider-resolution gate to hold the question',
  );
  assert.equal(
    app
      .replayLog()
      .some(
        (record) =>
          record.kind === 'gate' &&
          record.name === 'release-provider-resolution',
      ),
    true,
  );
  assert.equal(
    app.frames.some((frame) => frame.method === 'turn/completed'),
    false,
    'the turn remains active while the provider-resolution gate is held',
  );
  assert.equal(
    app
      .protocolLog()
      .some(
        (entry) =>
          entry.direction === 'client-response' &&
          entry.message?.id === question.id,
      ),
    false,
  );
  assert.equal(
    app
      .replayLog()
      .some((record) => record.kind === 'request-user-input-response'),
    false,
  );

  writeFileSync(
    path.join(app.gatesDir, 'release-provider-resolution'),
    '',
    'utf8',
  );
  const resolved = await until(
    () =>
      app.frames.find(
        (frame) =>
          frame.method === 'serverRequest/resolved' &&
          frame.params?.requestId === question.id,
      ),
    'provider serverRequest/resolved for the exact question request',
  );
  assert.deepEqual(resolved.params, {
    threadId,
    requestId: question.id,
  });
  await until(
    () => app.frames.find((frame) => frame.method === 'turn/completed'),
    'the turn to finish after provider resolution',
  );
  assert.equal(
    app
      .protocolLog()
      .some(
        (entry) =>
          entry.direction === 'client-response' &&
          entry.message?.id === question.id,
      ),
    false,
  );
  assert.deepEqual(
    app.frames.filter((frame) => frame.id === question.id),
    [question],
    'provider resolution sends no JSON-RPC reply',
  );
  assert.equal(
    app
      .replayLog()
      .some((record) => record.kind === 'request-user-input-response'),
    false,
  );
  await until(
    () => app.replayLog().some((record) => record.kind === 'done'),
    'the provider-resolved question replay terminal marker',
  );
  app.assertHealthy();
  assert.deepEqual(await app.close(), { code: 0, signal: null });
});

test('fake Codex stdio replays a fatal error before one failed terminal and stays live', async (t) => {
  const app = startFake(t, { scenario: 'fatal-error' });
  const { threadId } = await bootstrapConversation(app);
  const turnRequestId = 'fatal-error-turn-start';
  const turnResponse = await startTurn(app, threadId, turnRequestId);
  const startedTurn = await until(
    () => app.frames.find((frame) => frame.method === 'turn/started'),
    'the fatal-error turn/started notification',
  );
  const turnId = startedTurn.params.turn.id;
  assert.equal(turnResponse.id, turnRequestId);
  assert.equal(turnResponse.result.turn.id, turnId);

  const fatalError = await until(
    () => app.frames.find((frame) => frame.method === 'error'),
    'the recorded fatal Codex error notification',
  );
  assert.equal(fatalError.params.threadId, threadId);
  assert.equal(fatalError.params.turnId, turnId);
  assert.equal(fatalError.params.willRetry, false);
  assert.equal(
    fatalError.params.error.message,
    'Synthetic lifecycle error',
    'the fake stdio frame should carry an explanatory error detail',
  );

  const failedTurn = await until(
    () =>
      app.frames.find(
        (frame) =>
          frame.method === 'turn/completed' &&
          frame.params?.threadId === threadId &&
          frame.params?.turn?.id === turnId,
      ),
    'the fatal-error turn/completed notification',
  );
  assert.equal(failedTurn.params.turn.status, 'failed');
  assert.ok(
    app.frames.indexOf(fatalError) < app.frames.indexOf(failedTurn),
    'the non-retrying error must precede the matching terminal notification',
  );
  await until(
    () => app.replayLog().some((record) => record.kind === 'done'),
    'the fatal-error replay terminal marker',
  );
  assert.equal(
    app.frames.filter(
      (frame) =>
        frame.method === 'error' &&
        frame.params?.threadId === threadId &&
        frame.params?.turnId === turnId,
    ).length,
    1,
    'the fatal turn should emit exactly one matching error notification',
  );
  assert.equal(
    app.frames.filter(
      (frame) =>
        frame.method === 'turn/completed' &&
        frame.params?.threadId === threadId &&
        frame.params?.turn?.id === turnId,
    ).length,
    1,
    'the fatal turn should emit exactly one matching terminal notification',
  );
  const approvalMethods = new Set([
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
  ]);
  assert.equal(
    app.frames.some((frame) => approvalMethods.has(frame.method)),
    false,
    'a fatal Codex error must not request approval',
  );
  assert.equal(
    app.replayLog().some((record) => record.kind === 'approval-response'),
    false,
  );
  assertNoJsonRpcVersion(app.frames);
  app.assertHealthy();
  assert.equal(
    app.child.exitCode,
    null,
    'a failed terminal replay must not end the stdio process',
  );

  const readId = 'post-fatal-error-read';
  app.send({ id: readId, method: 'thread/read', params: { threadId } });
  const readAfterTerminal = await until(
    () => app.frames.find((frame) => frame.id === readId && frame.result),
    'a normal request after the fatal-error replay',
  );
  assert.equal(readAfterTerminal.result.thread.id, threadId);
  assert.equal(app.child.exitCode, null);
  assert.deepEqual(await app.close(), { code: 0, signal: null });
});

test('background Codex command remains gated after root completion until the gate releases', async (t) => {
  const app = startFake(t, {
    scenario: 'background-terminal',
    armedGates: ['release-helper-finished'],
  });
  const { threadId } = await bootstrapConversation(app);
  const turnRequestId = 123;
  const turnResponse = await startTurn(app, threadId, turnRequestId);
  assert.equal(turnResponse.id, turnRequestId);
  const approval = await approveRecordedCommand(app);

  await until(
    () => app.frames.find((frame) => frame.method === 'turn/completed'),
    'the root turn to finish before the helper gate',
  );
  await until(
    () =>
      app
        .replayLog()
        .some(
          (record) =>
            record.kind === 'gate' && record.name === 'release-helper-finished',
        ),
    'the helper completion gate',
  );
  await pause(60);
  assert.equal(
    app.frames.some(
      (frame) =>
        frame.method === 'item/completed' &&
        frame.params?.item?.id === approval.params.itemId &&
        frame.params?.item?.type === 'commandExecution',
    ),
    false,
    'the background command completion must remain behind its gate',
  );
  assert.equal(
    app.replayLog().some((record) => record.kind === 'done'),
    false,
  );
  assert.equal(app.child.exitCode, null);

  writeFileSync(path.join(app.gatesDir, 'release-helper-finished'), 'release');
  const commandCompleted = await until(
    () =>
      app.frames.find(
        (frame) =>
          frame.method === 'item/completed' &&
          frame.params?.item?.id === approval.params.itemId &&
          frame.params?.item?.type === 'commandExecution',
      ),
    'the helper command completion after gate release',
  );
  assert.equal(commandCompleted.params.item.status, 'completed');
  assert.equal(typeof commandCompleted.params.item.aggregatedOutput, 'string');
  assert.equal(commandCompleted.params.item.exitCode, 0);
  await until(
    () => app.replayLog().some((record) => record.kind === 'done'),
    'background replay terminal marker',
  );
  assertNoJsonRpcVersion(app.frames);
  app.assertHealthy();

  const readId = 'post-gate-terminal-read';
  app.send({ id: readId, method: 'thread/read', params: { threadId } });
  const readAfterTerminal = await until(
    () => app.frames.find((frame) => frame.id === readId && frame.result),
    'a normal request after background terminal replay',
  );
  assert.equal(readAfterTerminal.result.thread.id, threadId);
  assert.deepEqual(await app.close(), { code: 0, signal: null });
});

test('a start that joins the active turn returns the existing live turn id', async (t) => {
  const app = startFake(t, { scenario: 'start-while-active' });
  const { threadId } = await bootstrapConversation(app);

  const firstId = 'first-turn-start';
  const first = await startTurn(app, threadId, firstId);
  const firstTurnId = first.result.turn.id;
  const secondId = 202;
  const second = await startTurn(app, threadId, secondId);
  assert.equal(second.id, secondId);
  assert.equal(typeof second.id, 'number');
  // The recorded second response carries the active turn's alias (a join).
  assert.equal(second.result.turn.id, firstTurnId);
  const secondTurnItem = await until(
    () =>
      app.frames.find(
        (frame) =>
          frame.method === 'item/started' &&
          frame.params.turnId === firstTurnId,
      ),
    'a post-start lifecycle item on the joined turn',
  );
  assert.equal(secondTurnItem.params.turnId, firstTurnId);
  await until(
    () => app.replayLog().some((record) => record.kind === 'done'),
    'the consecutive-turn replay terminal marker',
  );
  assertNoJsonRpcVersion(app.frames);
  app.assertHealthy();
  await app.close();
});

test('deny requires decline, approve rejects decline, and unanswered controls time out', async (t) => {
  for (const scenario of [
    { action: 'deny', decision: 'decline' },
    { action: 'approve', decision: 'decline', error: /exact accept/ },
    { action: 'approve', error: /Timed out/ },
  ]) {
    await t.test(
      `${scenario.action}: ${scenario.decision ?? 'timeout'}`,
      async () => {
        const directory = mkdtempSync(
          path.join(tmpdir(), 'canopy-codex-decision-'),
        );
        const fixture = loadReplayFixture(
          path.join(fixtureDir, 'approval.json'),
        );
        fixture.steps.find(
          (step) => step.kind === 'control' && step.action === 'approve',
        ).action = scenario.action;
        const fixturePath = path.join(directory, 'fixture.json');
        writeFileSync(fixturePath, JSON.stringify(fixture));
        const frames = [];
        const controller = createCodexReplay({
          env: { CANOPY_LIFECYCLE_REPLAY_FIXTURE: fixturePath },
          timeoutMs: 150,
          send: (frame) => frames.push(frame),
        });
        try {
          controller.recordBootstrap(
            { id: 11, method: 'initialize' },
            { id: 11, result: {} },
          );
          controller.recordBootstrap(
            { id: 'thread-request', method: 'thread/start' },
            { id: 'thread-request', result: { thread: { id: 'live-root' } } },
          );
          controller.handleRequest(
            { id: 'turn-request', method: 'turn/start' },
            { threadId: 'live-root', turnId: 'live-turn', cwd: directory },
          );
          const request = await until(
            () =>
              frames.find(
                (frame) =>
                  frame.method === 'item/commandExecution/requestApproval',
              ),
            'the decision test approval',
          );
          if (scenario.decision)
            controller.handleResponse({
              id: request.id,
              result: { decision: scenario.decision },
            });
          if (scenario.error) {
            // Keep a referenced timer alive while the controller's own deadline
            // is unref'ed, so a timeout is tested rather than process teardown.
            await Promise.all([
              assert.rejects(controller.waitForCompletion(), scenario.error),
              pause(180),
            ]);
            assert.equal(
              frames.some((frame) => frame.method === 'serverRequest/resolved'),
              false,
            );
            assert.equal(
              frames.some((frame) => frame.method === 'turn/completed'),
              false,
            );
          } else {
            await controller.waitForCompletion();
            assert.equal(
              frames.filter(
                (frame) =>
                  frame.method === 'serverRequest/resolved' &&
                  frame.params.requestId === request.id,
              ).length,
              1,
            );
          }
        } finally {
          controller.close();
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );
  }
});

test('Codex replay lists a live background terminal by its owning thread until completion', async (t) => {
  const processId = 'lifecycle-replay-process-42';
  const app = startFake(t, {
    scenario: 'background-terminal',
    armedGates: ['release-helper-finished'],
    scenarioOptions: { syntheticProcessId: processId },
  });
  const { threadId } = await bootstrapConversation(app);
  const turnResponse = await startTurn(app, threadId, 'live-terminal-turn');
  const approval = await approveRecordedCommand(app);
  const commandStarted = app.frames.find(
    (frame) =>
      frame.method === 'item/started' &&
      frame.params?.item?.id === approval.params.itemId &&
      frame.params?.item?.type === 'commandExecution',
  );
  assert.equal(commandStarted.params.item.processId, processId);

  await until(
    () => app.frames.find((frame) => frame.method === 'turn/completed'),
    'the root turn to finish before the helper gate',
  );
  await until(
    () =>
      app
        .replayLog()
        .some(
          (record) =>
            record.kind === 'gate' && record.name === 'release-helper-finished',
        ),
    'the helper completion gate',
  );

  const listed = await requestResult(
    app,
    'background-terminals-live',
    'thread/backgroundTerminals/list',
    { threadId },
  );
  assert.deepEqual(listed.result, {
    data: [
      {
        itemId: approval.params.itemId,
        processId,
        command: approval.params.command,
        cwd: approval.params.cwd,
        osPid: null,
        cpuPercent: null,
        rssKb: null,
      },
    ],
    nextCursor: null,
  });
  const isolated = await requestResult(
    app,
    'background-terminals-other-thread',
    'thread/backgroundTerminals/list',
    { threadId: 'unrelated-thread' },
  );
  assert.deepEqual(isolated.result, { data: [], nextCursor: null });

  const threads = await requestResult(app, 'thread-list-root', 'thread/list');
  assert.equal(
    threads.result.data.some((thread) => thread.id === threadId),
    true,
  );
  assert.equal(threads.result.nextCursor, null);
  assert.equal(threads.result.backwardsCursor, null);

  writeFileSync(path.join(app.gatesDir, 'release-helper-finished'), 'release');
  await until(
    () =>
      app.frames.find(
        (frame) =>
          frame.method === 'item/completed' &&
          frame.params?.item?.id === approval.params.itemId &&
          frame.params?.item?.type === 'commandExecution',
      ),
    'the helper command completion after gate release',
  );
  const drained = await requestResult(
    app,
    'background-terminals-drained',
    'thread/backgroundTerminals/list',
    { threadId },
  );
  assert.deepEqual(drained.result, { data: [], nextCursor: null });
  const startedTurn = app.frames.find(
    (frame) =>
      frame.method === 'turn/started' && frame.params?.threadId === threadId,
  );
  assert.equal(turnResponse.result.turn.id, startedTurn.params.turn.id);
  app.assertHealthy();
});

test('Codex replay list page and failure overrides preserve cursor and thread scope', async (t) => {
  const app = startFake(t, {
    scenario: 'approval',
    scenarioOptions: {
      threadId: 'e2e-thread-1',
      listPages: [
        { cursor: null, data: [{ id: 'listed-first' }], nextCursor: 'page-2' },
        { cursor: 'page-2', data: [{ id: 'listed-second' }], nextCursor: null },
      ],
    },
  });
  const { threadId } = await bootstrapConversation(app);
  assert.equal(threadId, 'e2e-thread-1');

  const firstPage = await requestResult(app, 'list-page-one', 'thread/list');
  assert.deepEqual(firstPage.result, {
    data: [{ id: 'listed-first' }],
    nextCursor: 'page-2',
    backwardsCursor: null,
  });
  const secondPage = await requestResult(app, 'list-page-two', 'thread/list', {
    cursor: 'page-2',
  });
  assert.deepEqual(secondPage.result, {
    data: [{ id: 'listed-second' }],
    nextCursor: null,
    backwardsCursor: null,
  });
  const wrongScope = await requestResult(
    app,
    'list-wrong-scope',
    'thread/backgroundTerminals/list',
    { threadId: 'unrelated-thread' },
  );
  assert.deepEqual(wrongScope.result, { data: [], nextCursor: null });
  app.assertHealthy();

  const failureApp = startFake(t, {
    scenario: 'approval',
    scenarioOptions: {
      listFailure: { code: -32041, message: 'Synthetic thread list failure' },
    },
  });
  await bootstrapConversation(failureApp);
  const failed = await requestResult(failureApp, 'list-failure', 'thread/list');
  assert.deepEqual(failed.error, {
    code: -32041,
    message: 'Synthetic thread list failure',
  });
  failureApp.assertHealthy();
});

test('fake Codex stdio lists conversation threads and thread-scoped background terminals outside replay mode', async (t) => {
  const app = startFake(t, { mode: 'normal' });
  const { threadId } = await bootstrapConversation(app);

  const threads = await requestResult(app, 'normal-thread-list', 'thread/list');
  assert.equal(
    threads.result.data.some((thread) => thread.id === threadId),
    true,
  );
  assert.equal(threads.result.nextCursor, null);
  assert.equal(threads.result.backwardsCursor, null);

  const terminals = await requestResult(
    app,
    'normal-terminal-list',
    'thread/backgroundTerminals/list',
    { threadId },
  );
  assert.deepEqual(terminals.result, { data: [], nextCursor: null });
  const unrelated = await requestResult(
    app,
    'normal-terminal-list-unrelated',
    'thread/backgroundTerminals/list',
    { threadId: 'unrelated-thread' },
  );
  assert.deepEqual(unrelated.result, { data: [], nextCursor: null });
  app.assertHealthy();
});

test('fake Codex stdio applies configured list page and failure overrides outside replay mode', async (t) => {
  const app = startFake(t, {
    mode: 'normal',
    scenarioOptions: {
      threadId: 'e2e-thread-1',
      listPages: [
        { cursor: null, data: [{ id: 'direct-first' }], nextCursor: 'page-2' },
        { cursor: 'page-2', data: [{ id: 'direct-second' }], nextCursor: null },
      ],
    },
  });
  const { threadId } = await bootstrapConversation(app);
  assert.equal(threadId, 'e2e-thread-1');
  const first = await requestResult(app, 'direct-page-one', 'thread/list');
  assert.deepEqual(first.result, {
    data: [{ id: 'direct-first' }],
    nextCursor: 'page-2',
    backwardsCursor: null,
  });
  const second = await requestResult(app, 'direct-page-two', 'thread/list', {
    cursor: 'page-2',
  });
  assert.deepEqual(second.result, {
    data: [{ id: 'direct-second' }],
    nextCursor: null,
    backwardsCursor: null,
  });
  const outsideScope = await requestResult(
    app,
    'direct-list-outside-scope',
    'thread/list',
    { parentThreadId: 'unrelated-thread' },
  );
  assert.deepEqual(outsideScope.result, {
    data: [],
    nextCursor: null,
    backwardsCursor: null,
  });
  app.assertHealthy();

  const failureApp = startFake(t, {
    mode: 'normal',
    scenarioOptions: {
      listFailure: { code: -32042, message: 'Direct fake list failure' },
    },
  });
  await bootstrapConversation(failureApp);
  const failed = await requestResult(
    failureApp,
    'direct-list-failure',
    'thread/list',
  );
  assert.deepEqual(failed.error, {
    code: -32042,
    message: 'Direct fake list failure',
  });
  failureApp.assertHealthy();
});
