#!/usr/bin/env node
/**
 * Content-free capture of a running installation's chat load, for replay by
 * `chat-storage-field-load.mjs`.
 *
 *   node apps/desktop-app/tests/performance/field-load-capture.mjs \
 *     --data-dir <app data directory> [--label NAME] [--window-ms 60000] \
 *     [--diagnostics-minutes 240] [--app-pid PID] [--output FILE]
 *
 * The capture reads the data directory and never writes to it. It records
 * sizes, counts, rates, provider kinds, and status names only: no scope or
 * chat identifiers, titles, message text, paths, or model names. Scopes are
 * relabelled `scope-NN` in descending commit-rate order.
 *
 * Per scope it records the chat-storage index sizes and revision, the commit
 * rate over the sampling window (revision delta), and each chat's committed
 * transcript size, runtime status, and tab-index footprint. For every chat in
 * the working set (an active turn or an observed committed rewrite, above
 * `--min-transcript-bytes`) it also streams the transcript once for the row
 * size distribution, block-type counts, and where delegated-agent cards sit in
 * the log, because a patched committed card rewrites everything after it.
 *
 * The app diagnostics of the same period supply the storage activity windows,
 * Codex stdout holds, committed rewrites, event-loop stalls, and resource
 * pressure. Rewrites are joined to chats through the diagnostic's opaque chat
 * key.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const FIELD_LOAD_SCHEMA_VERSION = 1;

const ACTIVE_RUNTIME_STATUSES = new Set([
  'starting',
  'streaming',
  'queued',
  'awaiting_input',
  'compacting',
]);
const TERMINAL_CARD_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
  'deadline_exceeded',
  'interrupted',
]);
/** Tab-index fields at or above this serialized size are named in the capture. */
const LARGE_TAB_FIELD_BYTES = 16 * 1024;
const CARD_FRACTION_LIMIT = 32;

export function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
}

function distribution(values) {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? 0 : Math.max(...values),
  };
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = String(value ?? 'unknown');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function fileBytes(file) {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

function directories(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The opaque key `chat_transcript_full_rewrite` diagnostics carry instead of
 * a chat id (`chat-transcript-rewrite-diagnostics.ts`). Recomputed here only
 * to join rewrites to the captured chat; the key itself is not retained.
 */
export function rewriteChatKey(chatId) {
  return createHash('sha256')
    .update('chat-transcript-rewrite\0')
    .update(chatId)
    .digest('hex')
    .slice(0, 16);
}

/** One chat's content-free tab-index and runtime shape. */
export function chatShape(tab, runtime) {
  const transcript = tab.transcript ?? {};
  const largeTabFields = {};
  for (const [field, value] of Object.entries(tab)) {
    const bytes = jsonBytes(value);
    if (bytes >= LARGE_TAB_FIELD_BYTES) largeTabFields[field] = bytes;
  }
  return {
    provider: tab.providerType ?? null,
    harness: tab.executionHarness ?? null,
    hook: typeof tab.id === 'string' && tab.id.startsWith('chat-hook-'),
    runtimeStatus: runtime?.status ?? 'idle',
    activeTurn: Boolean(runtime?.activeTurn),
    queuedMessages: runtime?.queuedMessageIds?.length ?? 0,
    committedMessages: transcript.committedMessageCount ?? 0,
    committedBytes: transcript.committedByteLength ?? 0,
    transcriptRevision: transcript.transcriptRevision ?? 0,
    userMessages: transcript.userMessageCount ?? 0,
    tabIndexBytes: jsonBytes(tab),
    largeTabFields,
  };
}

/** Yields each newline-terminated row of a JSONL file as a Buffer. */
async function* jsonlRows(file) {
  let pending = [];
  for await (const chunk of createReadStream(file)) {
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(0x0a, start);
      if (end === -1) break;
      pending.push(chunk.subarray(start, end));
      yield pending.length === 1 ? pending[0] : Buffer.concat(pending);
      pending = [];
      start = end + 1;
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }
  if (pending.length > 0) yield Buffer.concat(pending);
}

/**
 * Row sizes, block types, and delegated-agent card placement of one committed
 * transcript. `rows` yields one serialized message per item.
 */
export async function transcriptShape(rows) {
  const rowBytes = [];
  const blockTypes = {};
  const roles = {};
  const cards = [];
  let offset = 0;
  for await (const row of rows) {
    const bytes = row.length + 1;
    let message;
    try {
      message = JSON.parse(row.toString('utf8'));
    } catch {
      offset += bytes;
      continue;
    }
    rowBytes.push(bytes);
    roles[message.role] = (roles[message.role] ?? 0) + 1;
    for (const block of message.blocks ?? []) {
      blockTypes[block.type] = (blockTypes[block.type] ?? 0) + 1;
      if (block.type === 'delegated_agent_call')
        cards.push({ offset, bytes, status: block.status ?? 'unknown' });
    }
    offset += bytes;
  }
  const total = Math.max(1, offset);
  const fraction = (card) => Number((card.offset / total).toFixed(4));
  const live = cards.filter((card) => !TERMINAL_CARD_STATUSES.has(card.status));
  return {
    rows: rowBytes.length,
    bytes: offset,
    rowBytes: distribution(rowBytes),
    blockTypes,
    roles,
    delegationCards: {
      count: cards.length,
      byStatus: countBy(cards.map((card) => card.status)),
      bytes: distribution(cards.map((card) => card.bytes)),
      // Byte position of each card as a fraction of the log: a patch to a
      // committed card rewrites the log from there to the end.
      liveByteFractions: live.slice(-CARD_FRACTION_LIMIT).map(fraction),
      lastByteFractions: cards.slice(-CARD_FRACTION_LIMIT).map(fraction),
    },
  };
}

function delegationRuns(directory) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return { count: 0, bytes: 0, byStatus: {} };
  }
  let bytes = 0;
  const statuses = [];
  for (const name of names) {
    const file = path.join(directory, name);
    bytes += fileBytes(file);
    statuses.push(readJson(file)?.state?.status);
  }
  return { count: names.length, bytes, byStatus: countBy(statuses) };
}

