#!/usr/bin/env node
// Deterministic stream-json Claude CLI for settings-hold background-agent coverage.
// It leaves the root session open after its result so the app can stop the task.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const TARGET_SESSION = 'demo-ts-pnpm-vite/demo-main/t1';
const TASK_ID = 'settings-hold-agent';
const TOOL_USE_ID = 'toolu_settings_hold_agent';
const TASK_DESCRIPTION = 'Settings hold background agent';
const logPath = process.env.CANOPY_CLAUDE_SETTINGS_HOLD_LOG;
let rootPromptCount = 0;
let rootKeepAlive;
let backgroundAgentActive = false;
let messageSequence = 0;
let lineQueue = Promise.resolve();

function log(entry) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

log({ type: 'spawn', pid: process.pid, argv: process.argv.slice(2) });

async function write(message) {
  if (!process.stdout.write(`${JSON.stringify(message)}\n`)) {
    await once(process.stdout, 'drain');
  }
}

function textFromUserMessage(message) {
  const content = message.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text ?? ''))
    .join('\n');
}

async function emitSystem(event) {
  const message = { type: 'system', ...event };
  log({ ...message, pid: process.pid });
  await write(message);
}

async function emitAssistant(text, suffix, sessionId = TARGET_SESSION) {
  const sequence = ++messageSequence;
  await write({
    type: 'assistant',
    uuid: `claude-settings-hold-${suffix}-${process.pid}-${sequence}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `claude-settings-hold-message-${suffix}-${process.pid}-${sequence}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

async function emitResult(result, sessionId = TARGET_SESSION) {
  const message = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: sessionId,
  };
  await write(message);
  if (sessionId === TARGET_SESSION) {
    log({
      type: 'result',
      pid: process.pid,
      sessionId,
      subtype: message.subtype,
      is_error: message.is_error,
      result: message.result,
    });
  }
}

function keepRootProcessOpen() {
  rootKeepAlive ??= setInterval(() => {}, 60_000);
}

async function respondToAuxiliarySession(sessionId, promptText) {
  await emitSystem({ subtype: 'init', session_id: sessionId });
  await emitAssistant(
    `settings hold helper reply: ${promptText}`,
    'aux',
    sessionId,
  );
  await emitResult('settings hold helper complete', sessionId);
  process.stdout.end();
}

async function startBackgroundAgent(promptText) {
  await write({
    type: 'assistant',
    uuid: `claude-settings-hold-agent-${process.pid}`,
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
    message: {
      id: `claude-settings-hold-agent-message-${process.pid}`,
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: TOOL_USE_ID,
          name: 'Agent',
          input: {
            subagent_type: 'Explore',
            description: TASK_DESCRIPTION,
            prompt: promptText,
            run_in_background: true,
          },
        },
      ],
    },
  });
  await emitSystem({
    subtype: 'task_started',
    session_id: TARGET_SESSION,
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    task_type: 'local_agent',
    is_backgrounded: true,
    description: TASK_DESCRIPTION,
  });
  await emitSystem({
    subtype: 'background_tasks_changed',
    session_id: TARGET_SESSION,
    tasks: [
      {
        task_id: TASK_ID,
        task_type: 'local_agent',
        description: TASK_DESCRIPTION,
      },
    ],
  });
  await write({
    type: 'user',
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: TOOL_USE_ID,
          content:
            'Async agent launched successfully. agentId: settings-hold-agent (This is an internal ID for your use, do not mention it to user.)\nThe agent is working in the background. You will be notified automatically when it completes.',
        },
      ],
    },
  });
  backgroundAgentActive = true;
  await emitAssistant('settings hold root reply', `root-${rootPromptCount}`);
  await emitResult('settings hold root turn complete');
  keepRootProcessOpen();
}

async function handleRootUserMessage(promptText) {
  rootPromptCount += 1;
  if (rootPromptCount === 1) {
    // A resumed CLI process has its own count, so it also emits init on its
    // first root prompt.
    await emitSystem({ subtype: 'init', session_id: TARGET_SESSION });
  }

  if (
    promptText.toLowerCase().includes('start background agent') &&
    !backgroundAgentActive
  ) {
    await startBackgroundAgent(promptText);
    return;
  }

  // Leave this reply running (no result) so a follow-up queues behind it.
  if (promptText.toLowerCase().includes('keep replying')) {
    await emitAssistant(
      'settings hold reply in progress',
      `root-${rootPromptCount}`,
    );
    keepRootProcessOpen();
    return;
  }

  await emitAssistant(
    `settings hold reply: ${promptText}`,
    `root-${rootPromptCount}`,
  );
  await emitResult('settings hold root turn complete');
  keepRootProcessOpen();
}

async function handleControlRequest(message) {
  const request = message.request ?? {};
  const subtype = request.subtype ?? null;
  // The SDK's stop_task request uses request.task_id (not taskId).
  const taskId = request.task_id ?? null;
  log({ type: 'control_request', pid: process.pid, subtype, taskId });
  await write({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: message.request_id,
      response: {},
    },
  });

  if (subtype !== 'stop_task' || taskId !== TASK_ID || !backgroundAgentActive) {
    return;
  }

  backgroundAgentActive = false;
  await emitSystem({
    subtype: 'task_notification',
    session_id: TARGET_SESSION,
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    status: 'stopped',
    summary: 'Settings hold background agent stopped.',
  });
  await emitSystem({
    subtype: 'background_tasks_changed',
    session_id: TARGET_SESSION,
    tasks: [],
  });
}

async function handleInputLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    log({ type: 'invalid_input', pid: process.pid, error: String(error) });
    return;
  }

  if (message.type === 'control_request') {
    await handleControlRequest(message);
    return;
  }

  if (message.type !== 'user') return;
  const promptText = textFromUserMessage(message);
  const sessionId = String(message.session_id ?? '');
  log({ type: 'user', pid: process.pid, sessionId, text: promptText });
  if (sessionId !== TARGET_SESSION) {
    await respondToAuxiliarySession(sessionId, promptText);
    return;
  }

  await handleRootUserMessage(promptText);
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  lineQueue = lineQueue
    .then(() => handleInputLine(line))
    .catch((error) => {
      log({ type: 'fixture_error', pid: process.pid, error: String(error) });
      process.exitCode = 1;
      process.stdout.end();
    });
});

input.on('close', () => {
  void lineQueue.finally(() => {
    if (rootKeepAlive) clearInterval(rootKeepAlive);
    process.stdout.end();
  });
});
