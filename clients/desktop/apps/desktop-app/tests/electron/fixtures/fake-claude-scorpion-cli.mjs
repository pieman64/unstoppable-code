#!/usr/bin/env node
// Deterministic stream-json Claude CLI for the "scorpion" queue shape: a
// parent turn that starts two background subagents. The subagents stay live
// (and keep streaming child frames) for the rest of the process, so the chat
// moves from `foreground` (root turn running) to `background` (root turn
// ended, subagents still working) and never back to `idle` on its own.
//
// Environment:
// - CANOPY_CLAUDE_SCORPION_LOG: JSONL log of every root/auxiliary input and
//   lifecycle step, read by the specs.
// - CANOPY_CLAUDE_SCORPION_HOLD_ROOT=1: keep the first root turn running after
//   the subagents start. The turn ends when a steered message arrives (it is
//   answered inside the same turn) or when the release file appears.
// - CANOPY_CLAUDE_SCORPION_RELEASE: path whose creation ends a held root turn.
// - CANOPY_CLAUDE_SCORPION_HOLD_INIT=1: after logging the first root prompt,
//   hold its system/init and every later provider frame until INIT_RELEASE
//   appears. With HOLD_ROOT=1, the released root remains active for steering.
// - CANOPY_CLAUDE_SCORPION_INIT_RELEASE: path whose creation releases init.
//
// Without HOLD_ROOT the first root turn ends right after the subagents start.
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';

const TARGET_SESSION = 'demo-ts-pnpm-vite/demo-main/t1';
// Advertised on the root init so the app offers Steer, as the real CLI does.
const STEERING_CAPABILITIES = [
  'msg_lifecycle_v1',
  'interrupt_receipt_v1',
  'interrupt_cancel_queued_v1',
];
const SUBAGENTS = [
  { toolUseId: 'toolu_scorpion_agent_a', taskId: 'task_scorpion_a' },
  { toolUseId: 'toolu_scorpion_agent_b', taskId: 'task_scorpion_b' },
];
const logPath = process.env.CANOPY_CLAUDE_SCORPION_LOG;
const holdRoot = process.env.CANOPY_CLAUDE_SCORPION_HOLD_ROOT === '1';
const releasePath = process.env.CANOPY_CLAUDE_SCORPION_RELEASE;
const holdInit = process.env.CANOPY_CLAUDE_SCORPION_HOLD_INIT === '1';
const initReleasePath = process.env.CANOPY_CLAUDE_SCORPION_INIT_RELEASE;

let rootPromptCount = 0;
let rootTurnRunning = false;
let rootInitComplete = Promise.resolve();
let releaseTimer;
let childFrameTimer;
let childFrameCount = 0;
let processKeepAlive;

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
    uuid: `claude-scorpion-${suffix}-${process.pid}`,
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
    message: {
      id: `claude-scorpion-message-${suffix}-${process.pid}`,
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

async function startSubagents() {
  await write({
    type: 'assistant',
    uuid: `claude-scorpion-agents-${process.pid}`,
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
    message: {
      id: `claude-scorpion-agents-message-${process.pid}`,
      role: 'assistant',
      content: SUBAGENTS.map((agent, index) => ({
        type: 'tool_use',
        id: agent.toolUseId,
        name: 'Agent',
        input: {
          description: `Scorpion subagent ${index + 1}`,
          prompt: `Investigate area ${index + 1}`,
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
      })),
    },
  });
  await write({
    type: 'user',
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: SUBAGENTS.map((agent) => ({
        type: 'tool_result',
        tool_use_id: agent.toolUseId,
        content: `Async agent launched: ${agent.taskId}`,
      })),
    },
  });
  for (const [index, agent] of SUBAGENTS.entries()) {
    await write({
      type: 'system',
      subtype: 'task_started',
      session_id: TARGET_SESSION,
      task_id: agent.taskId,
      tool_use_id: agent.toolUseId,
      description: `Scorpion subagent ${index + 1}`,
      is_backgrounded: true,
    });
  }
  log({ type: 'subagents_started', count: SUBAGENTS.length });
  // Both subagents keep reporting progress after the root turn ends.
  childFrameTimer = setInterval(() => {
    childFrameCount += 1;
    const agent = SUBAGENTS[childFrameCount % SUBAGENTS.length];
    void write({
      type: 'assistant',
      uuid: `claude-scorpion-child-${childFrameCount}-${process.pid}`,
      session_id: TARGET_SESSION,
      parent_tool_use_id: agent.toolUseId,
      message: {
        id: `claude-scorpion-child-message-${childFrameCount}-${process.pid}`,
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `scorpion subagent update ${childFrameCount}`,
          },
        ],
      },
    }).catch((error) => {
      log({ type: 'write_error', error: String(error) });
    });
  }, 1_000);
  processKeepAlive = setInterval(() => {}, 60_000);
}

