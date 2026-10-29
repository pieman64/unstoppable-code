import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetRunDir } from '../_lib/output';
import { runMemoryReadAction } from '../memory-read/runner';
import { runMemoryWriteAction } from '../memory-write/runner';

function readOutputs(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, 'utf8');
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('memory actions', () => {
  let tempDir: string;
  let outputFile: string;
  let originalOutput: string | undefined;

  beforeEach(() => {
    // The run-dir for writeOutputFile is cached module-globally; reset it so
    // each test allocates inside its own (fresh) temp dir instead of the
    // previous test's deleted one.
    resetRunDir();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-memory-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    originalOutput = process.env.CANOPY_OUTPUT;
    process.env.CANOPY_OUTPUT = outputFile;
  });

  afterEach(() => {
    if (originalOutput === undefined) {
      delete process.env.CANOPY_OUTPUT;
    } else {
      process.env.CANOPY_OUTPUT = originalOutput;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends JSONL memory records and reports the new count', async () => {
    const memoryFile = path.join(tempDir, 'memory.jsonl');

    await runMemoryWriteAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_FILE: path.relative(process.cwd(), memoryFile),
      INPUT_STEP_ID: 'plan',
      INPUT_TAGS: 'phase-1,plans',
      INPUT_DATA: '{"summary":"ready"}',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.record_count).toBe('1');
    expect(outputs.file_path).toBe(memoryFile);

    const lines = fs
      .readFileSync(memoryFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      step_id: 'plan',
      tags: ['phase-1', 'plans'],
      data: { summary: 'ready' },
    });
  });

  it('reads and filters recent memory records', async () => {
    const memoryFile = path.join(tempDir, 'memory.jsonl');
    fs.writeFileSync(
      memoryFile,
      [
        JSON.stringify({
          step_id: 'discuss',
          timestamp: '2026-03-15T12:00:00.000Z',
          tags: ['context'],
          data: { summary: 'first' },
        }),
        JSON.stringify({
          step_id: 'plan',
          timestamp: '2026-03-15T12:05:00.000Z',
          tags: ['plans'],
          data: { summary: 'second' },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await runMemoryReadAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_FILE: path.relative(process.cwd(), memoryFile),
      INPUT_QUERY: 'plan',
      INPUT_LIMIT: '1',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.record_count).toBe('1');

    const records = JSON.parse(outputs.records) as Array<
      Record<string, unknown>
    >;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      step_id: 'plan',
      tags: ['plans'],
    });
    expect(fs.existsSync(outputs.records_file)).toBe(true);
  });

  it('returns all matching records when limit is 0', async () => {
    const memoryFile = path.join(tempDir, 'memory.jsonl');
    fs.writeFileSync(
      memoryFile,
      [
        JSON.stringify({ step_id: 'discuss', tags: ['context'] }),
        JSON.stringify({ step_id: 'plan', tags: ['plans'] }),
        JSON.stringify({ step_id: 'implement', tags: ['code'] }),
      ].join('\n') + '\n',
      'utf8',
    );

    // `parseLimit` explicitly accepts 0 ("non-negative integer") as the
    // unlimited sentinel — it must return every matching record, not none.
    await runMemoryReadAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_FILE: path.relative(process.cwd(), memoryFile),
      INPUT_LIMIT: '0',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.record_count).toBe('3');

    const records = JSON.parse(outputs.records) as Array<
      Record<string, unknown>
    >;
    expect(records.map((record) => record.step_id)).toEqual([
      'implement',
      'plan',
      'discuss',
    ]);
  });
});
