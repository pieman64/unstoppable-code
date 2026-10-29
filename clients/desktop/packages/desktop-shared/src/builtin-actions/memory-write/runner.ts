import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { setOutput } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';

interface MemoryRecord {
  step_id: string;
  timestamp: string;
  tags: string[];
  data: unknown;
}

function parseData(raw: string | undefined): unknown {
  if (!raw || raw.trim().length === 0) {
    return '';
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function countRecords(filePath: string): Promise<number> {
  try {
    const content = await readFile(filePath, 'utf8');
    return content.split(/\r?\n/).filter((line) => line.trim().length > 0)
      .length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

export async function runMemoryWriteAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const file = env.INPUT_FILE?.trim();
    const stepId = env.INPUT_STEP_ID?.trim();
    if (!file) {
      throw new Error('memory-write requires INPUT_FILE');
    }
    if (!stepId) {
      throw new Error('memory-write requires INPUT_STEP_ID');
    }

    const filePath = path.resolve(process.cwd(), file);
    await mkdir(path.dirname(filePath), { recursive: true });

    const record: MemoryRecord = {
      step_id: stepId,
      timestamp: new Date().toISOString(),
      tags: (env.INPUT_TAGS ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
      data: parseData(env.INPUT_DATA),
    };

    await appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
    const recordCount = await countRecords(filePath);
    setOutput('record_count', String(recordCount));
    setOutput('file_path', filePath);
  });
}