function summarizeWindows(records, field) {
  return distribution(records.map((record) => record[field] ?? 0));
}

/**
 * Summarizes app diagnostic records at or after `sinceMs`. Rewrites are also
 * returned per opaque chat key, for joining to chats; the keys stay out of
 * the summary.
 */
/** `part` as a share of `total`, or null when nothing was attributed. */
function share(part, total) {
  return total > 0 ? part / total : null;
}

function sumOf(items, pick) {
  return items.reduce((total, item) => total + (pick(item) ?? 0), 0);
}

/** `renderer_frame_summary`: long frames and the off-screen share of chat delivery. */
function summarizeRendererFrames(records) {
  const summaries = records
    .map((record) => record.rendererSummary)
    .filter((summary) => summary !== undefined);
  const longFrames = summaries.flatMap((summary) =>
    Array.isArray(summary.frames?.long) ? summary.frames.long : [],
  );
  const scripts = longFrames.flatMap((frame) =>
    Array.isArray(frame.scripts) ? frame.scripts : [],
  );
  const focusedChatRows = {
    0: 0,
    1000: 0,
    5000: 0,
    20000: 0,
    50000: 0,
    null: 0,
  };
  for (const frame of longFrames) {
    const bucket = String(frame.focusedChatRows);
    if (Object.hasOwn(focusedChatRows, bucket)) {
      focusedChatRows[bucket] += 1;
    }
  }
  const onChanges = sumOf(summaries, (s) => s.chatState?.onScreenChanges);
  const offChanges = sumOf(summaries, (s) => s.chatState?.offScreenChanges);
  const onApply =
    sumOf(summaries, (s) => s.chatState?.onScreenApplyMs) +
    sumOf(summaries, (s) => s.chatEvent?.onScreenApplyMs);
  const offApply =
    sumOf(summaries, (s) => s.chatState?.offScreenApplyMs) +
    sumOf(summaries, (s) => s.chatEvent?.offScreenApplyMs);
  const mixedApply = sumOf(summaries, (s) => s.chatState?.mixedApplyMs);
  return {
    count: summaries.length,
    remoteWindowCount: summaries.filter((s) => s.remoteWindow === true).length,
    longFrames: sumOf(summaries, (s) => s.frames?.count),
    longFrameDetails: {
      count: longFrames.length,
      maxDurationMs: Math.max(
        0,
        ...longFrames.map((frame) => frame.durationMs ?? 0),
      ),
      scriptMs: sumOf(longFrames, (frame) => frame.scriptMs),
      renderMs: sumOf(longFrames, (frame) => frame.renderMs),
      layoutMs: sumOf(longFrames, (frame) => frame.layoutMs),
      deliveries: {
        chatState: sumOf(longFrames, (frame) => frame.deliveries?.chatState),
        chatEvent: sumOf(longFrames, (frame) => frame.deliveries?.chatEvent),
        terminal: sumOf(longFrames, (frame) => frame.deliveries?.terminal),
        deliveryMs: sumOf(longFrames, (frame) => frame.deliveries?.deliveryMs),
      },
      focusedChatRows,
      scripts: {
        invokerTypes: countBy(scripts.map((script) => script.invokerType)),
        invokers: countBy(
          scripts.map((script) =>
            script.invoker === null ? 'null' : script.invoker,
          ),
        ),
        sourceKinds: countBy(scripts.map((script) => script.sourceKind)),
      },
    },
    worstFrameP95Ms: Math.max(0, ...summaries.map((s) => s.frames?.p95Ms ?? 0)),
    worstFrameMaxMs: Math.max(0, ...summaries.map((s) => s.frames?.maxMs ?? 0)),
    terminalDeliveries: sumOf(summaries, (s) => s.terminal?.deliveries),
    delegationEvents: sumOf(summaries, (s) => s.chatEvent?.delegationEvents),
    offScreenChangeShare: share(offChanges, onChanges + offChanges),
    // Delegation events are not attributed to a chat on screen; left out.
    offScreenApplyShare: share(offApply, onApply + offApply + mixedApply),
  };
}

