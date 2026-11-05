import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { seedCoworkWorkspace } from './seeders/seedCoworkWorkspace.mjs';

export const LAB_TRANSCRIPT_WORKSPACE_ID = 'cowork-default';
export const LAB_TRANSCRIPT_ENTRY_ID = 'entry-lab-transcript';
export const LAB_TRANSCRIPT_CHAT_ID = 'lab-transcript-large-chat';
export const LAB_TRANSCRIPT_LEAN_ID = 'lab-transcript-lean';
export const LAB_TRANSCRIPT_MESSAGE_COUNT = 80_000;
export const LAB_TRANSCRIPT_BYTES = 130_000_000;
export const LAB_TRANSCRIPT_MANIFEST_VERSION = 2;
export const LAB_TRANSCRIPT_FROZEN_TIMESTAMP = Date.parse(
  '2026-10-13T12:00:00.000Z',
);
export const LAB_TRANSCRIPT_CREATED_AT = new Date(
  LAB_TRANSCRIPT_FROZEN_TIMESTAMP,
).toISOString();
// Card rows use the production card message id, `delegated-agent-<delegationId>`.
export const LAB_TRANSCRIPT_LEGACY_CARD_MESSAGE_ID =
  'delegated-agent-lab-transcript-legacy-delegation';
export const LAB_TRANSCRIPT_STREAM_CARD_MESSAGE_ID =
  'delegated-agent-lab-transcript-stream-delegation';
export const LAB_TRANSCRIPT_PARENT_TURN_ID = 'lab-transcript-parent-turn';
export const LAB_TRANSCRIPT_OLDEST_PARENT_TURN_ID =
  'lab-transcript-oldest-parent-turn';
export const LAB_TRANSCRIPT_OLDEST_LEGACY_CARD_MESSAGE_ID =
  'delegated-agent-lab-transcript-oldest-legacy-delegation';
export const LAB_TRANSCRIPT_OLDEST_STREAM_CARD_MESSAGE_ID =
  'delegated-agent-lab-transcript-oldest-stream-delegation';
export const LAB_TRANSCRIPT_LEGACY_DELEGATION_ID =
  'lab-transcript-legacy-delegation';
export const LAB_TRANSCRIPT_STREAM_DELEGATION_ID =
  'lab-transcript-stream-delegation';
export const LAB_TRANSCRIPT_OLDEST_LEGACY_DELEGATION_ID =
  'lab-transcript-oldest-legacy-delegation';
export const LAB_TRANSCRIPT_OLDEST_STREAM_DELEGATION_ID =
  'lab-transcript-oldest-stream-delegation';
export const LAB_TRANSCRIPT_LEGACY_SENTINEL =
  'LAB_TRANSCRIPT_LEGACY_CARD_SENTINEL';
export const LAB_TRANSCRIPT_STREAM_SENTINEL =
  'LAB_TRANSCRIPT_STREAM_CARD_SENTINEL';
export const LAB_TRANSCRIPT_OLDEST_LEGACY_SENTINEL =
  'LAB_TRANSCRIPT_OLDEST_LEGACY_CARD_SENTINEL';
export const LAB_TRANSCRIPT_OLDEST_STREAM_SENTINEL =
  'LAB_TRANSCRIPT_OLDEST_STREAM_CARD_SENTINEL';

// This is pinned by tests/performance/lab-transcript-fixture.test.mjs.
export const LAB_TRANSCRIPT_FIXTURE_DIGEST =
  'b9fd1fa13d2167557dfc291310e73126ad92fc3af587e1298765598722b8429f';

export const LAB_TRANSCRIPT = Object.freeze({
  workspaceId: LAB_TRANSCRIPT_WORKSPACE_ID,
  entryId: LAB_TRANSCRIPT_ENTRY_ID,
  chatId: LAB_TRANSCRIPT_CHAT_ID,
  leanId: LAB_TRANSCRIPT_LEAN_ID,
  fixtureDigest: LAB_TRANSCRIPT_FIXTURE_DIGEST,
  messageCount: LAB_TRANSCRIPT_MESSAGE_COUNT,
  transcriptBytes: LAB_TRANSCRIPT_BYTES - 1,
  canonicalSeedBytes: LAB_TRANSCRIPT_BYTES,
  manifestVersion: LAB_TRANSCRIPT_MANIFEST_VERSION,
});

