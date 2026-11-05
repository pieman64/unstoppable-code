import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..');
const REPLAY_OUTPUT_BYTES = 512 * 1024 * 1024;

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

function scopeDirectory(workspaceRoot, scopeId) {
  return path.join(workspaceRoot, 'chat-storage-v2', scopeId);
}

function manifestPath(workspaceRoot, scopeId) {
  return path.join(workspaceRoot, 'chat-storage-manifests', `${scopeId}.json`);
}

/**
 * Version 2 keeps every commit in its files; version 3 adds a delta journal;
 * version 4 adds delegation streams and offloads large fields.
 */
function readManifest(workspaceRoot, scopeId) {
  const manifest = readJson(manifestPath(workspaceRoot, scopeId));
  assert.ok(
    manifest.version >= 2 && manifest.version <= 4,
    `Unsupported chat storage manifest version ${manifest.version}`,
  );
  assert.equal(manifest.scopeId, scopeId);
  return manifest;
}

/** Version 3 always has a journal; version 4 only until it is checkpointed. */
function journalOf(manifest) {
  return manifest.version === 3 || typeof manifest.journal === 'string';
}

function usesDeltaJournal(workspaceRoot, scopeId) {
  const file = manifestPath(workspaceRoot, scopeId);
  return existsSync(file) && journalOf(readManifest(workspaceRoot, scopeId));
}

let replayBundle;

/** Bundle the replay entry once per test process; the app sources are TypeScript. */
function replayBundlePath() {
  if (replayBundle) return replayBundle;
  const directory = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-e2e-chat-replay-'),
  );
  process.once('exit', () =>
    rmSync(directory, { recursive: true, force: true }),
  );
  const outfile = path.join(directory, 'replay.cjs');
  buildSync({
    entryPoints: [path.join(HERE, 'readChatStorageReplay.mjs')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    tsconfig: path.join(REPO_ROOT, 'tsconfig.base.json'),
    logLevel: 'silent',
  });
  replayBundle = outfile;
  return outfile;
}

/**
 * The committed state of a delta-journal scope: its checkpoint files with
 * every journal record applied, read through the app's own replay helper.
 * `chats` is a list of chat ids, or 'tabs' for every live chat tab.
 */
function replayDeltaJournalScope(workspaceRoot, scopeId, chats, streams = []) {
  const result = spawnSync(
    process.execPath,
    [
      replayBundlePath(),
      JSON.stringify({
        directory: scopeDirectory(workspaceRoot, scopeId),
        scopeId,
        chats,
        streams,
      }),
    ],
    { encoding: 'utf8', maxBuffer: REPLAY_OUTPUT_BYTES },
  );
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `Could not replay chat scope ${scopeId}: ${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

function assertIndexVersions({ live, archive }) {
  assert.equal(live.version, 2);
  assert.equal(archive.version, 2);
  return { live, archive };
}

/** Inspect the durable chat storage independently of the app's in-memory state.
 * workspaceRoot is also the root of a retained archive container. Legacy
 * fixtures should still be seeded as v1 to exercise direct migration.
 */
export function readChatStorageIndexes(workspaceRoot, scopeId) {
  if (journalOf(readManifest(workspaceRoot, scopeId)))
    return assertIndexVersions(
      replayDeltaJournalScope(workspaceRoot, scopeId, []).indexes,
    );
  const directory = scopeDirectory(workspaceRoot, scopeId);
  return assertIndexVersions({
    live: readJson(path.join(directory, 'live-index.json')),
    archive: readJson(path.join(directory, 'archive-index.json')),
  });
}

/** The durable mutation ids a scope retains for idempotent replay. */
export function readChatStorageMutationIds(workspaceRoot, scopeId) {
  const recovery = usesDeltaJournal(workspaceRoot, scopeId)
    ? replayDeltaJournalScope(workspaceRoot, scopeId, []).indexes.recovery
    : readJson(
        path.join(
          scopeDirectory(workspaceRoot, scopeId),
          'recovery-index.json',
        ),
      );
  assert.equal(recovery.version, 2);
  return recovery.mutationIds;
}

function readTranscriptFiles(workspaceRoot, scopeId, chatId) {
  const directory = path.join(
    scopeDirectory(workspaceRoot, scopeId),
    'transcripts',
  );
  const messages = readFileSync(path.join(directory, `${chatId}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const activePath = path.join(directory, `${chatId}.active.json`);
  if (existsSync(activePath)) {
    const committedIds = new Set(messages.map((message) => message.id));
    const rawActive = readFileSync(activePath, 'utf8');
    const activeVersion = /"version"\s*:\s*(\d+)/.exec(
      rawActive.slice(0, 1024),
    );
    const activeMessages =
      Number(activeVersion?.[1]) === 2
        ? rawActive
            .trimEnd()
            .split('\n')
            .slice(1)
            .map((row) => JSON.parse(row).message)
        : JSON.parse(rawActive).messages;
    messages.push(
      ...activeMessages.filter((message) => !committedIds.has(message.id)),
    );
  }
  return messages;
}

/**
 * The committed rows of one format 4 delegation stream, oldest first. A
 * checkpointed scope keeps them in the stream's files; otherwise the journal
 * may still hold some.
 */
export function readDelegationStreamRows(workspaceRoot, scopeId, target) {
  if (usesDeltaJournal(workspaceRoot, scopeId))
    return replayDeltaJournalScope(workspaceRoot, scopeId, [], [target])
      .streams[0];
  const directory = path.join(
    scopeDirectory(workspaceRoot, scopeId),
    'transcripts',
    'delegations',
    target.chatId,
    'v2',
  );
  if (!existsSync(directory)) return [];
  for (const name of readdirSync(directory)) {
    const descriptor = path.join(directory, name, 'descriptor.json');
    if (!existsSync(descriptor)) continue;
    const stream = readJson(descriptor).target;
    if (
      stream.delegationId === target.delegationId &&
      stream.runGeneration === target.runGeneration
    )
      return readFileSync(
        path.join(directory, name, 'transcript.jsonl'),
        'utf8',
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
  }
  return [];
}

export function readChatStorageMessages(workspaceRoot, scopeId, chatId) {
  if (usesDeltaJournal(workspaceRoot, scopeId))
    return replayDeltaJournalScope(workspaceRoot, scopeId, [chatId]).messages[
      chatId
    ];
  return readTranscriptFiles(workspaceRoot, scopeId, chatId);
}

/** Reassemble small test fixtures for assertions over complete message rows.
 * Large output artifacts stay referenced, just as they do in the JSONL.
 */
export function readChatStorageTabs(workspaceRoot, scopeId) {
  if (journalOf(readManifest(workspaceRoot, scopeId))) {
    const { indexes, messages } = replayDeltaJournalScope(
      workspaceRoot,
      scopeId,
      'tabs',
    );
    const { live } = assertIndexVersions(indexes);
    return {
      ...live,
      tabs: live.tabs.map((tab) => ({
        ...tab,
        messages: tab.kind === 'file' ? [] : messages[tab.id],
      })),
    };
  }
  const { live } = readChatStorageIndexes(workspaceRoot, scopeId);
  return {
    ...live,
    tabs: live.tabs.map((tab) => ({
      ...tab,
      messages:
        tab.kind === 'file'
          ? []
          : readTranscriptFiles(workspaceRoot, scopeId, tab.id),
    })),
  };
}
