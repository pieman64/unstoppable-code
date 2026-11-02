#!/usr/bin/env node
// Deterministic Claude stream-json CLI for provider pressure and child-quota
// UI automation. The process waits for the SDK initialize and first user
// message before replying. stdout.write/drain preserves source backpressure.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = 'CANOPY-CLAUDE-PRESSURE-';
const COUNT = Number(process.env.CANOPY_CLAUDE_PRESSURE_COUNT) || 128;
const BODY = 'x'.repeat(2 * 1024);
const TARGET_SESSION = 'demo-ts-pnpm-vite/demo-main/claude-pressure-chat';
const logPath = process.env.CANOPY_CLAUDE_PRESSURE_LOG;
// The pinned CLI advertises these on init and answers interrupts with a
// receipt; content-free recordings capture neither. msg_lifecycle_v1 is left
// out because the fixtures do not record the receipts it implies for sends.
const REPLAY_INTERRUPT_CAPABILITIES = [
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
];
let initialized = false;
let started = false;

function log(entry) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

async function write(message) {
  if (!process.stdout.write(`${JSON.stringify(message)}\n`)) {
    await once(process.stdout, 'drain');
  }
}

async function burst() {
  await write({
    type: 'system',
    subtype: 'init',
    session_id: 'claude-pressure-session',
  });
  for (let index = 0; index < COUNT; index += 1) {
    const marker = `${MARKER}${String(index).padStart(3, '0')}`;
    await write({
      type: 'assistant',
      uuid: `claude-pressure-uuid-${index}`,
      session_id: 'claude-pressure-session',
      parent_tool_use_id: null,
      message: {
        id: `claude-pressure-message-${index}`,
        role: 'assistant',
        content: [{ type: 'text', text: `${marker} ${BODY}` }],
      },
    });
    log({ type: 'sent', index, marker });
  }
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Claude pressure complete',
    session_id: 'claude-pressure-session',
  });
  log({ type: 'terminal' });
  process.stdout.end();
}

async function quotaChildReply() {
  await write({
    type: 'system',
    subtype: 'init',
    session_id: 'quota-child-session',
  });
  await write({
    type: 'assistant',
    error: 'rate_limit',
    uuid: 'quota-child-notice',
    session_id: 'quota-child-session',
    parent_tool_use_id: 'child-task',
    message: {
      id: 'quota-child-message',
      role: 'assistant',
      content: [{ type: 'text', text: 'HTTP 429: usage limit reached' }],
    },
  });
  await write({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    parent_tool_use_id: 'child-task',
    session_id: 'quota-child-session',
    errors: ['HTTP 429: usage limit reached'],
  });
  await write({
    type: 'assistant',
    uuid: 'quota-root-reply',
    parent_tool_use_id: null,
    session_id: 'quota-child-session',
    message: {
      id: 'quota-root-message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'Root work completed despite child quota' },
      ],
    },
  });
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 'quota-child-session',
    result: 'Root work completed despite child quota',
  });
  log({ type: 'quota-child-terminal' });
  process.stdout.end();
}