const SPEC_FILE_NAME = 'lab-transcript-stream-fixture.json';
const WORKSPACE_NAME = 'Lab Transcript';

function routeSnapshot() {
  return {
    selectedModelId: 'sonnet',
    selectedModelLabel: 'Claude Sonnet',
    runtimeModelId: 'claude-sonnet-4-6',
    runtimeModelLabel: 'Claude Sonnet 4.6',
    harnessId: 'claude',
    runtimeKind: 'local-sdk',
    runnerRegistrationId: 'claude-local',
    runtimeVersion: '1',
    adapterVersion: '1',
    modelSource: 'test',
    providerType: 'test',
    assignmentRevision: 'a1',
    billingAuthority: 'native',
    aiCreditsRouted: false,
    capabilities: ['read'],
    supportedThinkingLevels: ['low'],
    capabilitySnapshotHash: 'c1',
    capabilityGeneration: 1,
    policyRevision: 'p1',
  };
}

function cardDefinition({
  delegationId,
  store,
  status,
  description,
  prompt,
  parentTurnId = LAB_TRANSCRIPT_PARENT_TURN_ID,
}) {
  return {
    type: 'delegated_agent_call',
    delegationId,
    agentBlockId: `delegated-agent-${delegationId}`,
    runGeneration: 1,
    status,
    outputTruncated: false,
    transcriptStore: store,
    sequence: 1,
    parentHarnessId: 'claude',
    parentTurnId,
    parentToolCallId: `spawn-${delegationId}`,
    selectedModelId: 'sonnet',
    runtimeModelId: 'claude-sonnet-4-6',
    targetHarnessId: 'claude',
    routeSnapshot: routeSnapshot(),
    description,
    prompt,
    executionMode: 'background',
    createdAt: LAB_TRANSCRIPT_FROZEN_TIMESTAMP,
  };
}

function legacyCardMessage({ oldest = false } = {}) {
  return {
    id: oldest
      ? LAB_TRANSCRIPT_OLDEST_LEGACY_CARD_MESSAGE_ID
      : LAB_TRANSCRIPT_LEGACY_CARD_MESSAGE_ID,
    role: 'assistant',
    timestamp: oldest
      ? LAB_TRANSCRIPT_FROZEN_TIMESTAMP + 1
      : LAB_TRANSCRIPT_FROZEN_TIMESTAMP + LAB_TRANSCRIPT_MESSAGE_COUNT - 2,
    blocks: [
      cardDefinition({
        delegationId: oldest
          ? LAB_TRANSCRIPT_OLDEST_LEGACY_DELEGATION_ID
          : LAB_TRANSCRIPT_LEGACY_DELEGATION_ID,
        store: 'chat-log-v1',
        status: oldest ? 'completed' : 'running',
        description: oldest
          ? LAB_TRANSCRIPT_OLDEST_LEGACY_SENTINEL
          : LAB_TRANSCRIPT_LEGACY_SENTINEL,
        prompt: 'Retain the legacy status card in the bulk parent transcript.',
        parentTurnId: oldest
          ? LAB_TRANSCRIPT_OLDEST_PARENT_TURN_ID
          : LAB_TRANSCRIPT_PARENT_TURN_ID,
      }),
    ],
  };
}

function streamCardMessage({ oldest = false } = {}) {
  return {
    id: oldest
      ? LAB_TRANSCRIPT_OLDEST_STREAM_CARD_MESSAGE_ID
      : LAB_TRANSCRIPT_STREAM_CARD_MESSAGE_ID,
    role: 'assistant',
    timestamp: oldest
      ? LAB_TRANSCRIPT_FROZEN_TIMESTAMP + 2
      : LAB_TRANSCRIPT_FROZEN_TIMESTAMP + LAB_TRANSCRIPT_MESSAGE_COUNT - 1,
    blocks: [
      cardDefinition({
        delegationId: oldest
          ? LAB_TRANSCRIPT_OLDEST_STREAM_DELEGATION_ID
          : LAB_TRANSCRIPT_STREAM_DELEGATION_ID,
        store: 'chat-stream-v2',
        status: oldest ? 'completed' : 'pending',
        description: oldest
          ? LAB_TRANSCRIPT_OLDEST_STREAM_SENTINEL
          : LAB_TRANSCRIPT_STREAM_SENTINEL,
        prompt: 'Retain the stream card anchor in the bulk parent transcript.',
        parentTurnId: oldest
          ? LAB_TRANSCRIPT_OLDEST_PARENT_TURN_ID
          : LAB_TRANSCRIPT_PARENT_TURN_ID,
      }),
    ],
  };
}