/** `remote_push_summary`: what remote access hosts forwarded per session. */
function summarizeRemotePushes(records) {
  const summaries = records
    .map((record) => record.remotePushSummary)
    .filter((summary) => summary !== undefined);
  const channels = ['chatState', 'chatEvent', 'terminal', 'other'];
  const declared = summaries.filter((s) => s.interestDeclared === true);
  const offBytes =
    sumOf(declared, (s) => s.chatState?.offScreenBytes) +
    sumOf(declared, (s) => s.chatEvent?.offScreenBytes);
  const attributedBytes =
    offBytes +
    sumOf(declared, (s) => s.chatState?.onScreenBytes) +
    sumOf(declared, (s) => s.chatState?.mixedBytes) +
    sumOf(declared, (s) => s.chatEvent?.onScreenBytes);
  return {
    count: summaries.length,
    pushes: sumOf(summaries, (s) =>
      channels.reduce((total, channel) => total + (s[channel]?.pushes ?? 0), 0),
    ),
    bytes: sumOf(summaries, (s) =>
      channels.reduce((total, channel) => total + (s[channel]?.bytes ?? 0), 0),
    ),
    duplicateDrops: sumOf(summaries, (s) => s.duplicateDrops),
    // Sessions without a declared interest only report totals.
    offScreenChatByteShare: share(offBytes, attributedBytes),
  };
}

