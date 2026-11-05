import { createHash } from 'node:crypto';
import path from 'node:path';

export const SCOPE_RESIDENCY = Object.freeze({
  workspaceId: 'demo-ts-pnpm-vite',
  seed: 'scope-residency-v1',
  worktreeCount: 12,
  chatsPerWorktree: 3,
  rowsPerChat: 240,
  toolOutputBytes: 32_768,
  toolOutputCountPerChat: 12,
  renderMarkerPrefix: 'SCOPE_RESIDENCY_READY',
});

const SCOPE_RESIDENCY_TIMESTAMP = Date.parse('2026-10-01T12:00:00.000Z');
const SCOPE_RESIDENCY_TOOL_ROW_INTERVAL = 18;
const SCOPE_RESIDENCY_TOOL_ROW_START = 8;
const SCOPE_RESIDENCY_CREATED_AT = '2026-10-01T12:00:00.000Z';

// This is pinned by tests/performance/scope-residency-fixture.test.mjs.
export const SCOPE_RESIDENCY_FIXTURE_DIGEST =
  '6236ca4c1b89899fc9143718ba7fb9ca2a0867291ce61c4f96655edc47b6b2f8';

export function scopeResidencyWorktreeIds(
  count = SCOPE_RESIDENCY.worktreeCount,
) {
  if (!Number.isInteger(count) || count < 1) {
    throw new TypeError(
      'scope residency worktree count must be a positive integer',
    );
  }

  return Array.from(
    { length: count },
    (_, index) => `perf-existing-${String(index + 1).padStart(3, '0')}`,
  );
}

function scopeResidencyTextRow({
  seed,
  worktreeId,
  chatId,
  rowIndex,
  role = 'assistant',
  text,
}) {
  return {
    id: `${chatId}-row-${String(rowIndex).padStart(3, '0')}`,
    role,
    timestamp: SCOPE_RESIDENCY_TIMESTAMP + rowIndex,
    blocks: [
      {
        type: 'text',
        text:
          text ??
          `${seed} ${worktreeId} ${chatId} transcript row ${rowIndex}: retained deterministic scope residency evidence.`,
      },
    ],
  };
}

function scopeResidencyBaseRow({
  seed,
  worktreeId,
  chatId,
  rowIndex,
  toolOutputIndex,
}) {
  const id = `${chatId}-row-${String(rowIndex).padStart(3, '0')}`;
  const timestamp = SCOPE_RESIDENCY_TIMESTAMP + rowIndex;
  if (toolOutputIndex !== undefined) {
    const toolUseId = `${id}-tool`;
    const toolName = 'GetScriptOutput';
    const unit = `${seed}:${worktreeId}:${chatId}:row-${String(rowIndex).padStart(3, '0')}: deterministic retained tool output evidence\n`;
    const output = unit
      .repeat(Math.ceil(SCOPE_RESIDENCY.toolOutputBytes / unit.length))
      .slice(0, SCOPE_RESIDENCY.toolOutputBytes);
    return {
      id,
      role: 'system',
      timestamp,
      blocks: [
        {
          type: 'tool_use',
          toolUseId,
          toolName,
          input: JSON.stringify({
            scriptId: `${chatId}-output-${toolOutputIndex}`,
          }),
        },
        {
          type: 'tool_result',
          toolUseId,
          toolName,
          output,
          isError: false,
        },
      ],
    };
  }

  if (rowIndex === SCOPE_RESIDENCY.rowsPerChat - 1) {
    const renderMarker = `${SCOPE_RESIDENCY.renderMarkerPrefix} ${worktreeId} ${chatId} transcript rendered from canonical storage.`;
    return scopeResidencyTextRow({
      seed,
      worktreeId,
      chatId,
      rowIndex,
      text: renderMarker,
    });
  }

  return scopeResidencyTextRow({
    seed,
    worktreeId,
    chatId,
    rowIndex,
    role: rowIndex === 0 || rowIndex % 60 === 0 ? 'user' : 'assistant',
  });
}

function* iterateScopeResidencyRows(seed, worktreeId, chatId) {
  const toolOutputRows = new Map(
    Array.from(
      { length: SCOPE_RESIDENCY.toolOutputCountPerChat },
      (_, index) => [
        SCOPE_RESIDENCY_TOOL_ROW_START +
          index * SCOPE_RESIDENCY_TOOL_ROW_INTERVAL,
        index + 1,
      ],
    ),
  );

  for (
    let rowIndex = 0;
    rowIndex < SCOPE_RESIDENCY.rowsPerChat;
    rowIndex += 1
  ) {
    yield scopeResidencyBaseRow({
      seed,
      worktreeId,
      chatId,
      rowIndex,
      toolOutputIndex: toolOutputRows.get(rowIndex),
    });
  }
}