function textRow(index, textLength, role = 'assistant') {
  const id = `lab-transcript-row-${String(index).padStart(6, '0')}`;
  const prefix = `lab-transcript-row-${String(index).padStart(6, '0')}-retained-evidence `;
  const text = prefix
    .repeat(Math.ceil(textLength / prefix.length))
    .slice(0, textLength);
  return {
    id,
    role,
    timestamp: LAB_TRANSCRIPT_FROZEN_TIMESTAMP + index,
    blocks: [{ type: 'text', text }],
  };
}

function emptyTextRow(index) {
  return textRow(index, 0);
}

function userTurnMessage() {
  return {
    id: LAB_TRANSCRIPT_PARENT_TURN_ID,
    role: 'user',
    timestamp:
      LAB_TRANSCRIPT_FROZEN_TIMESTAMP + LAB_TRANSCRIPT_MESSAGE_COUNT - 3,
    blocks: [
      {
        type: 'text',
        text: 'Please update both retained delegation cards in this large chat.',
      },
    ],
  };
}

function oldestUserTurnMessage() {
  return {
    id: LAB_TRANSCRIPT_OLDEST_PARENT_TURN_ID,
    role: 'user',
    timestamp: LAB_TRANSCRIPT_FROZEN_TIMESTAMP,
    blocks: [
      { type: 'text', text: 'Review the oldest retained delegation cards.' },
    ],
  };
}

function baseRow(index) {
  if (index === 0) return oldestUserTurnMessage();
  if (index === 1) return legacyCardMessage({ oldest: true });
  if (index === 2) return streamCardMessage({ oldest: true });
  if (index === LAB_TRANSCRIPT_MESSAGE_COUNT - 3) return userTurnMessage();
  if (index === LAB_TRANSCRIPT_MESSAGE_COUNT - 2) return legacyCardMessage();
  if (index === LAB_TRANSCRIPT_MESSAGE_COUNT - 1) return streamCardMessage();
  if (index % 1_000 === 0) return textRow(index, 0, 'user');
  return emptyTextRow(index);
}

function textBytesPerRow() {
  let emptyRowBytes = 0;
  for (let index = 0; index < LAB_TRANSCRIPT_MESSAGE_COUNT; index += 1)
    emptyRowBytes += Buffer.byteLength(JSON.stringify(baseRow(index)), 'utf8');

  // The canonical digest covers a JSON array. Include its brackets and commas
  // in the sizing budget; committed JSONL bytes are measured after migration.
  const punctuationBytes = LAB_TRANSCRIPT_MESSAGE_COUNT + 1;
  const remaining = LAB_TRANSCRIPT_BYTES - emptyRowBytes - punctuationBytes;
  const textRows = LAB_TRANSCRIPT_MESSAGE_COUNT - 6;
  if (remaining < textRows)
    throw new Error('Lab transcript byte budget cannot fit its row skeleton');
  return {
    rowTextBytes: Math.floor(remaining / textRows),
    longTextRows: remaining % textRows,
  };
}

export function* iterateLabTranscriptRows() {
  const budget = textBytesPerRow();
  let textOrdinal = 0;
  for (let index = 0; index < LAB_TRANSCRIPT_MESSAGE_COUNT; index += 1) {
    if (index < 3 || index >= LAB_TRANSCRIPT_MESSAGE_COUNT - 3) {
      yield baseRow(index);
      continue;
    }
    const extra = textOrdinal < budget.longTextRows ? 1 : 0;
    const role = index % 1_000 === 0 ? 'user' : 'assistant';
    yield textRow(index, budget.rowTextBytes + extra, role);
    textOrdinal += 1;
  }
}

