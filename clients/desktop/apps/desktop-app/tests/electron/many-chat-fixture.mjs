import { createHash } from 'node:crypto';
import path from 'node:path';

export const MANY_CHAT_RESIDENCY = Object.freeze({
  workspaceId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
  seed: 'many-chat-residency-v1',
  chatCount: 30,
  rowsPerChat: 360,
  // Inline outputs stay under the 64 KiB artifact threshold, so the renderer
  // holds them in full: about 1 MB per chat, as field chats are.
  shortToolOutputBytes: 32_768,
  longToolOutputBytes: 49_152,
  longToolOutputCount: 6,
  shortToolOutputCount: 24,
});

export const MANY_CHAT_RESIDENCY_STREAM_CHAT_COUNT = 12;
export const MANY_CHAT_RESIDENCY_CHAT_PREFIX = 'many-chat-residency-';
export const MANY_CHAT_RESIDENCY_RENDER_MARKER = 'MANY_CHAT_RESIDENCY_READY';

const MANY_CHAT_TIMESTAMP = Date.parse('2026-10-01T12:00:00.000Z');
// One tool result every 12 rows; the last ones carry the long outputs.
const MANY_CHAT_TOOL_ROWS = Object.freeze(
  Array.from(
    {
      length:
        MANY_CHAT_RESIDENCY.shortToolOutputCount +
        MANY_CHAT_RESIDENCY.longToolOutputCount,
    },
    (_, index) => 6 + index * 12,
  ),
);

function stableText(seed, chatOrdinal, rowOrdinal, size) {
  const prefix = `${seed}:chat-${String(chatOrdinal).padStart(2, '0')}:row-${String(rowOrdinal).padStart(3, '0')}:`;
  const unit = `${prefix} deterministic retained tool output evidence\n`;
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

function buildChatMessages(seed, chatOrdinal) {
  const chatId = `${MANY_CHAT_RESIDENCY_CHAT_PREFIX}${String(chatOrdinal).padStart(2, '0')}`;
  const outputSizes = new Map(
    MANY_CHAT_TOOL_ROWS.map((row, index) => [
      row,
      index >= MANY_CHAT_RESIDENCY.shortToolOutputCount
        ? MANY_CHAT_RESIDENCY.longToolOutputBytes
        : MANY_CHAT_RESIDENCY.shortToolOutputBytes,
    ]),
  );

  return Array.from({ length: MANY_CHAT_RESIDENCY.rowsPerChat }, (_, index) => {
    const id = `${chatId}-row-${String(index).padStart(3, '0')}`;
    const timestamp = MANY_CHAT_TIMESTAMP + chatOrdinal * 10_000 + index;
    const outputBytes = outputSizes.get(index);
    if (outputBytes !== undefined) {
      const toolUseId = `${id}-tool`;
      const toolName = 'GetScriptOutput';
      return {
        id,
        role: 'system',
        timestamp,
        blocks: [
          {
            type: 'tool_use',
            toolUseId,
            toolName,
            input: JSON.stringify({ scriptId: `${chatId}-output-${index}` }),
          },
          {
            type: 'tool_result',
            toolUseId,
            toolName,
            output: stableText(seed, chatOrdinal, index, outputBytes),
            isError: false,
          },
        ],
      };
    }

    const role = index === 0 || index % 45 === 0 ? 'user' : 'assistant';
    const text =
      index === MANY_CHAT_RESIDENCY.rowsPerChat - 1
        ? `${MANY_CHAT_RESIDENCY_RENDER_MARKER} ${chatId} transcript rendered from canonical storage.`
        : `${seed} ${chatId} transcript row ${index}: preserve the conversation's ordered request, response, and retained context.`;
    return {
      id,
      role,
      timestamp,
      blocks: [{ type: 'text', text }],
    };
  });
}

/** Build the fixed-size canonical transcript corpus and a content digest. */
export function buildManyChatResidencyFixture(seed = MANY_CHAT_RESIDENCY.seed) {
  if (typeof seed !== 'string' || seed.trim() === '') {
    throw new TypeError('many-chat residency seed must be a non-empty string');
  }

  const digest = createHash('sha256');
  const chats = Array.from(
    { length: MANY_CHAT_RESIDENCY.chatCount },
    (_, index) => {
      const ordinal = index + 1;
      const id = `${MANY_CHAT_RESIDENCY_CHAT_PREFIX}${String(ordinal).padStart(2, '0')}`;
      const messages = buildChatMessages(seed, ordinal);
      digest.update(JSON.stringify({ id, messages }));
      return {
        id,
        title: `Residency chat ${String(ordinal).padStart(2, '0')}`,
        renderMarker: `${MANY_CHAT_RESIDENCY_RENDER_MARKER} ${id} transcript rendered from canonical storage.`,
        messages,
      };
    },
  );

  return {
    seed,
    chats,
    dimensions: {
      chatCount: chats.length,
      rowsPerChat: MANY_CHAT_RESIDENCY.rowsPerChat,
      shortToolOutputBytes: MANY_CHAT_RESIDENCY.shortToolOutputBytes,
      shortToolOutputCount: MANY_CHAT_RESIDENCY.shortToolOutputCount,
      longToolOutputBytes: MANY_CHAT_RESIDENCY.longToolOutputBytes,
      longToolOutputCount: MANY_CHAT_RESIDENCY.longToolOutputCount,
    },
    fixtureDigest: digest.digest('hex'),
  };
}

/**
 * Seed the single worktree's fixed transcript corpus straight into canonical
 * ChatStorageV2 before the performance runner launches Electron.
 */
export async function seedManyChatResidencyFixture(userDataDir) {
  if (typeof userDataDir !== 'string' || userDataDir.trim() === '') {
    throw new TypeError('seedManyChatResidencyFixture requires userDataDir');
  }

  const fixture = buildManyChatResidencyFixture();
  const workspaceRoot = path.join(
    userDataDir,
    'workspaces',
    MANY_CHAT_RESIDENCY.workspaceId,
  );
  const { require: tsRequire } = await import('tsx/cjs/api');
  const { ChatStorageV2 } = tsRequire(
    '../../src/main/lib/chat-storage-v2.ts',
    import.meta.url,
  );
  const storage = new ChatStorageV2(
    workspaceRoot,
    MANY_CHAT_RESIDENCY.worktreeId,
  );
  const createdAt = '2026-10-01T12:00:00.000Z';
  await storage.migrate(async () => ({
    revision: 1,
    index: {
      activeTabId: fixture.chats[0].id,
      runtimeByChatId: {},
    },
    recovery: {
      receipts: [],
      mutationIds: [],
      removedTabIds: [],
      removedArchiveEntryIds: [],
      removedMessageIds: [],
    },
    chats: (async function* () {
      for (const chat of fixture.chats) {
        yield {
          metadata: {
            id: chat.id,
            title: chat.title,
            createdAt,
            kind: 'chat',
            providerType: 'claude',
            model: 'claude-sonnet-4-6',
            approvalMode: 'full-access',
          },
          messages: (async function* () {
            yield* chat.messages;
          })(),
        };
      }
    })(),
  }));

  return {
    workspaceId: MANY_CHAT_RESIDENCY.workspaceId,
    worktreeId: MANY_CHAT_RESIDENCY.worktreeId,
    seed: fixture.seed,
    chats: fixture.chats.map(({ id, title, renderMarker }) => ({
      id,
      title,
      renderMarker,
    })),
    dimensions: fixture.dimensions,
    fixtureDigest: fixture.fixtureDigest,
  };
}
