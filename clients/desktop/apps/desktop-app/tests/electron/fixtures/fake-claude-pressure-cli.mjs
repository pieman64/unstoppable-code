#!/usr/bin/env node
// Deterministic Claude stream-json CLI for provider pressure and child-quota
// UI automation. The process waits for the SDK initialize and first user
// message before replying. stdout.write/drain preserves source backpressure.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const MARKER = 'CANOPY-CLAUDE-PRESSURE-';
const COUNT = 128;
const BODY = 'x'.repeat(2 * 1024);
const logPath = process.env.CANOPY_CLAUDE_PRESSURE_LOG;
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

// A chat turn streams its prompt under the chat's session key
// (`<projectId>/<worktreeId>/<chatId>`). Helper queries for the same chat,
// such as branch naming, send their own prompt under an empty session id,
// and that prompt can quote the user's text (`<task_description>...`).
// A scenario therefore runs only for the chat turn it was written for, and
// every other invocation gets the plain helper reply.
const SCENARIOS = [
  {
    id: 'pressure',
    session: 'demo-ts-pnpm-vite/demo-main/claude-pressure-chat',
    prompt: 'Report Claude pressure status.',
    run: burst,
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
      textBytes: Buffer.byteLength(text),
      preview: text.slice(0, 100),
    });
    void (scenario ? scenario.run() : auxiliaryReply()).catch((error) => {
      log({ type: 'burst_error', error: String(error) });
      process.exitCode = 1;
      process.stdout.end();
    });
  }
});
input.on('close', () => {
  if (started) return;
  log({ type: 'input_closed_before_user' });
  process.stdout.end();
});
