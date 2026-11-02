import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const COUNT = 10_000;
const STRIDE = 100;
const output =
  process.argv[2] ??
  '.playwright/unified-agent-transcripts/phase-06/locator-raw.json';
let seed = 0x12345;
const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const shuffled = Array.from({ length: COUNT }, (_, i) => i).sort(
  () => random() - 0.5,
);
const rows = shuffled.map((i) => ({
  id: i % 2 ? `child:${i}` : `child:${'x'.repeat(96)}:${i}`,
  delegationSequence: i,
  itemRevision: 1,
  final: i % 97 !== 0,
  blocks:
    i % 3
      ? [{ type: 'text', text: `text-${i}` }]
      : [{ type: 'tool_use', toolName: 'Read', input: `file-${i}` }],
}));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
const measure = async (work) => {
  const start = performance.now();
  const value = await work();
  return { ms: performance.now() - start, value };
};

async function trial(layout, run) {
  const root = await mkdtemp(join(tmpdir(), `child-locator-${layout}-`));
  const source = join(root, 'source');
  const copy = join(root, 'capture');
  await mkdir(source);
  const lines = rows.map((row) => `${JSON.stringify(row)}\n`);
  const log = lines.join('');
  await writeFile(join(source, 'transcript.jsonl'), log);
  const offsets = [];
  let position = 0;
  for (const line of lines) {
    offsets.push(position);
    position += Buffer.byteLength(line);
  }
  const locators = join(source, 'message-index');
  await mkdir(locators);
  const entries = rows.map((row, i) => ({
    id: row.id,
    sequence: row.delegationSequence,
    offset: offsets[i],
    bytes: Buffer.byteLength(lines[i]),
  }));
  const setup = await measure(async () => {
    if (layout === 'locator')
      await Promise.all(
        entries.map((entry) =>
          writeFile(
            join(locators, `${hash(entry.id)}.json`),
            JSON.stringify(entry),
          ),
        ),
      );
    else
      await writeFile(
        join(locators, 'sparse.json'),
        JSON.stringify({
          checkpoints: entries
            .filter((_, i) => i % STRIDE === 0)
            .map(({ offset }) => offset),
          buckets: Object.fromEntries(
            entries.map((entry, i) => [hash(entry.id), Math.floor(i / STRIDE)]),
          ),
        }),
      );
    await writeFile(
      join(source, 'sequence-index.json'),
      JSON.stringify([...entries].sort((a, b) => a.sequence - b.sequence)),
    );
  });
  const file = await readFile(join(source, 'transcript.jsonl'));
  const coldLoad = await measure(async () =>
    layout === 'sparse'
      ? JSON.parse(await readFile(join(locators, 'sparse.json'), 'utf8'))
      : undefined,
  );
  const sparse = coldLoad.value;
  const idSamples = Array.from(
    { length: 200 },
    () => entries[Math.floor(random() * COUNT)],
  );
  const lookupTimes = [];
  let parsedRows = 0;
  for (const entry of idSamples) {
    const start = performance.now();
    if (layout === 'locator') {
      const locator = JSON.parse(
        await readFile(join(locators, `${hash(entry.id)}.json`), 'utf8'),
      );
      if (
        JSON.parse(
          file
            .subarray(locator.offset, locator.offset + locator.bytes)
            .toString(),
        ).id !== entry.id
      )
        throw Error('locator mismatch');
      parsedRows += 1;
    } else {
      // One compact ID-to-bucket map plus physical checkpoints bounds the scan.
      const bucket = sparse.buckets[hash(entry.id)];
      const base = bucket * STRIDE;
      let cursor = sparse.checkpoints[bucket];
      for (let i = base; i < Math.min(base + STRIDE, COUNT); i++) {
        const end = file.indexOf(10, cursor);
        if (end < 0) throw Error('unterminated row');
        parsedRows += 1;
        const decoded = JSON.parse(file.subarray(cursor, end).toString());
        if (decoded.id === entry.id) {
          break;
        }
        cursor = end + 1;
        if (i === Math.min(base + STRIDE, COUNT) - 1)
          throw Error('sparse mismatch');
      }
    }
    lookupTimes.push(performance.now() - start);
  }
  const sorted = [...entries].sort((a, b) => a.sequence - b.sequence);
  const pageTimes = [];
  for (let n = 0; n < 40; n++) {
    const start = Math.floor(random() * (COUNT - 100));
    const started = performance.now();
    const page = sorted
      .slice(start, start + 100)
      .map((entry) =>
        JSON.parse(
          file.subarray(entry.offset, entry.offset + entry.bytes).toString(),
        ),
      );
    if (page.some((row, i) => row.delegationSequence !== start + i))
      throw Error('page mismatch');
    pageTimes.push(performance.now() - started);
  }
  const capture = await measure(() => cp(source, copy, { recursive: true }));
  const copied = await readdir(join(copy, 'message-index'));
  const indexBytes = (await stat(join(source, 'sequence-index.json'))).size;
  const derivedBytes =
    indexBytes +
    (
      await Promise.all(
        (await readdir(locators)).map(
          async (name) => (await stat(join(locators, name))).size,
        ),
      )
    ).reduce((a, b) => a + b, 0);
  const rebuild = await measure(async () => {
    await rm(join(source, 'sequence-index.json'));
    const rebuilt = [...entries].sort((a, b) => a.sequence - b.sequence);
    await writeFile(
      join(source, 'sequence-index.json'),
      JSON.stringify(rebuilt),
    );
  });
  const deletion = await measure(() => rm(root, { recursive: true }));
  return {
    layout,
    run,
    setupMs: setup.ms,
    coldLoadMs: coldLoad.ms,
    files: copied.length + 2,
    bytes: file.length + derivedBytes,
    lookup: {
      p50: percentile(lookupTimes, 0.5),
      p95: percentile(lookupTimes, 0.95),
      p99: percentile(lookupTimes, 0.99),
      parsedRows,
    },
    page: { p50: percentile(pageTimes, 0.5), p95: percentile(pageTimes, 0.95) },
    captureMs: capture.ms,
    copiedFiles: copied.length + 2,
    copiedBytes: file.length + derivedBytes,
    rebuildMs: rebuild.ms,
    deleteMs: deletion.ms,
    rss: process.memoryUsage().rss,
    heapUsed: process.memoryUsage().heapUsed,
    digest: hash(log),
  };
}

const results = [];
for (let run = 0; run < 3; run++)
  for (const layout of run % 2 ? ['sparse', 'locator'] : ['locator', 'sparse'])
    results.push(await trial(layout, run));
await mkdir(join(output, '..'), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      fixture: {
        count: COUNT,
        stride: STRIDE,
        shuffled: true,
        sparseOpen: true,
      },
      host: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
      },
      results,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      output,
      results: results.map(
        ({ layout, run, files, lookup, captureMs, deleteMs }) => ({
          layout,
          run,
          files,
          lookup,
          captureMs,
          deleteMs,
        }),
      ),
    },
    null,
    2,
  ),
);
