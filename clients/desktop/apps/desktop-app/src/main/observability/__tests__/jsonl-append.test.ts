import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonlLines } from '../jsonl-append';

function parsedLines(contents: string): unknown[] {
  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line): unknown[] => {
      try {
        const value: unknown = JSON.parse(line);
        return [value];
      } catch {
        return [];
      }
    });
}

describe('appendJsonlLines', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'jsonl-append-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('starts a new line after a torn tail so the appended record stays parseable', async () => {
    const filePath = join(root, 'torn.jsonl');
    await writeFile(filePath, '{"a":1}\n{"b":', 'utf8');

    await appendJsonlLines(filePath, '{"c":3}\n');

    const contents = await readFile(filePath, 'utf8');
    expect(contents).toBe('{"a":1}\n{"b":\n{"c":3}\n');
    expect(parsedLines(contents)).toEqual([{ a: 1 }, { c: 3 }]);
  });

  it('appends directly after a complete last line', async () => {
    const filePath = join(root, 'complete.jsonl');
    await writeFile(filePath, '{"a":1}\n', 'utf8');

    await appendJsonlLines(filePath, '{"b":2}\n');
    await appendJsonlLines(filePath, '{"c":3}\n');

    expect(await readFile(filePath, 'utf8')).toBe(
      '{"a":1}\n{"b":2}\n{"c":3}\n',
    );
  });

  it('creates a missing file without a leading newline', async () => {
    const filePath = join(root, 'new.jsonl');

    await appendJsonlLines(filePath, '{"a":1}\n');

    expect(await readFile(filePath, 'utf8')).toBe('{"a":1}\n');
  });

  it('repairs a tail torn after an earlier append in the same process', async () => {
    const filePath = join(root, 'later.jsonl');
    await appendJsonlLines(filePath, '{"a":1}\n');
    await writeFile(filePath, '{"partial":', { encoding: 'utf8', flag: 'a' });

    await appendJsonlLines(filePath, '{"b":2}\n');

    expect(parsedLines(await readFile(filePath, 'utf8'))).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
  });
});
