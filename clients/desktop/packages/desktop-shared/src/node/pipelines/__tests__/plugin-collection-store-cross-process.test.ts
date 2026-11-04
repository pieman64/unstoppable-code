import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPOSITORY_ROOT = resolve(__dirname, '../../../../../..');
const WRITER = join(__dirname, 'pipeline-preference-writer-process.ts');
const WRITES_PER_PROCESS = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function runWriter(
  dataDir: string,
  writer: 'electron_main' | 'desktop_cli',
  prefix: string,
  startAt: number,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      WRITER,
      writer,
      prefix,
      String(WRITES_PER_PROCESS),
      String(startAt),
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, CANOPY_DATA_DIR: dataDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once('exit', resolve);
  });
  return { code, stderr };
}

describe('pipeline preference writes across processes', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'pipeline-preferences-processes-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps every desktop and CLI write when both processes write at once', async () => {
    // Both children load their modules first, then start writing together.
    const startAt = Date.now() + 4_000;
    const results = await Promise.all([
      runWriter(dataDir, 'electron_main', 'desktop', startAt),
      runWriter(dataDir, 'desktop_cli', 'cli', startAt),
    ]);
    expect(results.map((result) => result.code)).toEqual([0, 0]);

    const parsed: unknown = JSON.parse(
      await readFile(join(dataDir, 'pipeline-plugin-preferences.json'), 'utf8'),
    );
    if (!isRecord(parsed) || !isRecord(parsed.entries)) {
      throw new Error('Expected a version 2 preference file');
    }
    const entries = parsed.entries;
    const missing: string[] = [];
    for (const prefix of ['desktop', 'cli']) {
      for (let index = 0; index < WRITES_PER_PROCESS; index += 1) {
        const key = Object.keys(entries).find((candidate) =>
          candidate.endsWith(`/${prefix}/${index}.yaml`),
        );
        const entry = key === undefined ? undefined : entries[key];
        const expected = {
          plugin_collections: {
            tools: {
              disabledDefaultKeys: [`${prefix}-${index}`],
              extraSelections: {
                collectionIds: [],
                skillRefs: [],
                pluginRefs: [],
                mcpServerRefs: [],
                mcpHttpAuthPreferences: [],
              },
            },
          },
          model_aliases: {
            reviewer: { mode: 'inline', base: `${prefix}-model-${index}` },
          },
        };
        if (JSON.stringify(entry) !== JSON.stringify(expected)) {
          missing.push(`${prefix}/${index}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect(parsed.version).toBe(2);
    expect(results.map((result) => result.stderr)).toEqual(['', '']);
  }, 60_000);
});
