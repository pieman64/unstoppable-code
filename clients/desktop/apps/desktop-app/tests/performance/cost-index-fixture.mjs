import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';

/*
 * The cost index's performance fixture: audit day files shaped like a
 * developer machine's history, where the observability service writes them
 * (`{data dir}/agent-observability/audit/<UTC day>.jsonl`). A day measured on
 * one such machine held about 67,000 lines of about 1 KB: roughly 99% repeated
 * `worktree_summary` upserts of about 200 ids, and about 370 chat turns across
 * 14 scopes. The cost index reads every line: each summary is an entry-summary
 * helper record that replaces the last one with its id, so the summaries are
 * most of its reading and upsert work. Both sides of a comparison get the same
 * files; a build without the cost index leaves them to observability.
 */

/** Distinct summary ids a day's upserts cycle through. */
const SUMMARY_IDS_PER_DAY = 200;
/** Chats each fixture scope's turns are spread over. */
const CHATS_PER_SCOPE = 12;
/** Worktrees other than the measured one that also record turns. */
const OTHER_SCOPES = 4;
/** Lines buffered before each write. */
const WRITE_BATCH_LINES = 1_000;

const TOOL_COUNT_KEYS = Object.freeze([
  'thinking',
  'bash',
  'read',
  'readLines',
  'writeEdit',
  'search',
  'web',
  'task',
  'todo',
  'plan',
  'skill',
  'scheduleWakeup',
  'askUser',
  'scriptOutput',
  'watcher',
  'canopy',
  'graph',
  'appAdvisor',
  'pipelineEditor',
  'mcp',
  'other',
]);

function toolCounts(seed) {
  const counts = {};
  for (const [index, key] of TOOL_COUNT_KEYS.entries()) {
    counts[key] = (seed + index) % 4 === 0 ? (seed % 7) + 1 : 0;
  }
  return counts;
}

/** The UTC day `daysAgo` days before `now`, as `YYYY-MM-DD`. */
function utcDay(now, daysAgo) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

/** An ISO time on `day`, `offsetMs` after its midnight, never after `now`. */
function timeOn(day, offsetMs, now) {
  const at = Date.parse(`${day}T00:00:00.000Z`) + offsetMs;
  return new Date(Math.min(at, now - 1_000)).toISOString();
}