export function summarizeDiagnostics(records, sinceMs) {
  const recent = records.filter(
    (record) => Date.parse(record.timestamp ?? '') >= sinceMs,
  );
  const ofKind = (kind) => recent.filter((record) => record.kind === kind);

  const storage = ofKind('chat_storage_activity_summary');
  const holds = {};
  for (const record of ofKind('codex_app_server_stdout_hold')) {
    const entry = (holds[record.holdKind] ??= { records: [] });
    entry.records.push(record);
  }
  const codexStdoutHolds = Object.fromEntries(
    Object.entries(holds).map(([kind, { records: held }]) => [
      kind,
      {
        count: held.length,
        byOutcome: countBy(held.map((record) => record.holdOutcome)),
        durationMs: distribution(held.map((record) => record.holdDurationMs)),
        durationMsTotal: held.reduce(
          (total, record) => total + (record.holdDurationMs ?? 0),
          0,
        ),
        peakQueuedFrames: Math.max(
          0,
          ...held.map((record) => record.queuedFrameCount ?? 0),
        ),
        peakQueuedBytes: Math.max(
          0,
          ...held.map((record) => record.queuedFrameBytes ?? 0),
        ),
        responseQueued: held.filter((record) => record.responseQueued).length,
      },
    ]),
  );

  const rewritesByKey = new Map();
  for (const record of ofKind('chat_transcript_full_rewrite')) {
    const key = record.chatTranscriptRewriteChatKey;
    const entry =
      rewritesByKey.get(key) ??
      rewritesByKey
        .set(key, {
          count: 0,
          bytes: 0,
          perMinute: [],
          reasons: {},
          patchedBlockTypes: {},
        })
        .get(key);
    // One record stands for itself plus the rewrites its rate limit
    // suppressed during the previous minute.
    const rewrites = 1 + (record.chatTranscriptRewriteSuppressedCount ?? 0);
    entry.count += rewrites;
    entry.bytes += rewrites * (record.chatTranscriptRewriteCommittedBytes ?? 0);
    entry.perMinute.push(rewrites);
    entry.reasons[record.reason] =
      (entry.reasons[record.reason] ?? 0) + rewrites;
    for (const type of record.chatTranscriptRewritePatchedBlockTypes ?? [])
      entry.patchedBlockTypes[type] =
        (entry.patchedBlockTypes[type] ?? 0) + rewrites;
  }

  const rateAlerts = ofKind('chat_transcript_rewrite_rate_exceeded');
  const rateAlertsByChatKey = new Map();
  for (const record of rateAlerts) {
    const key = record.chatTranscriptRewriteChatKey ?? 'unknown';
    rateAlertsByChatKey.set(key, (rateAlertsByChatKey.get(key) ?? 0) + 1);
  }

  const stalls = ofKind('main_event_loop_stall');
  const pressure = ofKind('resource_pressure_warning');
  const summary = {
    chatStorage: {
      windows: storage.length,
      windowMs: distribution(
        storage.map((record) => record.chatStorageWindowMs ?? 0),
      ).p50,
      commits: summarizeWindows(storage, 'chatStorageCommitCount'),
      mutations: summarizeWindows(storage, 'chatStorageMutationCount'),
      bytesWritten: summarizeWindows(storage, 'chatStorageBytesWritten'),
      fileSyncs: summarizeWindows(storage, 'chatStorageFileSyncCount'),
      directorySyncs: summarizeWindows(
        storage,
        'chatStorageDirectorySyncCount',
      ),
      commitMsTotal: summarizeWindows(storage, 'chatStorageCommitMsTotal'),
      commitMsMax: summarizeWindows(storage, 'chatStorageCommitMsMax'),
      activeScopes: summarizeWindows(storage, 'chatStorageScopeCount'),
    },
    codexStdoutHolds,
    codexAppServerStops: countBy(
      ofKind('resource_codex_app_server_stopped').map(
        (record) => record.trigger ?? record.stopTrigger,
      ),
    ),
    committedRewrites: {
      count: Array.from(rewritesByKey.values()).reduce(
        (total, entry) => total + entry.count,
        0,
      ),
      bytes: Array.from(rewritesByKey.values()).reduce(
        (total, entry) => total + entry.bytes,
        0,
      ),
      chats: rewritesByKey.size,
    },
    rewriteRateAlerts: {
      count: rateAlerts.length,
      chats: rateAlertsByChatKey.size,
      byChatKey: Object.fromEntries(rateAlertsByChatKey),
      maxWindowBytes: Math.max(
        0,
        ...rateAlerts.map(
          (record) => record.chatTranscriptRewriteRateCommittedBytes ?? 0,
        ),
      ),
    },
    eventLoopStalls: {
      count: stalls.length,
      maxDelayMs: Math.max(
        0,
        ...stalls.map((record) => record.eventLoopDelayMaxMs ?? 0),
      ),
      maxUtilization: Math.max(
        0,
        ...stalls.map((record) => record.eventLoopUtilization ?? 0),
      ),
      maxActiveTurns: Math.max(
        0,
        ...stalls.map((record) => record.activeTurnCount ?? 0),
      ),
    },
    rendererFrames: summarizeRendererFrames(ofKind('renderer_frame_summary')),
    remotePushes: summarizeRemotePushes(ofKind('remote_push_summary')),
    resourcePressure: {
      count: pressure.length,
      maxRssBytes: Math.max(
        0,
        ...pressure.map((record) => record.memoryRssBytes ?? 0),
      ),
      maxProcessCount: Math.max(
        0,
        ...pressure.map((record) => record.processCount ?? 0),
      ),
    },
  };
  return { summary, rewritesByKey };
}

function readDiagnostics(dataDir, sinceMs, nowMs) {
  const directory = path.join(
    dataDir,
    'agent-observability',
    'diagnostics',
    'app-events',
  );
  const records = [];
  // Files are named by UTC day; the window may span two of them.
  const days = new Set(
    [sinceMs, nowMs].map((ms) => new Date(ms).toISOString().slice(0, 10)),
  );
  for (const day of days) {
    let text;
    try {
      text = readFileSync(path.join(directory, `${day}.jsonl`), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A torn final line is not a record.
      }
    }
  }
  return records;
}

