// A parent chat with one completed managed delegate, stored either the
// legacy way (child rows in the parent transcript) or in the chat's delegate
// log (`transcriptStore: 'chat-log-v1'`, the card is the only parent row).
// Both render the same card and children; specs use the pair to prove it.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { seedWorktreeChat } from './seedWorktreeChat.mjs';

export const DELEGATION_LOG_FIXTURE = Object.freeze({
  workspaceId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  chatId: 'delegate-log-parent',
  delegationId: 'delegate-log-child',
  description: 'Review error handling',
  finding:
    'The error handler should retain the original cause when the source file cannot be read.',
  reasoning: 'Checking whether the original cause survives the error boundary.',
  toolOutput: 'throw new Error("Unable to read source");',
});

const AGENT_BLOCK_ID = `delegated-agent-${DELEGATION_LOG_FIXTURE.delegationId}`;
const CREATED_AT = 1788825601000;

/** The delegate's child items, in delegate-log form. */
function childItems() {
  const { reasoning, toolOutput, finding } = DELEGATION_LOG_FIXTURE;
  return [
    {
      id: 'child-thinking',
      sequence: 1,
      occurredAt: CREATED_AT + 100,
      type: 'thinking',
      text: reasoning,
    },
    {
      id: 'child-read',
      sequence: 2,
      occurredAt: CREATED_AT + 200,
      type: 'tool',
      toolName: 'Read',
      input: '{"path":"src/index.ts"}',
      output: toolOutput,
      isError: false,
    },
    {
      id: 'child-finding',
      sequence: 3,
      occurredAt: CREATED_AT + 300,
      type: 'text',
      text: finding,
    },
  ];
}

/** The same items as legacy child rows of the parent transcript. */
function legacyChildRows() {
  const { reasoning, toolOutput, finding } = DELEGATION_LOG_FIXTURE;
  return [
    {
      id: 'child-thinking',
      role: 'assistant',
      timestamp: CREATED_AT + 100,
      parentBlockId: AGENT_BLOCK_ID,
      delegationSequence: 1,
      blocks: [{ type: 'thinking', text: reasoning }],
    },
    {
      id: 'child-read',
      role: 'assistant',
      timestamp: CREATED_AT + 200,
      parentBlockId: AGENT_BLOCK_ID,
      delegationSequence: 2,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: 'child-read',
          toolName: 'Read',
          input: '{"path":"src/index.ts"}',
        },
        {
          type: 'tool_result',
          toolUseId: 'child-read',
          toolName: 'Read',
          output: toolOutput,
          isError: false,
        },
      ],
    },
    {
      id: 'child-finding',
      role: 'assistant',
      timestamp: CREATED_AT + 300,
      parentBlockId: AGENT_BLOCK_ID,
      delegationSequence: 3,
      blocks: [{ type: 'text', text: finding }],
    },
  ];
}

function card(logged) {
  const { delegationId, description, finding } = DELEGATION_LOG_FIXTURE;
  return {
    type: 'delegated_agent_call',
    agentBlockId: AGENT_BLOCK_ID,
    delegationId,
    runGeneration: 1,
    outputTruncated: false,
    parentHarnessId: 'claude',
    parentTurnId: 'request',
    parentToolCallId: 'delegation-call',
    selectedModelId: 'sonnet',
    runtimeModelId: 'claude-sonnet-4-6',
    targetHarnessId: 'claude',
    routeSnapshot: {
      selectedModelId: 'sonnet',
      runtimeModelId: 'claude-sonnet-4-6',
      selectedModelLabel: 'Claude Sonnet',
      runtimeModelLabel: 'Claude Sonnet 4.6',
      harnessId: 'claude',
    },
    status: 'completed',
    description,
    prompt: 'Read src/index.ts and review error handling.',
    executionMode: 'background',
    sequence: 4,
    createdAt: CREATED_AT,
    finalText: finding,
    ...(logged ? { transcriptStore: 'chat-log-v1' } : {}),
  };
}

/**
 * Seeds the parent chat before launch. `logged` stores the children in the
 * delegate log (write it with {@link writeDelegationLog} once the chat has
 * loaded); otherwise as child rows.
 */
export function seedDelegationTranscriptChat({ userDataDir, logged }) {
  const { workspaceId, worktreeId, chatId } = DELEGATION_LOG_FIXTURE;
  return seedWorktreeChat({
    userDataDir,
    workspaceId,
    worktreeId,
    providerType: 'claude',
    activeTabId: chatId,
    tabs: [
      {
        id: chatId,
        title: 'Independent error handling review',
        providerType: 'claude',
        messages: [
          {
            id: 'request',
            role: 'user',
            timestamp: CREATED_AT - 1000,
            blocks: [
              {
                type: 'text',
                text: 'Ask a delegate for an independent review of the error handling.',
              },
            ],
          },
          {
            id: AGENT_BLOCK_ID,
            role: 'assistant',
            timestamp: CREATED_AT,
            blocks: [card(logged)],
          },
          ...(logged ? [] : legacyChildRows()),
          {
            id: 'parent-answer',
            role: 'assistant',
            timestamp: CREATED_AT + 1000,
            blocks: [
              {
                type: 'text',
                text: 'The delegate found one actionable issue, which I confirmed.',
              },
            ],
          },
        ],
      },
    ],
  });
}

/** The delegate log file of the fixture's run, in the chat's storage scope. */
export function delegationLogPath(userDataDir) {
  const { workspaceId, worktreeId, chatId, delegationId } =
    DELEGATION_LOG_FIXTURE;
  const name = createHash('sha256')
    .update(delegationId)
    .digest('hex')
    .slice(0, 32);
  return path.join(
    userDataDir,
    'workspaces',
    workspaceId,
    'chat-storage-v2',
    worktreeId,
    'transcripts',
    'delegations',
    chatId,
    `${name}.1.jsonl`,
  );
}

/**
 * Writes the delegate log in its on-disk form (one versioned item a line).
 * Chat storage is rebuilt from the seeded chat on its first load, which
 * replaces anything written there before, so call this once the worktree's
 * chats have loaded.
 */
export function writeDelegationLog(userDataDir) {
  const file = delegationLogPath(userDataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    childItems()
      .map((item) => `${JSON.stringify({ v: 1, item })}\n`)
      .join(''),
    'utf8',
  );
  return file;
}
