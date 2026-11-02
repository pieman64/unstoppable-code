#!/usr/bin/env node
// Deterministic Claude stream-json CLI for the auto-archive release flow.
// Unlike a one-shot fixture, the chat process stays alive between turns, as
// the real CLI does, until Canopy ends it. It logs only its pid, the session
// it resumes, and whether its MCP route names the chat: the raw argv carries
// bearer tokens and must never be written anywhere.
//
// A prompt containing BACKGROUND_TASK_MARKER starts a background Bash task
// that stays live after the turn's result, until a file named
// `<log path>.finish-task` appears.
//
// When Canopy registers a Stop hook, every chat turn runs it before its result,
// as the real CLI does. Its `session_crons` list holds one cron after a prompt
// containing SESSION_CRON_MARKER and is empty otherwise.
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const CHAT_SESSION_KEY = 'demo-ts-pnpm-vite/demo-main/claude-auto-archive';
const SESSION_ID = '6f1c2a3e-1b2c-4d5e-8f90-0a1b2c3d4e5f';
const BACKGROUND_TASK_MARKER = '[background-task]';
const BACKGROUND_TASK_ID = 'claude-auto-archive-dev-server';
const SESSION_CRON_MARKER = '[session-cron]';
const logPath = process.env.CANOPY_CLAUDE_AUTO_ARCHIVE_LOG;
const argv = process.argv.slice(2);

