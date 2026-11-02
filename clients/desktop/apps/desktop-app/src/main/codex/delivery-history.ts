import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { findCodexRolloutFiles } from '../lib/codex-session-artifacts';
import { resolveCodexHomeWithoutSpawn } from './resolve-codex-home';

export type DeliveryHistoryVerdict = 'found' | 'not-found' | 'unreadable';

const CODEX_ROLLOUT_SCAN_ENTRY_LIMIT = 10_000;
const CODEX_ROLLOUT_BYTE_LIMIT = 64 * 1024 * 1024;
const CODEX_ROLLOUT_LINE_LIMIT = 200_000;

interface RolloutScan {
  paths: string[];
  capped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isRolloutForThread(path: string, threadId: string): boolean {
  const name = basename(path);
  return name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`);
}

/**
 * The existing rollout finder bounds its traversal but does not report whether
 * it stopped at that bound. Mirror the bounded walk to distinguish a complete
 * scan from a partial one before trusting a negative result.
 */
async function scanRolloutPaths(
  sessionsRoot: string,
  threadId: string,
): Promise<RolloutScan> {
  const stack = [sessionsRoot];
  const paths: string[] = [];
  let visitedEntries = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }

    for (let index = 0; index < entries.length; index += 1) {
      if (visitedEntries >= CODEX_ROLLOUT_SCAN_ENTRY_LIMIT)
        return { paths, capped: true };
      const entry = entries[index];
      if (!entry) continue;
      visitedEntries += 1;
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) stack.push(entryPath);
      else if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith(`-${threadId}.jsonl`)
      ) {
        paths.push(entryPath);
      }
      if (
        visitedEntries >= CODEX_ROLLOUT_SCAN_ENTRY_LIMIT &&
        (index < entries.length - 1 || stack.length > 0)
      )
        return { paths, capped: true };
    }
  }

  return { paths: paths.sort(), capped: false };
}

async function readRollout(
  path: string,
  query: {
    threadId: string;
    turnId?: string;
    attemptId: string;
    previousRun: boolean;
  },
): Promise<DeliveryHistoryVerdict> {
  const stream = createReadStream(path);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bytesRead = 0;
  let byteBudgetExceeded = false;
  let lineCount = 0;
  let foundAttempt = false;
  let foundTurnStart = false;

  stream.on('data', (chunk: Buffer | string) => {
    bytesRead +=
      typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (bytesRead > CODEX_ROLLOUT_BYTE_LIMIT) {
      byteBudgetExceeded = true;
      lines.close();
      stream.destroy();
    }
  });

  try {
    for await (const line of lines) {
      if (byteBudgetExceeded || lineCount >= CODEX_ROLLOUT_LINE_LIMIT)
        return 'unreadable';
      lineCount += 1;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        return 'unreadable';
      }
      if (!isRecord(parsed)) continue;

      if (parsed.type === 'session_meta') {
        const payload = isRecord(parsed.payload) ? parsed.payload : undefined;
        const idIsPresent =
          (payload && Object.prototype.hasOwnProperty.call(payload, 'id')) ||
          Object.prototype.hasOwnProperty.call(parsed, 'id');
        if (idIsPresent) {
          const sessionId = payload && 'id' in payload ? payload.id : parsed.id;
          if (sessionId !== query.threadId) return 'unreadable';
        }
      }

      if (parsed.type !== 'event_msg' || !isRecord(parsed.payload)) continue;
      if (
        parsed.payload.type === 'item_completed' &&
        isRecord(parsed.payload.item) &&
        parsed.payload.item.client_id === query.attemptId
      ) {
        foundAttempt = true;
      }
      if (
        parsed.payload.type === 'task_started' &&
        query.turnId &&
        parsed.payload.turn_id === query.turnId
      ) {
        foundTurnStart = true;
      }
    }
  } catch {
    return 'unreadable';
  } finally {
    lines.close();
    stream.destroy();
  }

  if (byteBudgetExceeded || lineCount > CODEX_ROLLOUT_LINE_LIMIT)
    return 'unreadable';
  if (foundAttempt) return 'found';
  if (query.previousRun && query.turnId && foundTurnStart) return 'not-found';
  return 'unreadable';
}

/** Decides from the Codex rollout on disk whether a steer reached the provider. */
export async function readCodexDeliveryHistory(query: {
  threadId: string;
  turnId?: string;
  attemptId: string;
  /** The attempt was created before the current app process started. */
  previousRun: boolean;
  codexHome?: string;
}): Promise<DeliveryHistoryVerdict> {
  try {
    const codexHome = query.codexHome ?? (await resolveCodexHomeWithoutSpawn());
    const sessionsRoot = join(codexHome, 'sessions');
    const scan = await scanRolloutPaths(sessionsRoot, query.threadId);
    if (scan.capped) return 'unreadable';

    const indexedPaths = await findCodexRolloutFiles(
      sessionsRoot,
      query.threadId,
      CODEX_ROLLOUT_SCAN_ENTRY_LIMIT,
    );
    const helperPaths = indexedPaths
      .filter((path) => isRolloutForThread(path, query.threadId))
      .sort();
    if (
      scan.paths.length !== helperPaths.length ||
      scan.paths.some((path, index) => path !== helperPaths[index])
    )
      return 'unreadable';
    if (scan.paths.length !== 1) return 'unreadable';

    return await readRollout(scan.paths[0], query);
  } catch {
    return 'unreadable';
  }
}