function canonicalTranscriptMeasurement() {
  const hash = createHash('sha256');
  hash.update('[');
  let first = true;
  let messageCount = 0;
  let canonicalSeedBytes = 2;
  let transcriptBytes = 0;
  let legacyCardCount = 0;
  let streamCardCount = 0;

  for (const row of iterateLabTranscriptRows()) {
    if (!first) {
      hash.update(',');
      canonicalSeedBytes += 1;
    }
    const serialized = JSON.stringify(row);
    hash.update(serialized);
    const rowBytes = Buffer.byteLength(serialized, 'utf8');
    canonicalSeedBytes += rowBytes;
    transcriptBytes += rowBytes + 1;
    first = false;
    messageCount += 1;
    for (const block of row.blocks) {
      if (block.type !== 'delegated_agent_call') continue;
      if (block.transcriptStore === 'chat-log-v1') legacyCardCount += 1;
      if (block.transcriptStore === 'chat-stream-v2') streamCardCount += 1;
    }
  }
  hash.update(']');

  return {
    fixtureDigest: hash.digest('hex'),
    messageCount,
    transcriptBytes,
    canonicalSeedBytes,
    cardMix: { legacy: legacyCardCount, stream: streamCardCount },
  };
}

export function measureLabTranscriptSeed() {
  return canonicalTranscriptMeasurement();
}

async function loadChatStorageV2() {
  const { require: tsRequire } = await import('tsx/cjs/api');
  return tsRequire('../../src/main/lib/chat-storage-v2.ts', import.meta.url)
    .ChatStorageV2;
}

async function writeChatHistoryMeta(workspaceDir, chatId, title, messageCount) {
  const directory = path.join(workspaceDir, 'chat-history', chatId);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'meta.json'),
    JSON.stringify({
      version: 1,
      id: chatId,
      title,
      description: title,
      createdAt: LAB_TRANSCRIPT_CREATED_AT,
      messageCount,
      lastMessageAt: LAB_TRANSCRIPT_CREATED_AT,
      providerType: 'claude',
      archived: false,
    }),
  );
}

/**
 * Seed a frozen 80k-row Cowork Work Entry transcript before the timed launch.
 * The bulk rows are migrated directly through ChatStorageV2; the Electron
 * process later adds the stream descriptor and child rows through its normal
 * production ChatStateService methods.
 */
