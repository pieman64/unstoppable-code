import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { setOutput, writeOutputFile } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';

interface MemoryRecord {
  step_id?: string;
  tags?: string[];
  [key: string]: unknown;
}

function parseLimit(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return 20;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('memory-read limit must be a non-negative integer');
  }
  return parsed;
}

async function loadRecords(filePath: string): Promise<MemoryRecord[]> {
  try {
    const content = await readFile(filePath, 'utf8');
    return content
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as MemoryRecord);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function matchesQuery(record: MemoryRecord, query: string): boolean {
  if (!query) {
    return true;
  }

  const normalized = query.toLowerCase();
  if (
    String(record.step_id ?? '')
      .toLowerCase()
      .includes(normalized)
  ) {
    return true;
  }

  return (record.tags ?? []).some((tag) =>
    String(tag).toLowerCase().includes(normalized),
  );
}

export async function runMemoryReadAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const file = env.INPUT_FILE?.trim();
    if (!file) {
      throw new Error('memory-read requires INPUT_FILE');
    }

    const query = env.INPUT_QUERY?.trim().toLowerCase() ?? '';
    const limit = parseLimit(env.INPUT_LIMIT);
    const filePath = path.resolve(process.cwd(), file);
    const records = await loadRecords(filePath);
    // limit 0 is the "unlimited" sentinel (parseLimit accepts non-negative
    // integers); a positive limit keeps only the most recent N records.
    const filtered = records
      .filter((record) => matchesQuery(record, query))
      .slice(limit > 0 ? -limit : 0)
      .reverse();

    setOutput('records', JSON.stringify(filtered));
    setOutput('record_count', String(filtered.length));
    writeOutputFile(
      'records_file',
      'memory-records.json',
      `${JSON.stringify(filtered, null, 2)}\n`,
    );
  });
}
