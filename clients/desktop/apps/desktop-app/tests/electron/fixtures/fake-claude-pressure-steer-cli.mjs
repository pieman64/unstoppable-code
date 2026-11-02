#!/usr/bin/env node
// Deterministic Claude stream-json CLI for prompt steer acknowledgement
// pressure coverage. A queued lifecycle frame follows more than one stdout
// forwarding window of assistant output, then started/result wait for a
// release file so the test controls when the steer is picked up.
import { appendFileSync, existsSync, watch } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const TARGET_SESSION = 'demo-ts-pnpm-vite/demo-main/claude-pressure-chat';
const STEERING_CAPABILITIES = [
  'msg_lifecycle_v1',
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
];
const MARKER = 'CANOPY-CLAUDE-PRESSURE-';
const PRELUDE_COUNT = 10;
const PRELUDE_BODY = 'x'.repeat(4 * 1024);
const ACK_AFTER_BYTES = 64 * 1024;
// Frames between the steer and its queued acknowledgement: more than one host
// forwarding window in total, each its own admission.
const STEER_BACKLOG_COUNT = 40;
const STEER_BACKLOG_BODY = 'p'.repeat(2 * 1024);
const logPath = process.env.CANOPY_CLAUDE_PRESSURE_STEER_LOG;
const releasePath = process.env.CANOPY_CLAUDE_PRESSURE_STEER_RELEASE;

let initialized = false;
let rootStarted = false;
let rootStreamBytes = 0;
let pendingSteer;
let queuedAcknowledgementSent = false;
let releaseHandled = false;

function log(entry) {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function queueOutput(message) {
  const line = JSON.stringify(message) + '\n';
  const bytes = Buffer.byteLength(line);
  const canContinue = process.stdout.write(line);
  if (message.type === 'assistant' && message.session_id === TARGET_SESSION) {
    rootStreamBytes += bytes;
  }
  return { canContinue, bytes };
}

async function write(message) {
  const { canContinue } = queueOutput(message);
  if (!canContinue) await once(process.stdout, 'drain');
}

function assistant(index, body = PRELUDE_BODY) {
  const marker = MARKER + String(index).padStart(3, '0');
  return {
    type: 'assistant',
    uuid: 'claude-pressure-steer-uuid-' + index,
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
    message: {
      id: 'claude-pressure-steer-message-' + index,
      role: 'assistant',
      content: [{ type: 'text', text: marker + ' ' + body }],
    },
  };
}

function lifecycle(commandUuid, state) {
  return {
    type: 'command_lifecycle',
    command_uuid: commandUuid,
    state,
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
  };
}

function maybeQueueSteerAcknowledgement() {
  if (
    !pendingSteer ||
    queuedAcknowledgementSent ||
    rootStreamBytes <= ACK_AFTER_BYTES
  )
    return;
  queuedAcknowledgementSent = true;
  const ackAtMs = Date.now();
  queueOutput(lifecycle(pendingSteer.uuid, 'queued'));
  log({
    type: 'steer_queued',
    commandUuid: pendingSteer.uuid,
    ackAtMs,
    outputBytes: rootStreamBytes,
  });
  void finishSteer(pendingSteer).catch((error) => {
    log({ type: 'steer_error', error: String(error) });
    process.exitCode = 1;
    process.stdout.end();
  });
}

function waitForReleaseFile() {
  if (!releasePath) {
    throw new Error('CANOPY_CLAUDE_PRESSURE_STEER_RELEASE is required');
  }
  if (existsSync(releasePath)) return Promise.resolve();
  const directory = path.dirname(releasePath);
  const filename = path.basename(releasePath);
  return new Promise((resolve, reject) => {
    let watcher;
    const close = () => watcher?.close();
    try {
      watcher = watch(directory, (_event, changed) => {
        if (
          (changed === null || String(changed) === filename) &&
          existsSync(releasePath)
        ) {
          close();
          resolve();
        }
      });
      watcher.once('error', (error) => {
        close();
        reject(error);
      });
      // Close the exists/watch race: the release may have arrived between the
      // first check and subscription.
      if (existsSync(releasePath)) {
        close();
        resolve();
      }
    } catch (error) {
      close();
      reject(error);
    }
  });
}

async function finishSteer(steer) {
  if (releaseHandled) return;
  releaseHandled = true;
  await waitForReleaseFile();
  await write(lifecycle(steer.uuid, 'started'));
  log({ type: 'steer_lifecycle', state: 'started', commandUuid: steer.uuid });
  await write({
    type: 'assistant',
    uuid: 'claude-pressure-steer-reply-' + process.pid,
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
    message: {
      id: 'claude-pressure-steer-reply-message-' + process.pid,
      role: 'assistant',
      content: [
        { type: 'text', text: 'Claude pressure steer reply: ' + steer.text },
      ],
    },
  });
  await write(lifecycle(steer.uuid, 'completed'));
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Claude pressure steer complete',
    session_id: TARGET_SESSION,
  });
  log({ type: 'finished', commandUuid: steer.uuid });
  process.stdout.end();
}