const PROCESS_CLASSES = [
  ['codex-app-server', /\bcodex(\.exe)? app-server\b/],
  ['claude-cli', /[\\/]claude(\.exe)? /],
  ['electron-renderer', /--type=renderer\b/],
  ['electron-gpu', /--type=gpu-process\b/],
  ['electron-utility', /--type=utility\b/],
  ['git', /(^|[\\/])git(\.exe)? /],
  ['node', /(^|[\\/])node(\.exe)? |^npm /],
  ['shell', /(^|[\\/])(zsh|bash|sh|fish)( |$)/],
];

/** Classifies `ps` rows (`pid ppid %cpu rssKb command`) under one root pid. */
export function processCensus(rows, rootPid) {
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.parentPid)) children.set(row.parentPid, []);
    children.get(row.parentPid).push(row);
  }
  const classes = {};
  const add = (name, row) => {
    const entry = (classes[name] ??= { count: 0, cpuPercent: 0, rssBytes: 0 });
    entry.count += 1;
    entry.cpuPercent = Number((entry.cpuPercent + row.cpuPercent).toFixed(1));
    entry.rssBytes += row.rssKb * 1024;
  };
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return undefined;
  add('app-main', root);
  const pending = [...(children.get(rootPid) ?? [])];
  let total = 1;
  while (pending.length > 0) {
    const row = pending.pop();
    total += 1;
    add(
      PROCESS_CLASSES.find(([, pattern]) => pattern.test(row.command))?.[0] ??
        'other',
      row,
    );
    pending.push(...(children.get(row.pid) ?? []));
  }
  return { processes: total, classes };
}

function readProcessRows() {
  if (process.platform === 'win32') return [];
  const output = execFileSync('ps', ['-Ao', 'pid=,ppid=,pcpu=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            cpuPercent: Number(match[3]),
            rssKb: Number(match[4]),
            command: match[5],
          },
        ]
      : [];
  });
}

function scopeDirectories(dataDir) {
  const scopes = [];
  const workspacesDir = path.join(dataDir, 'workspaces');
  for (const workspace of directories(workspacesDir)) {
    const storage = path.join(workspacesDir, workspace, 'chat-storage-v2');
    for (const scope of directories(storage)) {
      scopes.push({
        directory: path.join(storage, scope),
        delegationRuns: path.join(
          workspacesDir,
          workspace,
          'worktree-data',
          scope,
          'delegation',
          'runs',
        ),
      });
    }
  }
  return scopes;
}

function readScope(scope) {
  const liveIndexPath = path.join(scope.directory, 'live-index.json');
  const live = readJson(liveIndexPath);
  if (!live) return undefined;
  return {
    ...scope,
    live,
    liveIndexBytes: fileBytes(liveIndexPath),
    recoveryIndexBytes: fileBytes(
      path.join(scope.directory, 'recovery-index.json'),
    ),
    archiveIndexBytes: fileBytes(
      path.join(scope.directory, 'archive-index.json'),
    ),
  };
}

/**
 * Captures the load shape of the installation under `dataDir`. `wait` covers
 * the commit-rate window so tests need not sleep.
 */
