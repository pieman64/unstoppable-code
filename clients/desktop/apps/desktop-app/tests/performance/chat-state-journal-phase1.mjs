/**
 * Rollback-safe phase-1 chat-journal recovery benchmark.
 *
 * `smoke` keeps local/CI checks quick. `nightingale` reproduces the observed
 * 2026-09-02 scope shape: 420 complete records averaging about 5.4 MB each.
 * The fixture contains deterministic synthetic text and no user transcript.
 */
import { mkdtemp, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { readChatJournal } from '../../src/main/lib/chat-state-journal.ts';

const PROFILES = {
  smoke: { recordCount: 12, payloadBytes: 128 * 1024 },
  nightingale: { recordCount: 420, payloadBytes: 5_400_000 },
};

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

async function run() {
  const requestedProfile = argument('--profile') ?? 'smoke';
  if (!(requestedProfile in PROFILES)) {
    throw new Error(`Unknown profile: ${requestedProfile}`);
  }
  const profile = PROFILES[requestedProfile];
  const recordCount = positiveInteger(
    argument('--records'),
    profile.recordCount,
  );
  const payloadBytes = positiveInteger(
    argument('--payload-bytes'),
    profile.payloadBytes,
  );
  const outputPath = resolve(
    argument('--output') ??
      `.playwright/per-chat-transcript-storage/phase1-journal-${requestedProfile}.json`,
  );
  const fixtureDirectory = await mkdtemp(
    join(tmpdir(), 'canopy-phase1-chat-journal-'),
  );
  const journalPath = join(fixtureDirectory, 'nightingale.jsonl');
  const payload = 'x'.repeat(payloadBytes);

  try {
    const handle = await open(journalPath, 'w');
    try {
      for (let revision = 1; revision <= recordCount; revision += 1) {
        const record = {
          v: 1,
          revision,
          mutationId: `nightingale-${revision}`,
          occurredAt: '2026-09-02T00:00:00.000Z',
          source: 'provider',
          mutations: [
            {
              type: 'message.upserted',
              chatId: 'nightingale-large-chat',
              message: {
                id: `message-${revision}`,
                role: 'assistant',
                timestamp: revision,
                blocks: [{ type: 'text', text: payload }],
              },
            },
          ],
        };
        await handle.write(`${JSON.stringify(record)}\n`);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }

    const rssBefore = process.memoryUsage().rss;
    const startedAt = performance.now();
    const result = await readChatJournal(journalPath);
    const elapsedMs = performance.now() - startedAt;
    if (result.records.length !== recordCount) {
      throw new Error(
        `Recovered ${result.records.length} of ${recordCount} journal records`,
      );
    }
    const artifact = {
      benchmark: 'chat-state-journal-phase1',
      profile: requestedProfile,
      fixture: {
        recordCount,
        payloadBytes,
        journalBytes: result.byteLength,
      },
      result: {
        elapsedMs,
        rssBefore,
        rssAfter: process.memoryUsage().rss,
        maxRssKb: process.resourceUsage().maxRSS,
        stats: result.stats,
      },
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } finally {
    await rm(fixtureDirectory, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
