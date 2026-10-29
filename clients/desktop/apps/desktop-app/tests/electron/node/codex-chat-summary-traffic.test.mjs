import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHAT_SUMMARY_INSTRUCTIONS_FINGERPRINT,
  CHAT_SUMMARY_TURN_MARKER,
  chatSummaryTurnStarts,
  isChatSummaryThreadStartParams,
  isChatSummaryTurnInput,
  withoutChatSummaryTraffic,
} from '../fixtures/codex-chat-summary-traffic.mjs';

const SUMMARY_INSTRUCTIONS =
  'You are an expert at providing concise topic summaries. Return ONLY the topic summary.';

function summaryInput(text) {
  return [
    {
      type: 'text',
      text: `<user_message_to_summarize>${text}</user_message_to_summarize>`,
      text_elements: [],
    },
  ];
}

function conversationInput(text) {
  return [{ type: 'text', text, text_elements: [] }];
}

// A conversation and its chat summary interleaved on one pooled app-server.
// Request ids are per app-server process, so the summary's ids deliberately
// collide with another process's conversation ids.
function interleavedLog() {
  return [
    {
      pid: 1,
      direction: 'client',
      message: { id: 1, method: 'thread/start', params: { cwd: '/w' } },
    },
    {
      pid: 1,
      direction: 'server',
      message: { id: 1, result: { thread: { id: 'e2e-thread-1' } } },
    },
    {
      pid: 1,
      direction: 'client',
      message: {
        id: 2,
        method: 'turn/start',
        params: {
          threadId: 'e2e-thread-1',
          input: conversationInput('Report pressure status.'),
        },
      },
    },
    {
      pid: 1,
      direction: 'client',
      message: {
        id: 3,
        method: 'thread/start',
        params: {
          cwd: '/w',
          ephemeral: true,
          developerInstructions: SUMMARY_INSTRUCTIONS,
        },
      },
    },
    {
      pid: 1,
      direction: 'server',
      message: { id: 2, result: { turn: { id: 'e2e-turn-1' } } },
    },
    {
      pid: 1,
      direction: 'server',
      message: { id: 3, result: { thread: { id: 'e2e-thread-2' } } },
    },
    {
      pid: 1,
      direction: 'client',
      message: {
        id: 4,
        method: 'turn/start',
        params: {
          threadId: 'e2e-thread-2',
          input: summaryInput('Report pressure status.'),
        },
      },
    },
    {
      pid: 1,
      direction: 'server',
      message: { id: 4, result: { turn: { id: 'e2e-turn-2' } } },
    },
    {
      pid: 1,
      direction: 'server',
      message: {
        method: 'turn/completed',
        params: { threadId: 'e2e-thread-2', turn: { id: 'e2e-turn-2' } },
      },
    },
    {
      pid: 1,
      direction: 'client',
      message: {
        id: 5,
        method: 'thread/delete',
        params: { threadId: 'e2e-thread-2' },
      },
    },
    // A server-initiated request reuses the summary turn/start's request id
    // in its own id space; it belongs to the conversation.
    {
      pid: 1,
      direction: 'server',
      message: {
        id: 4,
        method: 'item/tool/call',
        params: { threadId: 'e2e-thread-1', tool: 'fixture' },
      },
    },
    {
      pid: 1,
      direction: 'server',
      message: {
        method: 'turn/completed',
        params: { threadId: 'e2e-thread-1', turn: { id: 'e2e-turn-1' } },
      },
    },
    {
      pid: 2,
      direction: 'client',
      message: {
        id: 3,
        method: 'turn/start',
        params: {
          threadId: 'e2e-thread-3',
          input: conversationInput('Peer message'),
        },
      },
    },
    {
      pid: 2,
      direction: 'server',
      message: { id: 3, result: { turn: { id: 'e2e-turn-3' } } },
    },
    { direction: 'late-command-emitted', turnId: 'e2e-turn-1' },
  ];
}

test('recognizes the chat-summary helper thread and turn', () => {
  assert.equal(
    isChatSummaryThreadStartParams({
      developerInstructions: SUMMARY_INSTRUCTIONS,
    }),
    true,
  );
  assert.equal(isChatSummaryThreadStartParams({ cwd: '/w' }), false);
  assert.equal(isChatSummaryTurnInput(summaryInput('Hello')), true);
  assert.equal(isChatSummaryTurnInput(conversationInput('Hello')), false);
  assert.equal(isChatSummaryTurnInput(undefined), false);
});

test('keeps only conversation traffic and fixture markers', () => {
  const kept = withoutChatSummaryTraffic(interleavedLog());
  assert.deepEqual(
    kept.map((entry) => [
      entry.pid,
      entry.direction,
      entry.message?.id ?? entry.message?.method ?? entry.turnId,
    ]),
    [
      [1, 'client', 1],
      [1, 'server', 1],
      [1, 'client', 2],
      [1, 'server', 2],
      [1, 'server', 4],
      [1, 'server', 'turn/completed'],
      [2, 'client', 3],
      [2, 'server', 3],
      [undefined, 'late-command-emitted', 'e2e-turn-1'],
    ],
  );
});

test('excludes a summary thread before its turn starts', () => {
  const log = interleavedLog().slice(0, 6);
  const threadStarts = withoutChatSummaryTraffic(log).filter(
    (entry) => entry.message?.method === 'thread/start',
  );
  assert.equal(threadStarts.length, 1);
  assert.equal(threadStarts[0].message.params.developerInstructions, undefined);
});

test('lists the summary turn starts on their own thread', () => {
  const starts = chatSummaryTurnStarts(interleavedLog());
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.threadId, 'e2e-thread-2');
});

// The fixture recognizes summary traffic by text the product sends. Fail here,
// not in a flaky Electron spec, when that text changes.
test('fingerprints match the product chat-summary prompts', () => {
  const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  const read = (relativePath) =>
    readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const helpers = read('apps/desktop-app/src/main/agents/utils.ts');
  assert.match(
    helpers,
    /import\s*\{\s*SHORT_CHAT_TITLE_SYSTEM_PROMPT\s*\}\s*from '@canopy\/protocol\/generated-names'/,
  );
  assert.ok(helpers.includes('systemPrompt: SHORT_CHAT_TITLE_SYSTEM_PROMPT'));
  assert.ok(
    helpers.includes(
      `\`${CHAT_SUMMARY_TURN_MARKER}\${userMessage}</user_message_to_summarize>\``,
    ),
  );
  const shortTitlePrompt = read('packages/protocol/src/generated-names.ts');
  assert.ok(
    shortTitlePrompt.includes(
      `'You are an ${CHAT_SUMMARY_INSTRUCTIONS_FINGERPRINT}`,
    ),
  );
});