async function endRootTurn(reply, reason) {
  if (!rootTurnRunning) return;
  rootTurnRunning = false;
  if (releaseTimer) clearInterval(releaseTimer);
  releaseTimer = undefined;
  await emitAssistant(reply, `root-end-${reason}`);
  await emitResult('scorpion root turn complete');
  log({ type: 'root_result', reason });
}

async function emitCommandLifecycle(commandUuid, state) {
  await write({
    type: 'command_lifecycle',
    command_uuid: commandUuid,
    state,
    session_id: TARGET_SESSION,
    parent_tool_use_id: null,
  });
}

async function handleRootUserMessage(promptText, commandUuid) {
  rootPromptCount += 1;
  if (rootPromptCount === 1) {
    rootTurnRunning = true;
    let finishInit;
    if (holdInit) {
      rootInitComplete = new Promise((resolve) => {
        finishInit = resolve;
      });
    }
    try {
      if (holdInit) {
        log({ type: 'root_init_held' });
        if (!initReleasePath) {
          throw new Error(
            'CANOPY_CLAUDE_SCORPION_INIT_RELEASE is required when init is held',
          );
        }
        while (!existsSync(initReleasePath)) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      await write({
        type: 'system',
        subtype: 'init',
        session_id: TARGET_SESSION,
        capabilities: STEERING_CAPABILITIES,
      });
      await emitAssistant('scorpion root reply', 'root');
      await startSubagents();
      if (!holdRoot) {
        await endRootTurn('scorpion root turn handed off', 'immediate');
        return;
      }
      log({ type: 'root_held' });
      if (releasePath) {
        releaseTimer = setInterval(() => {
          if (!existsSync(releasePath)) return;
          void endRootTurn('scorpion root turn released', 'release').catch(
            (error) => {
              log({ type: 'root_error', error: String(error) });
            },
          );
        }, 100);
      }
    } finally {
      // A steer can arrive as soon as init advertises its capabilities. Keep
      // it behind root setup so its result cannot overtake the subagent and
      // held-root frames that belong to this same turn.
      finishInit?.();
    }
    return;
  }

  if (rootTurnRunning) {
    if (holdInit) await rootInitComplete;
    if (!rootTurnRunning) {
      await emitAssistant(
        `scorpion follow-up reply: ${promptText}`,
        `followup-${rootPromptCount}`,
      );
      await emitResult('scorpion follow-up complete');
      return;
    }
    // A message delivered while the root turn runs is a steer. Report its
    // lifecycle as the real CLI does, answer it in the same turn, then let the
    // turn end.
    if (commandUuid) {
      await emitCommandLifecycle(commandUuid, 'queued');
      await emitCommandLifecycle(commandUuid, 'started');
      log({ type: 'steer_lifecycle', commandUuid });
    }
    await endRootTurn(`scorpion steer reply: ${promptText}`, 'steer');
    return;
  }

  await emitAssistant(
    `scorpion follow-up reply: ${promptText}`,
    `followup-${rootPromptCount}`,
  );
  await emitResult('scorpion follow-up complete');
}

async function respondToAuxiliarySession(sessionId) {
  await write({ type: 'system', subtype: 'init', session_id: sessionId });
  await write({
    type: 'assistant',
    uuid: `claude-scorpion-aux-${process.pid}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: `claude-scorpion-aux-message-${process.pid}`,
      role: 'assistant',
      content: [{ type: 'text', text: 'Scorpion helper ready' }],
    },
  });
  await write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Scorpion helper ready',
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
    const subtype = message.request?.subtype;
    log({ type: 'control_request', subtype, rootTurnRunning });
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
  // `rootTurnRunning` is read before the message is handled, so a steer logs
  // `true` and a message sent after the root result logs `false`.
  log({ type: 'user', sessionId, text: promptText, rootTurnRunning });
  if (sessionId !== TARGET_SESSION) {
    void respondToAuxiliarySession(sessionId).catch((error) => {
      log({ type: 'auxiliary_error', error: String(error) });
      process.exitCode = 1;
      process.stdout.end();
    });
    return;
  }

  const commandUuid =
    typeof message.uuid === 'string' && message.uuid.length > 0
      ? message.uuid
      : undefined;
  void handleRootUserMessage(promptText, commandUuid).catch((error) => {
    log({ type: 'root_error', error: String(error) });
    process.exitCode = 1;
    if (releaseTimer) clearInterval(releaseTimer);
    if (childFrameTimer) clearInterval(childFrameTimer);
    if (processKeepAlive) clearInterval(processKeepAlive);
    process.stdout.end();
  });
});

input.on('close', () => {
  // Auxiliary CLI processes are one-shot. The root process stays alive after
  // its terminal result while the background subagents run.
  if (rootPromptCount === 0 && !processKeepAlive) process.stdout.end();
});