export async function captureFieldLoad({
  dataDir,
  label = 'field-load',
  windowMs = 60_000,
  diagnosticsMinutes = 240,
  minTranscriptBytes = 1024 * 1024,
  appPid,
  now = Date.now,
  wait = delay,
  processRows = readProcessRows,
}) {
  const startedAt = now();
  const first = scopeDirectories(dataDir).map(readScope).filter(Boolean);
  const firstRevision = new Map(
    first.map((scope) => [scope.directory, scope.live.revision ?? 0]),
  );
  const diagnostics = summarizeDiagnostics(
    readDiagnostics(
      dataDir,
      startedAt - diagnosticsMinutes * 60_000,
      startedAt,
    ),
    startedAt - diagnosticsMinutes * 60_000,
  );

  const captured = [];
  for (const scope of first) {
    const tabs = scope.live.tabs ?? [];
    if (tabs.length === 0) continue;
    const chats = [];
    for (const tab of tabs) {
      const chat = chatShape(tab, scope.live.runtimeByChatId?.[tab.id]);
      const rewrites = diagnostics.rewritesByKey.get(rewriteChatKey(tab.id));
      if (rewrites) {
        chat.committedRewrites = {
          count: rewrites.count,
          bytes: rewrites.bytes,
          perMinute: distribution(rewrites.perMinute),
          reasons: rewrites.reasons,
          patchedBlockTypes: rewrites.patchedBlockTypes,
        };
      }
      const working =
        chat.activeTurn ||
        ACTIVE_RUNTIME_STATUSES.has(chat.runtimeStatus) ||
        Boolean(rewrites);
      const transcriptPath = path.join(
        scope.directory,
        'transcripts',
        `${tab.id}.jsonl`,
      );
      if (
        working &&
        chat.committedBytes >= minTranscriptBytes &&
        existsSync(transcriptPath)
      )
        chat.transcript = await transcriptShape(jsonlRows(transcriptPath));
      chats.push(chat);
    }
    const pendingQuestions = scope.live.pendingQuestions ?? [];
    captured.push({
      directory: scope.directory,
      shape: {
        liveIndexBytes: scope.liveIndexBytes,
        recoveryIndexBytes: scope.recoveryIndexBytes,
        archiveIndexBytes: scope.archiveIndexBytes,
        revision: scope.live.revision ?? 0,
        pendingQuestions: pendingQuestions.length,
        answeredPendingQuestions: pendingQuestions.filter(
          (question) => question.answeredAt !== undefined,
        ).length,
        delegationRuns: delegationRuns(scope.delegationRuns),
        chats,
      },
    });
  }

  const remaining = windowMs - (now() - startedAt);
  if (remaining > 0) await wait(remaining);
  const elapsedMs = Math.max(1, now() - startedAt);
  for (const { directory, shape } of captured) {
    const revision =
      readJson(path.join(directory, 'live-index.json'))?.revision ??
      shape.revision;
    shape.commitsPerMinute = Number(
      (
        ((revision - (firstRevision.get(directory) ?? revision)) * 60_000) /
        elapsedMs
      ).toFixed(1),
    );
  }
  captured.sort(
    (left, right) =>
      right.shape.commitsPerMinute - left.shape.commitsPerMinute ||
      right.shape.liveIndexBytes - left.shape.liveIndexBytes,
  );
  const scopes = captured.map(({ shape }, index) => ({
    label: `scope-${String(index + 1).padStart(2, '0')}`,
    ...shape,
  }));

  const chats = scopes.flatMap((scope) => scope.chats);
  const census =
    appPid === undefined ? undefined : processCensus(processRows(), appPid);
  return {
    schemaVersion: FIELD_LOAD_SCHEMA_VERSION,
    kind: 'desktop-field-load',
    label,
    capturedAt: new Date(startedAt).toISOString(),
    windowMs: elapsedMs,
    host: {
      platform: process.platform,
      arch: process.arch,
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      loadAverage: os.loadavg().map((load) => Number(load.toFixed(2))),
    },
    totals: {
      scopes: scopes.length,
      emptyScopes: first.length - scopes.length,
      chats: chats.length,
      activeTurns: chats.filter((chat) => chat.activeTurn).length,
      committedBytes: chats.reduce(
        (total, chat) => total + chat.committedBytes,
        0,
      ),
      commitsPerMinute: Number(
        scopes
          .reduce((total, scope) => total + scope.commitsPerMinute, 0)
          .toFixed(1),
      ),
      runningDelegationCards: chats.reduce(
        (total, chat) =>
          total +
          (chat.transcript?.delegationCards.liveByteFractions.length ?? 0),
        0,
      ),
    },
    diagnostics: {
      minutes: diagnosticsMinutes,
      ...diagnostics.summary,
    },
    ...(census ? { processes: census } : {}),
    scopes,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'data-dir': { type: 'string' },
      label: { type: 'string' },
      'window-ms': { type: 'string', default: '60000' },
      'diagnostics-minutes': { type: 'string', default: '240' },
      'min-transcript-bytes': { type: 'string', default: String(1024 * 1024) },
      'app-pid': { type: 'string' },
      output: { type: 'string' },
    },
  });
  // No default: this tool must never guess which installation to read.
  if (!values['data-dir'])
    throw new Error('Pass --data-dir <app data directory>');
  const dataDir = path.resolve(values['data-dir']);
  if (!existsSync(path.join(dataDir, 'workspaces')))
    throw new Error(`No workspaces directory under ${dataDir}`);
  const capture = await captureFieldLoad({
    dataDir,
    ...(values.label ? { label: values.label } : {}),
    windowMs: Number(values['window-ms']),
    diagnosticsMinutes: Number(values['diagnostics-minutes']),
    minTranscriptBytes: Number(values['min-transcript-bytes']),
    ...(values['app-pid'] ? { appPid: Number(values['app-pid']) } : {}),
  });
  const output = path.resolve(
    values.output ??
      `.performance/desktop/field-loads/${capture.capturedAt.replaceAll(':', '-')}.json`,
  );
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(capture, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `${JSON.stringify({ output, totals: capture.totals }, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
