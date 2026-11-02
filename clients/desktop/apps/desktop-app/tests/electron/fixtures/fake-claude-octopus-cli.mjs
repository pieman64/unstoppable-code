#!/usr/bin/env node
// Deterministic stream-json Claude CLI for the octopus queue regression.
// It finishes the root turn but leaves its session open while a child-agent
// frame continues streaming, then accepts one more root prompt.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const TARGET_SESSION = 'demo-ts-pnpm-vite/demo-main/t1';
const logPath = process.env.CANOPY_CLAUDE_OCTOPUS_LOG;
let rootPromptCount = 0;
let rootKeepAlive;

function log(entry) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

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

async function emitAssistant(text, suffix) {
  await write({
    type: 'assistant',
    uuid: `claude-octopus-${suffix}-${process.pid}`,
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
    message: {
      id: `claude-octopus-message-${suffix}-${process.pid}`,
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

async function emitResult(result) {
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result,
    session_id: TARGET_SESSION,
  });
}

async function respondToAuxiliarySession(sessionId) {
  await write({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
  });
  await write({
    type: 'assistant',
    uuid: `claude-octopus-aux-${process.pid}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `claude-octopus-aux-message-${process.pid}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'Octopus helper ready' }],
    },
  });
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Octopus helper ready',
    session_id: sessionId,
  });
  process.stdout.end();
}

async function handleRootUserMessage(promptText) {
  rootPromptCount += 1;
  if (rootPromptCount === 1) {
    await write({
      type: 'system',
      subtype: 'init',
      session_id: TARGET_SESSION,
    });
    await emitAssistant('octopus root reply', 'root');
    await emitResult('octopus root turn complete');
    // The root result is terminal, but a background agent still owns the
    // stream. Keep the protocol process alive and emit its child frame later.
    setTimeout(() => {
      void write({
        type: 'assistant',
        uuid: `claude-octopus-child-${process.pid}`,
        session_id: TARGET_SESSION,
        parent_tool_use_id: 'toolu_octopus_agent',
        message: {
          id: `claude-octopus-child-message-${process.pid}`,
          role: 'assistant',
          content: [{ type: 'text', text: 'octopus background agent update' }],
        },
      })
        .then(() => {
          log({
            type: 'child_frame_emitted',
            parentToolUseId: 'toolu_octopus_agent',
          });
        })
        .catch((error) => {
          log({ type: 'write_error', error: String(error) });
        });
    }, 400);
    rootKeepAlive = setInterval(() => {}, 60_000);
    return;
  }

  if (rootPromptCount === 2) {
    await emitAssistant(`octopus follow-up reply: ${promptText}`, 'followup');
    await emitResult('octopus follow-up complete');
  }
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
    const subtype = message.request?.subtype;
    log({ type: 'control_request', subtype });
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

  if (message.type !== 'user') return;
  const promptText = textFromUserMessage(message);
  const sessionId = String(message.session_id ?? '');
  log({ type: 'user', sessionId, text: promptText });
  if (sessionId !== TARGET_SESSION) {
    void respondToAuxiliarySession(sessionId).catch((error) => {
      log({ type: 'auxiliary_error', error: String(error) });
      process.exitCode = 1;
      process.stdout.end();
    });
    return;
  }

  void handleRootUserMessage(promptText).catch((error) => {
    log({ type: 'root_error', error: String(error) });
    process.exitCode = 1;
    if (rootKeepAlive) clearInterval(rootKeepAlive);
    process.stdout.end();
  });
});

input.on('close', () => {
  // Auxiliary CLI processes are one-shot. The root process intentionally
  // remains alive after its terminal result while the background child runs.
  if (rootPromptCount === 0 && !rootKeepAlive) process.stdout.end();
});