async function streamRootTurn() {
  await write({
    type: 'system',
    subtype: 'init',
    session_id: TARGET_SESSION,
    capabilities: STEERING_CAPABILITIES,
  });
  log({ type: 'turn_started' });
  for (let index = 0; index < PRELUDE_COUNT; index += 1) {
    const message = assistant(index);
    const { canContinue } = queueOutput(message);
    log({ type: 'sent', index, outputBytes: rootStreamBytes });
    maybeQueueSteerAcknowledgement();
    if (!canContinue) await once(process.stdout, 'drain');
  }
  log({ type: 'prelude_complete', outputBytes: rootStreamBytes });
}

async function handleSteer(message) {
  const commandUuid =
    typeof message.uuid === 'string' && message.uuid.length > 0
      ? message.uuid
      : undefined;
  if (!commandUuid || pendingSteer) return;
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
  pendingSteer = { uuid: commandUuid, text };
  log({ type: 'steer_user', commandUuid, text });

  // Each backlog frame is a separate admission behind the delayed transcript
  // writes; the acknowledgement follows all of them, within 1 MiB.
  const backlogStartBytes = rootStreamBytes;
  for (let index = 0; index < STEER_BACKLOG_COUNT; index += 1) {
    const { canContinue } = queueOutput(
      assistant('steer-backlog-' + index, STEER_BACKLOG_BODY),
    );
    if (!canContinue) await once(process.stdout, 'drain');
  }
  log({
    type: 'sent',
    index: 'steer-backlog',
    outputBytes: rootStreamBytes,
    backlogBytes: rootStreamBytes - backlogStartBytes,
  });
  maybeQueueSteerAcknowledgement();
}

async function auxiliaryReply(sessionId) {
  await write({ type: 'system', subtype: 'init', session_id: sessionId });
  await write({
    type: 'assistant',
    uuid: 'claude-pressure-steer-aux-' + process.pid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: 'claude-pressure-steer-aux-message-' + process.pid,
      role: 'assistant',
      content: [{ type: 'text', text: 'Pressure helper ready' }],
    },
  });
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Pressure helper ready',
    session_id: sessionId,
  });
  process.stdout.end();
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    log({ type: 'invalid_input', error: String(error) });
    return;
  }

  if (message.type === 'control_request') {
    if (message.request?.subtype === 'initialize') initialized = true;
    void write({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: {},
      },
    });
    return;
  }
  if (message.type !== 'user' || !initialized) return;
  const sessionId = String(message.session_id ?? '');
  if (sessionId !== TARGET_SESSION) {
    void auxiliaryReply(sessionId).catch((error) => {
      log({ type: 'auxiliary_error', error: String(error) });
      process.exitCode = 1;
      process.stdout.end();
    });
    return;
  }
  if (!rootStarted) {
    rootStarted = true;
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
    log({ type: 'root_user', text });
    void streamRootTurn().catch((error) => {
      log({ type: 'root_error', error: String(error) });
      process.exitCode = 1;
      process.stdout.end();
    });
    return;
  }
  void handleSteer(message).catch((error) => {
    log({ type: 'steer_error', error: String(error) });
    process.exitCode = 1;
    process.stdout.end();
  });
});

input.on('close', () => {
  if (!rootStarted) process.stdout.end();
});