function summaryLine(workspaceId, worktreeId, day, index, startedAt) {
  const summaryId = index % SUMMARY_IDS_PER_DAY;
  return JSON.stringify({
    id: `worktree-summary:${workspaceId}/${worktreeId}:${day}:${String(summaryId)}`,
    eventType: 'worktree_summary',
    status: 'success',
    provider: 'claude',
    modelSource: 'claude-managed',
    executionHarness: 'claude',
    label: 'Worktree summary',
    startedAt,
    model: 'claude-haiku-4-5-20251001',
    tokens: {
      input: 1_200 + (index % 300),
      output: 80 + (index % 40),
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 2,
    assistantMessageCount: 1,
    toolUseCount: 0,
    subAgentCount: 0,
    hasTranscript: false,
    toolCounts: toolCounts(index),
    projectId: workspaceId,
    worktreeId,
    linkTarget: { kind: 'worktree', projectId: workspaceId, worktreeId },
    attempt: index,
  });
}

function chatTurnLine({
  workspaceId,
  worktreeId,
  chatId,
  userMessageId,
  startedAt,
  completedAt,
  turn,
}) {
  const running = completedAt === undefined;
  return JSON.stringify({
    id: `chat:${workspaceId}/${worktreeId}/${chatId}:${startedAt}`,
    eventType: 'worktree_chat',
    status: running ? 'running' : 'success',
    provider: turn % 3 === 0 ? 'codex' : 'claude',
    modelSource: turn % 3 === 0 ? 'codex-managed' : 'claude-managed',
    executionHarness: turn % 3 === 0 ? 'codex' : 'claude',
    label: 'Chat turn',
    startedAt,
    model: turn % 3 === 0 ? 'gpt-6.1-sol' : 'claude-sonnet-5-5',
    tokens: {
      input: 20_000 + turn * 13,
      output: 1_500 + (turn % 500),
      cacheReadInputTokens: 60_000 + (turn % 900) * 10,
      cacheCreationInputTokens: 4_000,
    },
    messageCount: 6,
    assistantMessageCount: 3,
    toolUseCount: 8,
    subAgentCount: 0,
    hasTranscript: true,
    toolCounts: toolCounts(turn),
    projectId: workspaceId,
    worktreeId,
    chatId,
    userMessageId,
    billingBasis: turn % 3 === 0 ? 'api_key' : 'subscription',
    ...(running
      ? {}
      : {
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(startedAt),
          totalCostUsd: Math.round((0.05 + (turn % 40) * 0.01) * 100) / 100,
        }),
  });
}

/**
 * One day's lines in write order: summary upserts, with each chat turn
 * written once when it starts and again when it ends, as the service does.
 */
function* dayLines({
  workspaceId,
  worktreeIds,
  day,
  linesPerDay,
  turnsPerDay,
  now,
}) {
  const dayMs = 24 * 60 * 60 * 1_000;
  const turnEvery = Math.max(2, Math.floor(linesPerDay / (turnsPerDay * 2)));
  let turn = 0;
  for (let index = 0; index < linesPerDay; index += 1) {
    const offsetMs = Math.floor((index / linesPerDay) * (dayMs - 120_000));
    const startedAt = timeOn(day, offsetMs, now);
    if (index % turnEvery === 0 && turn < turnsPerDay) {
      const worktreeId = worktreeIds[turn % worktreeIds.length];
      const chatId = `perf-cost-chat-${String(turn % CHATS_PER_SCOPE)}`;
      const userMessageId = `perf-cost-${day}-${String(turn)}`;
      const completedAt = timeOn(day, offsetMs + 90_000, now);
      const turnFields = {
        workspaceId,
        worktreeId,
        chatId,
        userMessageId,
        startedAt,
        turn,
      };
      yield chatTurnLine(turnFields);
      yield chatTurnLine({ ...turnFields, completedAt });
      turn += 1;
      index += 1;
      continue;
    }
    yield summaryLine(workspaceId, worktreeIds[0], day, index, startedAt);
  }
}

function writeDay(filePath, lines) {
  const fd = openSync(filePath, 'w');
  let bytes = 0;
  let count = 0;
  let batch = [];
  const flush = () => {
    if (batch.length === 0) return;
    const chunk = `${batch.join('\n')}\n`;
    writeSync(fd, chunk);
    bytes += Buffer.byteLength(chunk);
    batch = [];
  };
  try {
    for (const line of lines) {
      batch.push(line);
      count += 1;
      if (batch.length >= WRITE_BATCH_LINES) flush();
    }
    flush();
  } finally {
    closeSync(fd);
  }
  return { bytes, lines: count };
}

/**
 * Writes `days` audit day files ending today (UTC). Today's file stops before
 * `now`, so no entry starts in the future. Returns what was written.
 *
 * @param {object} options
 * @param {string} options.userDataDir isolated CANOPY_DATA_DIR
 * @param {string} options.workspaceId the measured workspace
 * @param {string} options.worktreeId the measured worktree
 * @param {number} options.days day files, at most the 7-day default retention
 * @param {number} options.linesPerDay lines per day file
 * @param {number} options.turnsPerDay chat turns per day, each two lines
 * @param {number} [options.now]
 */
export function seedCostIndexAudit({
  userDataDir,
  workspaceId,
  worktreeId,
  days,
  linesPerDay,
  turnsPerDay,
  now = Date.now(),
}) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 7) {
    throw new Error(
      'Cost index fixture: days must be 1 to 7, the default audit retention',
    );
  }
  if (turnsPerDay * 2 > linesPerDay) {
    throw new Error('Cost index fixture: each chat turn writes two lines');
  }
  const auditDir = path.join(userDataDir, 'agent-observability', 'audit');
  mkdirSync(auditDir, { recursive: true });
  const worktreeIds = [
    worktreeId,
    ...Array.from(
      { length: OTHER_SCOPES },
      (_, index) => `perf-cost-worktree-${String(index + 1)}`,
    ),
  ];
  const files = [];
  let bytes = 0;
  let lines = 0;
  // Today's file holds the hours already passed, in proportion.
  const todayFraction =
    (now - Date.parse(`${utcDay(now, 0)}T00:00:00.000Z`)) /
    (24 * 60 * 60 * 1_000);
  for (let daysAgo = days - 1; daysAgo >= 0; daysAgo -= 1) {
    const day = utcDay(now, daysAgo);
    const share = daysAgo === 0 ? Math.max(0.05, todayFraction) : 1;
    const dayLinesCount = Math.max(2, Math.floor(linesPerDay * share));
    const dayTurns = Math.min(
      Math.floor(dayLinesCount / 2),
      Math.max(1, Math.floor(turnsPerDay * share)),
    );
    const filePath = path.join(auditDir, `${day}.jsonl`);
    const written = writeDay(
      filePath,
      dayLines({
        workspaceId,
        worktreeIds,
        day,
        linesPerDay: dayLinesCount,
        turnsPerDay: dayTurns,
        now,
      }),
    );
    files.push(filePath);
    bytes += written.bytes;
    lines += written.lines;
  }
  return { auditDir, files, bytes, lines, scopes: worktreeIds.length };
}