async function auxiliaryReply() {
  await write({
    type: 'assistant',
    uuid: `claude-pressure-aux-${process.pid}`,
    session_id: `claude-pressure-aux-session-${process.pid}`,
    parent_tool_use_id: null,
    message: {
      id: `claude-pressure-aux-message-${process.pid}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'Pressure helper ready' }],
    },
  });
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Pressure helper ready',
    session_id: `claude-pressure-aux-session-${process.pid}`,
  });
  process.stdout.end();
}

// Only replay opts into external modules. The pressure fixture remains a
// single-file executable when copied into an isolated Electron user-data dir.
async function createLifecycleReplay() {
  const modulePath = process.env.CANOPY_LIFECYCLE_REPLAY_MODULE;
  if (!modulePath || !path.isAbsolute(modulePath)) {
    throw new TypeError(
      'CANOPY_LIFECYCLE_REPLAY_MODULE must be an absolute path',
    );
  }
  const core = await import(pathToFileURL(modulePath).href);
  const { createClaudeMaterializer } = await import(
    pathToFileURL(
      path.join(path.dirname(modulePath), 'lifecycle-replay-claude.mjs'),
    ).href
  );
  const env = core.readReplayEnv();
  const fixture = core.loadReplayFixture(env.fixturePath);
  if (fixture.provider !== 'claude')
    throw new Error('Expected a Claude lifecycle fixture');
  const replayLog = core.createReplayLog(env.logPath);
  const gates = core.createGates({ dir: env.gatesDir, armed: env.armedGates });
  const messages = [];
  const waiters = new Set();
  const taskIdsByAlias = new Map();
  let closed = false;

  function receive(message) {
    for (const waiter of waiters) {
      if (waiter.matches(message)) {
        waiter.resolve(message);
        return;
      }
    }
    messages.push(message);
  }

  function waitFor(matches) {
    const index = messages.findIndex(matches);
    if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0]);
    if (closed)
      return Promise.reject(
        new Error('Replay input closed while waiting for SDK control'),
      );
    return new Promise((resolve, reject) => {
      const waiter = {
        matches,
        resolve(message) {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(message);
        },
        reject(error) {
          clearTimeout(timer);
          waiters.delete(waiter);
          reject(error);
        },
      };
      const timer = setTimeout(
        () =>
          waiter.reject(new Error('Replay timed out waiting for SDK control')),
        90_000,
      );
      waiters.add(waiter);
    });
  }

  // The shared log deliberately whitelists core step metadata. These additional
  // transport records contain only synthetic correlation IDs and finite decisions.
  function transportLog(record) {
    if (env.logPath) appendFileSync(env.logPath, `${JSON.stringify(record)}\n`);
  }

  return {
    receive,
    close() {
      closed = true;
      for (const waiter of waiters)
        waiter.reject(
          new Error('Replay input closed while waiting for SDK control'),
        );
    },
    async start(user) {
      if (typeof user.session_id !== 'string' || !user.session_id) {
        throw new Error('Replay requires a live SDK session ID');
      }
      const materializer = createClaudeMaterializer({
        sessionId: user.session_id,
        fixture,
      });
      let pendingTool;
      await core.runReplay({
        fixture,
        log: replayLog,
        gates,
        delays: env.delays,
        adapter: {
          async emitFrame(step, index) {
            const envelope = materializer.materialize(step, index);
            if (envelope.type === 'system' && envelope.subtype === 'init')
              envelope.capabilities = REPLAY_INTERRUPT_CAPABILITIES;
            if (
              envelope.type === 'system' &&
              envelope.subtype === 'task_started' &&
              step.ids?.task
            ) {
              taskIdsByAlias.set(step.ids.task, envelope.task_id);
              log({
                type: 'task_started',
                taskAlias: step.ids.task,
                taskId: envelope.task_id,
                toolUseAlias: step.ids.toolUse ?? null,
              });
            }
            if (
              envelope.type === 'system' &&
              envelope.subtype === 'task_notification' &&
              step.ids?.task
            ) {
              log({
                type: 'task_notification',
                taskAlias: step.ids.task,
                taskId: envelope.task_id,
                status: envelope.status,
              });
            }
            if (envelope.type === 'assistant') {
              for (const block of envelope.message.content) {
                if (block.type === 'tool_use') pendingTool = block;
              }
            }
            await write(envelope);
          },
          async handleControl(step, index) {
            if (step.action === 'release') return;
            if (step.action === 'send' || step.action === 'steer') {
              const input = await waitFor((message) => message.type === 'user');
              if (
                !step.ids?.message ||
                typeof input.uuid !== 'string' ||
                !input.uuid
              ) {
                throw new Error(
                  'Replay send/steer requires a message alias and actual SDK user UUID',
                );
              }
              materializer.bindMessage(step.ids.message, input.uuid);
              return;
            }
            if (step.action === 'interrupt' || step.action === 'stop-task') {
              const subtype =
                step.action === 'stop-task' ? 'stop_task' : 'interrupt';
              const request = await waitFor(
                (message) =>
                  message.type === 'control_request' &&
                  message.request?.subtype === subtype,
              );
              if (step.action === 'stop-task' && step.ids?.task) {
                const expectedTaskId = taskIdsByAlias.get(step.ids.task);
                if (!expectedTaskId) {
                  throw new Error(
                    `Replay stop-task has no started task for alias ${step.ids.task}`,
                  );
                }
                if (request.request?.task_id !== expectedTaskId) {
                  throw new Error(
                    `Replay stop-task target mismatch: expected ${expectedTaskId}, received ${String(request.request?.task_id)}`,
                  );
                }
              }
              return;
            }
            if (
              step.action !== 'permission-allow' &&
              step.action !== 'permission-deny'
            ) {
              throw new Error(
                `Unsupported Claude replay control: ${step.action}`,
              );
            }
            if (!pendingTool)
              throw new Error(
                'Replay permission control has no pending tool use',
              );
            const requestId = `claude-lifecycle-permission-${process.pid}-${index}`;
            transportLog({
              kind: 'permission_request',
              requestId,
              toolUseId: pendingTool.id,
            });
            await write({
              type: 'control_request',
              request_id: requestId,
              request: {
                subtype: 'can_use_tool',
                tool_name: pendingTool.name,
                input: pendingTool.input,
                tool_use_id: pendingTool.id,
              },
            });
            const reply = await waitFor(
              (message) =>
                message.type === 'control_response' &&
                message.response?.request_id === requestId,
            );
            const expected =
              step.action === 'permission-allow' ? 'allow' : 'deny';
            const behavior = reply.response.response?.behavior;
            if (reply.response.subtype !== 'success' || behavior !== expected) {
              throw new Error(
                `Replay permission decision mismatch: expected ${expected}`,
              );
            }
            transportLog({ kind: 'permission_response', requestId, behavior });
            pendingTool = undefined;
          },
        },
      });
      process.stdout.end();
    },
  };
}

const replay =
  process.env.CANOPY_LIFECYCLE_REPLAY_FIXTURE === undefined
    ? undefined
    : await createLifecycleReplay();

// A chat turn streams its prompt under the chat's session key
// (`<projectId>/<worktreeId>/<chatId>`). Helper queries for the same chat,
// such as branch naming, send their own prompt under an empty session id,
// and that prompt can quote the user's text (`<task_description>...`).
// A scenario therefore runs only for the chat turn it was written for, and
// every other invocation gets the plain helper reply.
const SCENARIOS = [
  {
    id: 'pressure',
    session: TARGET_SESSION,
    prompt: 'Report Claude pressure status.',
    run: (message) => (replay ? replay.start(message) : burst()),
  },
  {
    id: 'quota-child',
    session: 'demo-ts-pnpm-vite/demo-main/quota-chat',
    prompt: 'Complete root despite child quota.',
    run: quotaChildReply,
  },
];

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    log({ type: 'invalid_input', error: String(error) });
    return;
  }
  if (replay && started) replay.receive(message);
  if (message.type === 'control_request') {
    const request = message.request ?? {};
    if (request.subtype === 'initialize') {
      initialized = true;
      log({ type: 'initialize', options: request.options ?? null });
    } else if (
      request.subtype === 'interrupt' ||
      request.subtype === 'stop_task'
    ) {
      log({
        type: 'control_request',
        subtype: request.subtype,
        requestId: message.request_id ?? null,
        taskId: request.task_id ?? null,
      });
    }
    void write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response:
          replay && request.subtype === 'interrupt'
            ? { still_queued: [], cancelled: [] }
            : {},
      },
    });
  } else if (message.type === 'user' && initialized && !started) {
    started = true;
    const content = message.message?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => block?.type === 'text')
              .map((block) => String(block.text ?? ''))
              .join('\n')
          : '';
    const sessionId =
      typeof message.session_id === 'string' ? message.session_id : '';
    const scenario = SCENARIOS.find(
      (candidate) =>
        candidate.session === sessionId && text.includes(candidate.prompt),
    );
    log({
      type: 'user',
      pid: process.pid,
      sessionId,
      scenario: scenario?.id ?? null,
      target: scenario?.id === 'pressure',
      targetSession: sessionId === TARGET_SESSION,
      textBytes: Buffer.byteLength(text),
      preview: text.slice(0, 100),
    });
    void (scenario ? scenario.run(message) : auxiliaryReply()).catch(
      (error) => {
        log({ type: 'burst_error', error: String(error) });
        if (replay) process.stderr.write(`${error.stack ?? error}\n`);
        process.exitCode = 1;
        process.stdout.end();
      },
    );
  }
});
input.on('close', () => {
  replay?.close();
  if (started) return;
  log({ type: 'input_closed_before_user' });
  process.stdout.end();
});