export async function seedLabTranscript(userDataDir) {
  if (typeof userDataDir !== 'string' || userDataDir.trim() === '')
    throw new TypeError('seedLabTranscript requires a userDataDir');

  const workspace = seedCoworkWorkspace({
    userDataDir,
    workspaceId: LAB_TRANSCRIPT_WORKSPACE_ID,
    name: WORKSPACE_NAME,
    chatId: 'lab-transcript-home-chat',
    chatTitle: 'Lab transcript home',
    providerType: 'claude',
    seedMessage: false,
  });
  const workspaceDir = path.join(
    userDataDir,
    'workspaces',
    workspace.workspaceId,
  );
  await writeFile(
    path.join(workspaceDir, 'work-entries.json'),
    JSON.stringify({
      version: 1,
      entries: [
        {
          id: LAB_TRANSCRIPT_ENTRY_ID,
          createdAt: LAB_TRANSCRIPT_CREATED_AT,
        },
      ],
    }),
  );

  const ChatStorageV2 = await loadChatStorageV2();
  const storage = new ChatStorageV2(workspaceDir, LAB_TRANSCRIPT_ENTRY_ID);
  const digest = createHash('sha256');
  const measurement = {
    messageCount: 0,
    canonicalSeedBytes: 2,
    transcriptBytes: 0,
    cardMix: { legacy: 0, stream: 0 },
  };
  let first = true;
  const rows = async function* () {
    digest.update('[');
    for (const row of iterateLabTranscriptRows()) {
      if (!first) {
        digest.update(',');
        measurement.canonicalSeedBytes += 1;
      }
      const serialized = JSON.stringify(row);
      digest.update(serialized);
      const rowBytes = Buffer.byteLength(serialized, 'utf8');
      measurement.canonicalSeedBytes += rowBytes;
      measurement.transcriptBytes += rowBytes + 1;
      first = false;
      measurement.messageCount += 1;
      for (const block of row.blocks) {
        if (block.type !== 'delegated_agent_call') continue;
        if (block.transcriptStore === 'chat-log-v1')
          measurement.cardMix.legacy += 1;
        if (block.transcriptStore === 'chat-stream-v2')
          measurement.cardMix.stream += 1;
      }
      yield row;
    }
    digest.update(']');
  };
  await storage.migrate(async () => ({
    revision: 1,
    index: {
      activeTabId: LAB_TRANSCRIPT_CHAT_ID,
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
      yield {
        metadata: {
          id: LAB_TRANSCRIPT_CHAT_ID,
          title: '80k-row lab transcript',
          description: 'Deterministic 80k-row transcript fixture',
          createdAt: LAB_TRANSCRIPT_CREATED_AT,
          providerType: 'claude',
          model: 'claude-sonnet-4-6',
        },
        messages: rows(),
      };
      yield {
        metadata: {
          id: LAB_TRANSCRIPT_LEAN_ID,
          title: 'Lean sibling chat',
          description: 'Small sibling for foreground visibility checks',
          createdAt: LAB_TRANSCRIPT_CREATED_AT,
          providerType: 'claude',
          model: 'claude-sonnet-4-6',
        },
        messages: (async function* () {
          yield {
            id: 'lab-transcript-lean-message',
            role: 'assistant',
            timestamp: LAB_TRANSCRIPT_FROZEN_TIMESTAMP,
            blocks: [{ type: 'text', text: 'Lean sibling remains available.' }],
          };
        })(),
      };
    })(),
  }));
  await writeChatHistoryMeta(
    workspaceDir,
    LAB_TRANSCRIPT_CHAT_ID,
    '80k-row lab transcript',
    LAB_TRANSCRIPT_MESSAGE_COUNT,
  );
  await writeChatHistoryMeta(
    workspaceDir,
    LAB_TRANSCRIPT_LEAN_ID,
    'Lean sibling chat',
    1,
  );

  const fixtureDigest = digest.digest('hex');
  const indexes = await storage.indexes();
  const persistedDescriptor = indexes.live.tabs.find(
    (tab) => tab.id === LAB_TRANSCRIPT_CHAT_ID,
  )?.transcript;
  if (!persistedDescriptor)
    throw new Error('Lab transcript ChatStorageV2 descriptor is missing');
  const transcriptBytes = persistedDescriptor.committedByteLength;
  const specPath = path.join(userDataDir, SPEC_FILE_NAME);
  await writeFile(
    specPath,
    JSON.stringify({
      version: 1,
      projectId: LAB_TRANSCRIPT_WORKSPACE_ID,
      worktreeId: LAB_TRANSCRIPT_ENTRY_ID,
      chatId: LAB_TRANSCRIPT_CHAT_ID,
      scenario: 'lab-transcript',
    }),
  );

  if (
    fixtureDigest !== LAB_TRANSCRIPT_FIXTURE_DIGEST ||
    measurement.messageCount !== LAB_TRANSCRIPT_MESSAGE_COUNT ||
    measurement.canonicalSeedBytes !== LAB_TRANSCRIPT_BYTES ||
    measurement.transcriptBytes !== transcriptBytes ||
    measurement.cardMix.legacy !== 2 ||
    measurement.cardMix.stream !== 2
  )
    throw new Error('Lab transcript canonical seed dimensions changed');

  return {
    workspaceId: LAB_TRANSCRIPT_WORKSPACE_ID,
    entryId: LAB_TRANSCRIPT_ENTRY_ID,
    chatId: LAB_TRANSCRIPT_CHAT_ID,
    leanId: LAB_TRANSCRIPT_LEAN_ID,
    fixtureDigest,
    messageCount: measurement.messageCount,
    transcriptBytes,
    canonicalSeedBytes: measurement.canonicalSeedBytes,
    manifestVersion: LAB_TRANSCRIPT_MANIFEST_VERSION,
    streamFixtureSpecPath: specPath,
    storageDirectory: storage.directory,
    manifestPath: storage.manifestPath,
  };
}
