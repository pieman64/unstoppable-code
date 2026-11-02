import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryDelegationTranscriptPort } from '@canopy/desktop-shared/node/delegation/in-memory-transcript-port';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptPort,
  DelegationTranscriptPortResult,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { DelegationChildNormalizer } from '../agents/delegation/child-row-normalizers';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';

jest.setTimeout(900_000);

const SMALL_N = 32_769;
const MIXED_N = 1_025;
const LARGE_PROSE_BYTES = 8 * 1_024 * 1_024;
const FINE_PROSE_BYTES = 1_024 * 1_024;
const PATCH_PAIRS = 100;
const thread = { threadId: 'thread-benchmark', turnId: 'turn-benchmark' };

interface Counters {
  appendCalls: number;
  rowsAdmitted: number;
  admittedJsonBytes: number;
  materializedRows: number;
  blocksVisited: number;
  maxOpenFieldBytes: number;
  maxOpenPublicationsPerItem: number;
}

function value<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function materializedRows(
  normalizer: DelegationChildNormalizer,
  fallback: number,
): number {
  const builder: unknown = Reflect.get(normalizer, 'builder');
  if (typeof builder !== 'object' || builder === null) return fallback;
  const count: unknown = Reflect.get(builder, 'materializedRows');
  return typeof count === 'number' ? count : fallback;
}

async function measure(
  port: DelegationTranscriptPort,
  target: DelegationTranscriptTarget,
  kind: 'small' | 'mixed' | 'prose' | 'patch',
  n: number,
  deltaBytes = 32,
): Promise<Counters> {
  let now = 0;
  let mutation = 0;
  const normalizer = new DelegationChildNormalizer('agent-benchmark', {
    now: (): number => now,
  });
  value(await port.open({ target }));
  const counters: Counters = {
    appendCalls: 0,
    rowsAdmitted: 0,
    admittedJsonBytes: 0,
    materializedRows: 0,
    blocksVisited: 0,
    maxOpenFieldBytes: 0,
    maxOpenPublicationsPerItem: 0,
  };
  const pending: DelegationTranscriptChange[] = [];
  const pendingIds = new Set<string>();
  const openCounts = new Map<string, number>();
  async function flush(): Promise<void> {
    if (pending.length === 0) return;
    const changes = pending.splice(0);
    pendingIds.clear();
    value(
      await port.appendChanges({
        target,
        mutationKey: `bench-${mutation++}`,
        changes,
      }),
    );
    normalizer.acknowledge(changes);
    counters.appendCalls++;
    counters.rowsAdmitted += changes.length;
    counters.admittedJsonBytes += Buffer.byteLength(JSON.stringify(changes));
  }
  async function collect(
    changes: readonly DelegationTranscriptChange[],
  ): Promise<void> {
    if (changes.some((change) => pendingIds.has(change.row.id))) await flush();
    for (const change of changes) {
      pendingIds.add(change.row.id);
      if (change.row.final) continue;
      const count = (openCounts.get(change.row.id) ?? 0) + 1;
      openCounts.set(change.row.id, count);
      counters.maxOpenPublicationsPerItem = Math.max(
        counters.maxOpenPublicationsPerItem,
        count,
      );
      for (const block of change.row.blocks) {
        if (block.type === 'text')
          counters.maxOpenFieldBytes = Math.max(
            counters.maxOpenFieldBytes,
            Buffer.byteLength(block.text),
          );
      }
    }
    pending.push(...changes);
    if (pending.length >= SMALL_N) await flush();
  }
  async function codex(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    now += 10;
    counters.blocksVisited++;
    await collect(
      await normalizer.codex({ method, params: { ...thread, ...params } }),
    );
  }
  const start = performance.now();
  if (kind === 'small' || kind === 'mixed') {
    for (let index = 0; index < n; index++) {
      const id = `item-${index}`;
      if (kind === 'mixed' && index % 2 === 1) {
        await codex('item/completed', {
          item: {
            type: 'commandExecution',
            id,
            command: 'echo benchmark',
            cwd: '/tmp',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: `result-${index}`,
          },
        });
      } else {
        await codex('item/completed', {
          item: {
            type: 'agentMessage',
            id,
            text: kind === 'small' ? 'x' : `mixed-${index}`,
          },
        });
      }
    }
  } else if (kind === 'prose') {
    const itemBytes = n / 4;
    const pieces: string[][] = Array.from({ length: 4 }, () => []);
    for (let item = 0; item < 4; item++) {
      await codex('item/started', {
        item: { type: 'agentMessage', id: `prose-${item}`, text: '' },
      });
    }
    for (let offset = 0; offset < itemBytes; offset += deltaBytes) {
      for (let item = 0; item < 4; item++) {
        const delta =
          String(offset / deltaBytes).padStart(8, '0') +
          String(item).repeat(deltaBytes - 8);
        pieces[item].push(delta);
        await codex('item/agentMessage/delta', {
          itemId: `prose-${item}`,
          delta,
        });
      }
    }
    for (let item = 0; item < 4; item++) {
      await codex('item/completed', {
        item: {
          type: 'agentMessage',
          id: `prose-${item}`,
          text: pieces[item].join(''),
        },
      });
    }
  } else {
    const patches: Array<{
      index: number;
      block: {
        type: string;
        toolUseId: string;
        toolName: string;
        input?: string;
        output?: string;
        isError?: boolean;
      };
    }> = [];
    for (let index = 0; index < n; index++) {
      patches.push({
        index: index * 2,
        block: {
          type: 'tool_use',
          toolUseId: `tool-${index}`,
          toolName: 'Read',
          input: '{}',
        },
      });
      patches.push({
        index: index * 2 + 1,
        block: {
          type: 'tool_result',
          toolUseId: `tool-${index}`,
          toolName: 'Read',
          output: 'done',
          isError: false,
        },
      });
    }
    now += 10;
    counters.blocksVisited += patches.length;
    await collect(
      await normalizer.patch({
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        role: 'assistant',
        messageId: 'patch',
        timestamp: 0,
        revision: 1,
        patches,
      }),
    );
  }
  await collect(await normalizer.finish());
  await flush();
  counters.materializedRows = materializedRows(
    normalizer,
    counters.rowsAdmitted,
  );
  // eslint-disable-next-line no-console -- benchmark diagnostics are intentionally not assertions.
  console.info(`delegation benchmark ${kind} ${n}`, counters, {
    wallMs: Math.round(performance.now() - start),
    heapBytes: process.memoryUsage().heapUsed,
    admittedBytesPerStreamSecond: Math.round(
      counters.admittedJsonBytes / (now / 1_000),
    ),
  });
  return counters;
}