function buildScopeResidencyChatMessages(seed, worktreeId, chatId) {
  return [...iterateScopeResidencyRows(seed, worktreeId, chatId)];
}

/** Build the deterministic per-worktree transcript corpus and its digest. */
export function buildScopeResidencyFixture({
  seed = SCOPE_RESIDENCY.seed,
  worktreeIds = scopeResidencyWorktreeIds(),
} = {}) {
  if (typeof seed !== 'string' || seed.trim() === '') {
    throw new TypeError('scope residency seed must be a non-empty string');
  }
  if (
    !Array.isArray(worktreeIds) ||
    worktreeIds.length === 0 ||
    worktreeIds.some(
      (worktreeId) =>
        typeof worktreeId !== 'string' || worktreeId.trim() === '',
    ) ||
    new Set(worktreeIds).size !== worktreeIds.length
  ) {
    throw new TypeError(
      'scope residency worktreeIds must be a non-empty array of unique ids',
    );
  }

  const digest = createHash('sha256');
  const worktrees = worktreeIds.map((worktreeId) => {
    const chats = Array.from(
      { length: SCOPE_RESIDENCY.chatsPerWorktree },
      (_, chatIndex) => {
        const ordinal = chatIndex + 1;
        const id = `scope-residency-${worktreeId}-chat-${String(ordinal).padStart(2, '0')}`;
        const messages = buildScopeResidencyChatMessages(seed, worktreeId, id);
        const renderMarker = `${SCOPE_RESIDENCY.renderMarkerPrefix} ${worktreeId} ${id} transcript rendered from canonical storage.`;
        return {
          id,
          title: `Scope residency ${worktreeId} chat ${String(ordinal).padStart(2, '0')}`,
          renderMarker,
          messages,
        };
      },
    );
    digest.update(
      JSON.stringify({
        worktreeId,
        chats: chats.map(({ id, messages }) => ({ id, messages })),
      }),
    );
    return {
      worktreeId,
      activeChatId: chats[0].id,
      chats,
    };
  });

  const chatCount = worktrees.reduce(
    (total, worktree) => total + worktree.chats.length,
    0,
  );
  return {
    seed,
    worktrees,
    dimensions: {
      worktreeCount: worktrees.length,
      chatsPerWorktree: SCOPE_RESIDENCY.chatsPerWorktree,
      chatCount,
      rowsPerChat: SCOPE_RESIDENCY.rowsPerChat,
      totalRows: chatCount * SCOPE_RESIDENCY.rowsPerChat,
      toolOutputBytes: SCOPE_RESIDENCY.toolOutputBytes,
      toolOutputCountPerChat: SCOPE_RESIDENCY.toolOutputCountPerChat,
      toolOutputBytesPerWorktree:
        SCOPE_RESIDENCY.toolOutputBytes *
        SCOPE_RESIDENCY.toolOutputCountPerChat *
        SCOPE_RESIDENCY.chatsPerWorktree,
    },
    fixtureDigest: digest.digest('hex'),
  };
}

/** Seed each scope directly into canonical ChatStorageV2 before Electron launch. */
export async function seedScopeResidencyFixture(
  userDataDir,
  { worktreeIds = scopeResidencyWorktreeIds() } = {},
) {
  if (typeof userDataDir !== 'string' || userDataDir.trim() === '') {
    throw new TypeError('seedScopeResidencyFixture requires userDataDir');
  }

  const fixture = buildScopeResidencyFixture({
    seed: SCOPE_RESIDENCY.seed,
    worktreeIds,
  });
  const workspaceRoot = path.join(
    userDataDir,
    'workspaces',
    SCOPE_RESIDENCY.workspaceId,
  );
  const { require: tsRequire } = await import('tsx/cjs/api');
  const { ChatStorageV2 } = tsRequire(
    '../../src/main/lib/chat-storage-v2.ts',
    import.meta.url,
  );

  for (const worktree of fixture.worktrees) {
    const storage = new ChatStorageV2(workspaceRoot, worktree.worktreeId);
    await storage.migrate(async () => ({
      revision: 1,
      index: {
        activeTabId: worktree.activeChatId,
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
        for (const chat of worktree.chats) {
          yield {
            metadata: {
              id: chat.id,
              title: chat.title,
              createdAt: SCOPE_RESIDENCY_CREATED_AT,
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
  }

  return {
    workspaceId: SCOPE_RESIDENCY.workspaceId,
    seed: fixture.seed,
    worktrees: fixture.worktrees.map(({ worktreeId, activeChatId, chats }) => ({
      worktreeId,
      activeChatId,
      chats: chats.map(({ id, title, renderMarker }) => ({
        id,
        title,
        renderMarker,
      })),
    })),
    dimensions: fixture.dimensions,
    fixtureDigest: fixture.fixtureDigest,
  };
}