// The SDK passes `--resume=<id>` but `--mcp-config <json>`; accept both forms.
function flagValue(name) {
  const prefix = `${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) return argv[index + 1] ?? null;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

const resume = flagValue('--resume');
const mcpConfigNamesChat = String(flagValue('--mcp-config') ?? '').includes(
  'claude-auto-archive',
);
let initialized = false;
let chatTurns = 0;
let helper = false;
let stopHookCallbackId = null;
let hookRequests = 0;
const pendingHookResponses = new Map();

function log(entry) {
  if (logPath) {
    appendFileSync(
      logPath,
      `${JSON.stringify({ ...entry, pid: process.pid })}\n`,
    );
  }
}

async function write(message) {
  if (!process.stdout.write(`${JSON.stringify(message)}\n`)) {
    await once(process.stdout, 'drain');
  }
}

function messageText(message) {
  const content = message.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n');
}

function assistant(turn, suffix, content) {
  return {
    type: 'assistant',
    uuid: `claude-auto-archive-${process.pid}-${turn}-${suffix}`,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: {
      id: `claude-auto-archive-message-${process.pid}-${turn}-${suffix}`,
      role: 'assistant',
      content,
    },
  };
}

async function startBackgroundTask(turn) {
  const toolUseId = `toolu_claude_auto_archive_${process.pid}_${turn}`;
  await write(
    assistant(turn, 'tool', [
      {
        type: 'tool_use',
        id: toolUseId,
        name: 'Bash',
        input: {
          command: 'pnpm dev',
          description: 'Start the dev server',
          run_in_background: true,
        },
      },
    ]),
  );
  await write({
    type: 'system',
    subtype: 'task_started',
    task_id: BACKGROUND_TASK_ID,
    tool_use_id: toolUseId,
    description: 'Start the dev server',
    is_backgrounded: true,
    session_id: SESSION_ID,
  });
  await write({
    type: 'user',
    uuid: `claude-auto-archive-${process.pid}-${turn}-tool-result`,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: `Command running in background with ID: ${BACKGROUND_TASK_ID}`,
        },
      ],
    },
  });
  log({ type: 'task_started' });
  return toolUseId;
}

function finishBackgroundTaskWhenAsked(toolUseId) {
  const finishPath = `${logPath}.finish-task`;
  const timer = setInterval(() => {
    if (!existsSync(finishPath)) return;
    clearInterval(timer);
    void write({
      type: 'system',
      subtype: 'task_notification',
      task_id: BACKGROUND_TASK_ID,
      tool_use_id: toolUseId,
      status: 'completed',
      summary: 'Dev server stopped',
      session_id: SESSION_ID,
    }).then(() => log({ type: 'task_finished' }));
  }, 100);
}

function readStopHookCallbackId(request) {
  const matchers = request?.hooks?.Stop;
  if (!Array.isArray(matchers)) return null;
  for (const matcher of matchers) {
    const [id] = matcher?.hookCallbackIds ?? [];
    if (typeof id === 'string') return id;
  }
  return null;
}

async function runStopHook(sessionCrons) {
  if (!stopHookCallbackId) return;
  hookRequests += 1;
  const requestId = `fake-claude-stop-${process.pid}-${hookRequests}`;
  const answered = new Promise((resolve) => {
    pendingHookResponses.set(requestId, resolve);
    setTimeout(() => resolve(false), 5_000);
  });
  await write({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'hook_callback',
      callback_id: stopHookCallbackId,
      input: {
        hook_event_name: 'Stop',
        session_id: SESSION_ID,
        transcript_path: '',
        cwd: process.cwd(),
        stop_hook_active: false,
        background_tasks: [],
        session_crons: sessionCrons,
      },
    },
  });
  const result = await answered;
  pendingHookResponses.delete(requestId);
  log({ type: 'stop_hook', crons: sessionCrons.length, answered: result });
}

async function chatReply(prompt) {
  chatTurns += 1;
  const turn = chatTurns;
  const text =
    resume === SESSION_ID
      ? `Resumed ${SESSION_ID} turn ${turn}`
      : `Auto archive turn ${turn} complete`;
  await write({ type: 'system', subtype: 'init', session_id: SESSION_ID });
  const backgroundToolUseId = prompt.includes(BACKGROUND_TASK_MARKER)
    ? await startBackgroundTask(turn)
    : undefined;
  await write(assistant(turn, 'text', [{ type: 'text', text }]));
  await runStopHook(
    prompt.includes(SESSION_CRON_MARKER)
      ? [
          {
            id: 'claude-auto-archive-cron',
            schedule: '*/5 * * * *',
            recurring: true,
            prompt: 'Check CI',
          },
        ]
      : [],
  );
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: SESSION_ID,
  });
  log({ type: 'chat_turn_complete', turn, resume });
  if (backgroundToolUseId) finishBackgroundTaskWhenAsked(backgroundToolUseId);
}

async function helperReply() {
  await write({
    type: 'assistant',
    uuid: `claude-auto-archive-helper-${process.pid}`,
    session_id: `claude-auto-archive-helper-${process.pid}`,
    parent_tool_use_id: null,
    message: {
      id: `claude-auto-archive-helper-message-${process.pid}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'Auto archive helper ready' }],
    },
  });
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Auto archive helper ready',
    session_id: `claude-auto-archive-helper-${process.pid}`,
  });
  process.stdout.end();
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (!helper) log({ type: 'exit', reason: signal });
    process.exit(0);
  });
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    log({ type: 'invalid_input' });
    return;
  }
  if (message.type === 'control_response') {
    const requestId = message.response?.request_id;
    pendingHookResponses.get(requestId)?.(
      message.response?.subtype === 'success',
    );
    return;
  }
  if (message.type === 'control_request') {
    if (message.request?.subtype === 'initialize') {
      initialized = true;
      stopHookCallbackId = readStopHookCallbackId(message.request);
    }
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
  const sessionKey =
    typeof message.session_id === 'string' ? message.session_id : '';
  if (sessionKey !== CHAT_SESSION_KEY) {
    helper = true;
    void helperReply();
    return;
  }
  if (chatTurns === 0) {
    log({ type: 'chat_start', resume, mcpConfigNamesChat });
  }
  const prompt = messageText(message);
  log({ type: 'chat_user', preview: prompt.slice(0, 80) });
  void chatReply(prompt).catch((error) => {
    log({ type: 'chat_error', error: String(error) });
    process.exitCode = 1;
    process.stdout.end();
  });
});
input.on('close', () => {
  if (!helper && chatTurns > 0) log({ type: 'exit', reason: 'stdin_closed' });
  process.stdout.end();
});