function scales(
  n: Counters,
  twice: Counters,
  keys: readonly (keyof Counters)[],
): void {
  for (const key of keys) {
    expect(n[key]).toBeGreaterThan(0);
    expect(twice[key]).toBeLessThanOrEqual(2.2 * n[key]);
  }
}

function memoryPort(): InMemoryDelegationTranscriptPort {
  return new InMemoryDelegationTranscriptPort({ owns: (): boolean => true });
}

function target(label: string): DelegationTranscriptTarget {
  return {
    kind: 'delegation',
    chatId: 'chat',
    delegationId: label,
    runGeneration: 1,
  };
}

describe('deterministic delegation stream scaling', () => {
  const roots: string[] = [];
  afterAll(async (): Promise<void> => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
  });
  async function repository(label: string): Promise<{
    fixture: RepositoryTranscriptPortFixture;
    target: DelegationTranscriptTarget;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'delegation-stream-benchmark-'));
    roots.push(root);
    const fixture = await createRepositoryTranscriptPortFixture(root)();
    return { fixture, target: fixture.ownedTarget('chat', label, 1) };
  }

  describe('small items', () => {
    it('scales from 32,769 to 65,538 and matches repository counters at N', async () => {
      const base = await measure(
        memoryPort(),
        target('small-n'),
        'small',
        SMALL_N,
      );
      const double = await measure(
        memoryPort(),
        target('small-2n'),
        'small',
        2 * SMALL_N,
      );
      scales(base, double, [
        'appendCalls',
        'rowsAdmitted',
        'admittedJsonBytes',
        'materializedRows',
        'blocksVisited',
      ]);
      const repo = await repository('small-repo');
      try {
        expect(
          await measure(repo.fixture.port, repo.target, 'small', SMALL_N),
        ).toEqual(base);
      } finally {
        await repo.fixture.close();
      }
    });
  });

  describe('mixed items', () => {
    it('scales from 1,025 to 2,050', async () => {
      scales(
        await measure(memoryPort(), target('mixed-n'), 'mixed', MIXED_N),
        await measure(memoryPort(), target('mixed-2n'), 'mixed', 2 * MIXED_N),
        [
          'appendCalls',
          'rowsAdmitted',
          'admittedJsonBytes',
          'materializedRows',
          'blocksVisited',
        ],
      );
    });
  });

  describe('streamed prose', () => {
    async function runProse(
      n: number,
      deltaBytes: number,
      repositoryParity: boolean,
    ): Promise<void> {
      const base = await measure(
        memoryPort(),
        target(`prose-${n}-${deltaBytes}-n`),
        'prose',
        n,
        deltaBytes,
      );
      const double = await measure(
        memoryPort(),
        target(`prose-${n}-${deltaBytes}-2n`),
        'prose',
        2 * n,
        deltaBytes,
      );
      scales(base, double, [
        'appendCalls',
        'rowsAdmitted',
        'admittedJsonBytes',
        'materializedRows',
        'blocksVisited',
      ]);
      for (const [bytes, result] of [
        [n, base],
        [2 * n, double],
      ] as const) {
        expect(result.maxOpenFieldBytes).toBeLessThanOrEqual(65_536);
        expect(result.maxOpenPublicationsPerItem).toBeLessThanOrEqual(
          Math.ceil(((bytes / deltaBytes + 8) * 10) / 250) + 1,
        );
      }
      if (!repositoryParity) return;
      const repo = await repository(`prose-${n}-${deltaBytes}-repo`);
      try {
        expect(
          await measure(repo.fixture.port, repo.target, 'prose', n, deltaBytes),
        ).toEqual(base);
      } finally {
        await repo.fixture.close();
      }
    }

    it('scales 8 to 16 MiB across four items with changing 1 KiB deltas and repository parity', async () => {
      await runProse(LARGE_PROSE_BYTES, 1_024, true);
    });

    it('scales 1 to 2 MiB across four items with changing 64-byte deltas', async () => {
      await runProse(FINE_PROSE_BYTES, 64, false);
    });
  });

  describe('one patch message', () => {
    it('scales 100 to 200 tool pairs under the per-message block bound', async () => {
      const base = await measure(
        memoryPort(),
        target('patch-n'),
        'patch',
        PATCH_PAIRS,
      );
      const double = await measure(
        memoryPort(),
        target('patch-2n'),
        'patch',
        2 * PATCH_PAIRS,
      );
      scales(base, double, [
        'appendCalls',
        'rowsAdmitted',
        'admittedJsonBytes',
        'materializedRows',
      ]);
      expect(double.blocksVisited).toBe(2 * base.blocksVisited);
    });
  });
});
