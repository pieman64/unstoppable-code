import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
import { InMemoryDelegationTranscriptPort } from '@canopy/desktop-shared/node/delegation/in-memory-transcript-port';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptPort,
  DelegationTranscriptPortResult,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import {
  createCommandOutputSpools,
  type CommandSpoolOperation,
} from '../agents/delegation/command-output-spools';
import { DelegationChildNormalizer } from '../agents/delegation/child-row-normalizers';
import { FieldSpool } from '../lib/chat-transcript-field-spool';
import {
  fakeHandle,
  preparation,
  request as codexRequest,
  run as runCodex,
  type TurnRequest,
} from './helpers/delegation-runner-fixtures/codex';
import {
  createRepositoryTranscriptPortFixture,
  type RepositoryTranscriptPortFixture,
} from './helpers/repository-transcript-port-fixture';

jest.setTimeout(240_000);

function value<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok)
    throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const marker = 'OMITTED_MIDDLE_UNIQUE_10A';
const previewMarker = '[Preview: full text is kept when this item finishes]';
const thread = { threadId: 'thread-acceptance', turnId: 'turn-acceptance' };

function codex(
  normalizer: DelegationChildNormalizer,
  method: string,
  params: Record<string, unknown>,
): Promise<readonly DelegationTranscriptChange[]> {
  return normalizer.codex({ method, params: { ...thread, ...params } });
}

function text(row: DelegationChildRow): string {
  const block = row.blocks[0];
  if (block?.type !== 'text') throw new Error('Expected a text block');
  return block.text;
}

function commandOutput(row: DelegationChildRow): string {
  const block = row.blocks.find(
    (candidate) => candidate.type === 'tool_result',
  );
  if (!block || block.type !== 'tool_result')
    throw new Error('Expected a command result block');
  return block.output;
}

function gate(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type C28PortKind = 'memory' | 'repository';
type C28RequiredSpoolOperation = Extract<
  CommandSpoolOperation,
  'append' | 'finish' | 'read'
>;

const C28_PORT_KINDS: readonly C28PortKind[] = ['memory', 'repository'];
const C28_REQUIRED_SPOOL_OPERATIONS: readonly C28RequiredSpoolOperation[] = [
  'append',
  'finish',
  'read',
];
const C28_REQUIRED_CASES: readonly {
  readonly portKind: C28PortKind;
  readonly operation: C28RequiredSpoolOperation;
}[] = C28_PORT_KINDS.flatMap((portKind) =>
  C28_REQUIRED_SPOOL_OPERATIONS.map((operation) => ({ portKind, operation })),
);

interface C28TranscriptFixture {
  readonly port: DelegationTranscriptPort;
  readonly target: DelegationTranscriptTarget;
  readonly repository?: RepositoryTranscriptPortFixture;
}

async function countTree(root: string): Promise<{
  readonly directories: number;
  readonly files: number;
}> {
  let directories = 0;
  let files = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        directories += 1;
        await visit(join(directory, entry.name));
      } else if (entry.isFile()) files += 1;
    }
  };
  await visit(root);
  return { directories, files };
}

async function assertSpoolsDrained(
  root: string,
  createdHandles: number,
  closedHandles: number,
): Promise<void> {
  expect(createdHandles).toBeGreaterThan(0);
  expect(closedHandles).toBe(createdHandles);
  expect(await readdir(root)).toEqual([]);
  expect(await countTree(root)).toEqual({ directories: 0, files: 0 });
}

function runnerRequest(target: DelegationTranscriptTarget): AgentRunRequest {
  return {
    ...codexRequest,
    delegationId: target.delegationId,
    runGeneration: target.runGeneration,
    parent: { ...codexRequest.parent, chatId: target.chatId },
    signal: new AbortController().signal,
    transcriptStream: { target },
  };
}

function turnStartEvent(
  threadId: string,
  turnId: string,
): { method: string; params: Record<string, unknown> } {
  return {
    method: 'turn/started',
    params: { threadId, turn: { id: turnId } },
  };
}

function commandStartEvent(
  threadId: string,
  turnId: string,
): { method: string; params: Record<string, unknown> } {
  return {
    method: 'item/started',
    params: {
      threadId,
      turnId,
      item: {
        type: 'commandExecution',
        id: 'command-c28',
        command: 'printf test-output',
        status: 'inProgress',
        aggregatedOutput: null,
      },
    },
  };
}

function commandDeltaEvent(
  threadId: string,
  turnId: string,
  delta: string,
): { method: string; params: Record<string, unknown> } {
  return {
    method: 'item/commandExecution/outputDelta',
    params: { threadId, turnId, itemId: 'command-c28', delta },
  };
}

function commandCompleteEvent(
  threadId: string,
  turnId: string,
): { method: string; params: Record<string, unknown> } {
  return {
    method: 'item/completed',
    params: {
      threadId,
      turnId,
      item: {
        type: 'commandExecution',
        id: 'command-c28',
        command: 'printf test-output',
        status: 'completed',
        exitCode: 0,
      },
    },
  };
}

async function sendCodexEvent(
  turn: TurnRequest,
  event: { method: string; params: Record<string, unknown> },
): Promise<void> {
  if (!turn.onEvent) throw new Error('Codex event callback was not registered');
  await turn.onEvent(event);
}

async function range(
  port: DelegationTranscriptPort,
  target: DelegationTranscriptTarget,
  revision: number,
  id: string,
): Promise<string> {
  let offset = 0;
  let output = '';
  while (true) {
    const part = value(
      await port.contentRange({
        target,
        streamRevision: revision,
        messageId: id,
        blockOrdinal: 0,
        field: 'text',
        offset,
        limit: 65_536,
      }),
    );
    output += part.text;
    if (part.nextOffset === undefined) return output;
    offset = part.nextOffset;
  }
}

async function admit(
  port: DelegationTranscriptPort,
  target: DelegationTranscriptTarget,
  normalizer: DelegationChildNormalizer,
  changes: readonly DelegationTranscriptChange[],
  key: string,
): Promise<number | undefined> {
  if (changes.length === 0) return undefined;
  const receipt = value(
    await port.appendChanges({ target, mutationKey: key, changes }),
  );
  normalizer.acknowledge(changes);
  return receipt.streamRevision;
}

async function proseScenario(
  port: DelegationTranscriptPort,
  target: DelegationTranscriptTarget,
  reopen?: () => Promise<DelegationTranscriptPort>,
): Promise<void> {
  let now = 0;
  let key = 0;
  const normalizer = new DelegationChildNormalizer('agent', {
    now: (): number => now,
  });
  value(await port.open({ target }));
  const start = await codex(normalizer, 'item/started', {
    item: { type: 'agentMessage', id: 'prose', text: '' },
  });
  let openPublications = start.length;
  await admit(port, target, normalizer, start, `prose-${key++}`);
  const chunks = ['H'.repeat(100_000), marker, 'T'.repeat(100_000)];
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1_000) {
      now += 10;
      const changes = await codex(normalizer, 'item/agentMessage/delta', {
        itemId: 'prose',
        delta: chunk.slice(index, index + 1_000),
      });
      openPublications += changes.length;
      await admit(port, target, normalizer, changes, `prose-${key++}`);
    }
  }
  now += 250;
  const tick = await codex(normalizer, 'thread/notification', {});
  openPublications += tick.length;
  await admit(port, target, normalizer, tick, `prose-${key++}`);
  expect(openPublications).toBeLessThanOrEqual(Math.ceil(now / 250) + 1);
  const revision = value(await port.open({ target })).streamRevision;
  const page = value(
    await port.page({ target, streamRevision: revision ?? 0 }),
  );
  expect(page.rows).toHaveLength(1);
  const id = page.rows[0].id;
  const preview = text(page.rows[0]);
  expect(preview).toContain(previewMarker);
  expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(65_536);
  expect(preview.includes(marker)).toBe(false);
  expect(
    text(
      value(
        await port.message({
          target,
          streamRevision: revision ?? 0,
          messageId: id,
        }),
      ),
    ),
  ).toBe(preview);
  expect(await range(port, target, revision ?? 0, id)).toBe(preview);
  if (reopen) {
    port = await reopen();
    expect(
      text(
        value(await port.page({ target, streamRevision: revision ?? 0 }))
          .rows[0],
      ),
    ).toBe(preview);
    expect(
      text(
        value(
          await port.message({
            target,
            streamRevision: revision ?? 0,
            messageId: id,
          }),
        ),
      ),
    ).toBe(preview);
    expect(await range(port, target, revision ?? 0, id)).toBe(preview);
  }
  const full = chunks.join('');
  const final = await codex(normalizer, 'item/completed', {
    item: { type: 'agentMessage', id: 'prose', text: full },
  });
  const finalRevision = await admit(
    port,
    target,
    normalizer,
    final,
    `prose-${key++}`,
  );
  expect(finalRevision).toBeDefined();
  const finalRow = value(
    await port.message({
      target,
      streamRevision: finalRevision ?? 0,
      messageId: id,
    }),
  );
  expect(finalRow.final).toBe(true);
  expect(text(finalRow)).toBe(full);
  expect(await range(port, target, finalRevision ?? 0, id)).toBe(full);
}

describe('delegation stream acceptance', () => {
  const roots: string[] = [];
  const repositoryFixtures: RepositoryTranscriptPortFixture[] = [];
  afterEach(async (): Promise<void> => {
    jest.restoreAllMocks();
    for (const repository of repositoryFixtures.splice(0))
      await repository.close();
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  });
  async function testRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'delegation-stream-c28-'));
    roots.push(root);
    return root;
  }
  async function fixture(): Promise<RepositoryTranscriptPortFixture> {
    const root = await mkdtemp(join(tmpdir(), 'delegation-stream-acceptance-'));
    roots.push(root);
    return createRepositoryTranscriptPortFixture(root)();
  }
  async function c28Fixture(
    kind: C28PortKind,
    root: string,
    delegationId: string,
  ): Promise<C28TranscriptFixture> {
    if (kind === 'repository') {
      const repository = await createRepositoryTranscriptPortFixture(root)();
      repositoryFixtures.push(repository);
      return {
        port: repository.port,
        target: repository.ownedTarget('chat', delegationId, 1),
        repository,
      };
    }
    const target: DelegationTranscriptTarget = {
      kind: 'delegation',
      chatId: 'chat',
      delegationId,
      runGeneration: 1,
    };
    return {
      port: new InMemoryDelegationTranscriptPort({ owns: (): boolean => true }),
      target,
    };
  }
  function activePort(fixture: C28TranscriptFixture): DelegationTranscriptPort {
    return fixture.repository?.port ?? fixture.port;
  }
  async function checkpointAndReopen(
    fixture: C28TranscriptFixture,
  ): Promise<void> {
    const repository = fixture.repository;
    if (!repository) return;
    await repository.repository.flushScope(repository.scope);
    const previousPort = repository.port;
    await repository.reopen();
    expect(repository.port).not.toBe(previousPort);
  }
  async function rows(
    fixture: C28TranscriptFixture,
  ): Promise<readonly DelegationChildRow[]> {
    const port = activePort(fixture);
    const state = value(await port.open({ target: fixture.target }));
    return value(
      await port.page({
        target: fixture.target,
        streamRevision: state.streamRevision,
        limit: 512,
      }),
    ).rows;
  }
  async function spoolRoot(root: string): Promise<string> {
    const path = join(root, 'spools');
    await mkdir(path, { recursive: true });
    return path;
  }

  it('persists the open prose preview across reopen and restores exact final content', async () => {
    const f = await fixture();
    try {
      await proseScenario(
        f.port,
        f.ownedTarget('chat', 'prose', 1),
        async (): Promise<DelegationTranscriptPort> => {
          await f.reopen();
          return f.port;
        },
      );
    } finally {
      await f.close();
    }
  });

  it('keeps in-memory logical rows in parity with the preview and final read contract', async () => {
    const port = new InMemoryDelegationTranscriptPort({
      owns: (): boolean => true,
    });
    await proseScenario(port, {
      kind: 'delegation',
      chatId: 'chat',
      delegationId: 'prose',
      runGeneration: 1,
    });
  });

  it('refuses a direct 17 MiB open row but admits a normalizer preview and exact final', async () => {
    const f = await fixture();
    try {
      const target = f.ownedTarget('chat', 'large', 1);
      value(await f.port.open({ target }));
      const full = 'A'.repeat(8_500_000) + marker + 'Z'.repeat(8_500_000);
      const direct: DelegationChildRow = {
        id: 'direct',
        role: 'assistant',
        timestamp: 0,
        parentBlockId: 'agent',
        delegationSequence: 0,
        delegationSegment: 'direct',
        itemRevision: 0,
        final: false,
        blocks: [{ type: 'text', text: full }],
      };
      expect(
        await f.port.appendChanges({
          target,
          mutationKey: 'direct',
          changes: [{ row: direct }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'storage_failure' } });
      expect(value(await f.port.open({ target })).streamRevision).toBe(0);
      let now = 0;
      const normalizer = new DelegationChildNormalizer('agent', {
        now: (): number => now,
      });
      const start = await codex(normalizer, 'item/started', {
        item: { type: 'agentMessage', id: 'huge', text: '' },
      });
      await admit(f.port, target, normalizer, start, 'huge-start');
      for (let index = 0; index < full.length; index += 128_000) {
        now += 10;
        await admit(
          f.port,
          target,
          normalizer,
          await codex(normalizer, 'item/agentMessage/delta', {
            itemId: 'huge',
            delta: full.slice(index, index + 128_000),
          }),
          `huge-${index}`,
        );
      }
      const open = value(
        await f.port.page({
          target,
          streamRevision: value(await f.port.open({ target })).streamRevision,
        }),
      );
      expect(Buffer.byteLength(text(open.rows[0]))).toBeLessThan(65_537);
      expect(text(open.rows[0])).not.toContain(marker);
      const final = await codex(normalizer, 'item/completed', {
        item: { type: 'agentMessage', id: 'huge', text: full },
      });
      const revision = await admit(
        f.port,
        target,
        normalizer,
        final,
        'huge-final',
      );
      const row = value(
        await f.port.message({
          target,
          streamRevision: revision ?? 0,
          messageId: open.rows[0].id,
        }),
      );
      expect(Buffer.byteLength(text(row))).toBe(Buffer.byteLength(full));
      expect(text(row).slice(0, 40)).toBe(full.slice(0, 40));
      expect(text(row).slice(8_500_000, 8_500_000 + marker.length)).toBe(
        marker,
      );
      expect(text(row).slice(-40)).toBe(full.slice(-40));
      const middle = value(
        await f.port.contentRange({
          target,
          streamRevision: revision ?? 0,
          messageId: open.rows[0].id,
          blockOrdinal: 0,
          field: 'text',
          offset: 8_500_000,
          limit: marker.length,
        }),
      );
      expect(middle.text).toBe(marker);
      expect(middle.byteLength).toBe(Buffer.byteLength(full));
    } finally {
      await f.close();
    }
  });

  it('orders an early open row before later finals, exactly once after reopen', async () => {
    const f = await fixture();
    try {
      const target = f.ownedTarget('chat', 'order', 1);
      value(await f.port.open({ target }));
      const normalizer = new DelegationChildNormalizer('agent', {
        now: (): number => 0,
      });
      await admit(
        f.port,
        target,
        normalizer,
        await codex(normalizer, 'item/started', {
          item: { type: 'agentMessage', id: 'early', text: 'early' },
        }),
        'order-early',
      );
      for (let index = 0; index < 30; index++) {
        await admit(
          f.port,
          target,
          normalizer,
          await codex(normalizer, 'item/completed', {
            item: {
              type: 'agentMessage',
              id: `later-${index}`,
              text: `final-${index}`,
            },
          }),
          `order-${index}`,
        );
      }
      const revision = value(await f.port.open({ target })).streamRevision;
      await f.reopen();
      const rows = value(
        await f.port.page({ target, streamRevision: revision, limit: 100 }),
      ).rows;
      expect(rows).toHaveLength(31);
      expect(rows.map((row) => row.delegationSequence)).toEqual(
        Array.from({ length: 31 }, (_, index) => index),
      );
      expect(new Set(rows.map((row) => row.id)).size).toBe(31);
      expect(rows.slice(1).every((row) => row.final)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('keeps a many-block patch as separately admitted rows rather than silently dropping blocks', async () => {
    const f = await fixture();
    try {
      const target = f.ownedTarget('chat', 'many-blocks', 1);
      value(await f.port.open({ target }));
      const normalizer = new DelegationChildNormalizer('agent', {
        now: (): number => 0,
      });
      const blocks = Array.from({ length: 280 }, (_, index) => ({
        index,
        block: { type: 'text', text: `${index}:${'x'.repeat(60_000)}` },
      }));
      expect(
        blocks.reduce(
          (size, patch) => size + Buffer.byteLength(patch.block.text),
          0,
        ),
      ).toBeGreaterThan(16 * 1_024 * 1_024);
      const changes = await normalizer.patch({
        type: 'canopy_assistant_patch',
        provider: 'cursor',
        role: 'assistant',
        messageId: 'many',
        timestamp: 0,
        revision: 1,
        patches: blocks,
      });
      expect(changes).toHaveLength(blocks.length);
      expect(new Set(changes.map((change) => change.row.id)).size).toBe(
        blocks.length,
      );
      const receipt = value(
        await f.port.appendChanges({
          target,
          mutationKey: 'many-blocks',
          changes,
        }),
      );
      normalizer.acknowledge(changes);
      // Child pages are bounded by bytes (phase 16a), so read every page.
      const rows: DelegationChildRow[] = [];
      let cursor: string | undefined;
      do {
        const page = value(
          await f.port.page({
            target,
            streamRevision: receipt.streamRevision,
            limit: 512,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        rows.push(...page.rows);
        cursor = page.cursor;
      } while (cursor !== undefined);
      expect(rows).toHaveLength(blocks.length);
      expect(new Set(rows.map((row) => row.id)).size).toBe(blocks.length);
      expect(rows.every((row) => row.blocks.length === 1)).toBe(true);
    } finally {
      await f.close();
    }
  });

  it.each(C28_PORT_KINDS)(
    'orders receipts behind slow admission and drains real Codex spools on the %s port',
    async (portKind) => {
      const root = await testRoot();
      const fixture = await c28Fixture(portKind, root, `c28-slow-${portKind}`);
      const active = activePort(fixture);
      const spoolDirectory = await spoolRoot(root);
      const created = jest.spyOn(FieldSpool, 'create');
      const closed = jest.spyOn(FieldSpool.prototype, 'close');
      const firstAdmission = gate();
      const releaseAdmission = gate();
      const admissions: {
        readonly mutationKey: string;
        readonly target: DelegationTranscriptTarget;
        readonly items: readonly {
          readonly id: string;
          readonly final: boolean;
        }[];
      }[] = [];
      const append = active.appendChanges.bind(active);
      jest
        .spyOn(active, 'appendChanges')
        .mockImplementation(async (input, signal) => {
          admissions.push({
            mutationKey: input.mutationKey,
            target: input.target,
            items: input.changes.map(({ row }) => ({
              id: row.id,
              final: row.final,
            })),
          });
          if (admissions.length === 1) {
            firstAdmission.release();
            await releaseAdmission.promise;
          }
          return append(input, signal);
        });
      const threadId = 'thread-c28-slow';
      const turnId = 'turn-c28-slow';
      const handle = fakeHandle(threadId, async (turn) => {
        await sendCodexEvent(turn, turnStartEvent(threadId, turnId));
        const started = turn.onEvent?.(commandStartEvent(threadId, turnId));
        const firstDelta = turn.onEvent?.(
          commandDeltaEvent(threadId, turnId, 'slow-'),
        );
        const secondDelta = turn.onEvent?.(
          commandDeltaEvent(threadId, turnId, 'admission'),
        );
        const completed = turn.onEvent?.(
          commandCompleteEvent(threadId, turnId),
        );
        const prose = turn.onEvent?.({
          method: 'item/completed',
          params: {
            threadId,
            turnId,
            item: {
              type: 'agentMessage',
              id: 'message-after-command',
              phase: 'commentary',
              text: 'after command',
            },
          },
        });
        await Promise.all([started, firstDelta, secondDelta, completed, prose]);
        return { status: 'completed', text: 'done' };
      });
      const harness = runCodex({
        prepare: () => Promise.resolve(preparation()),
        handles: [handle],
        runRequest: runnerRequest(fixture.target),
        transcriptPort: active,
        spools: () => createCommandOutputSpools({ root: () => spoolDirectory }),
      });

      await firstAdmission.promise;
      expect(admissions).toHaveLength(1);
      expect(
        harness.events.filter((event) => event.type === 'transcript_receipt'),
      ).toHaveLength(0);
      releaseAdmission.release();
      await expect(harness.terminal).resolves.toMatchObject({
        type: 'terminal',
        status: 'completed',
      });

      const receipts = harness.events.filter(
        (event) => event.type === 'transcript_receipt',
      );
      expect(receipts).toHaveLength(admissions.length);
      expect(receipts.map((receipt) => receipt.mutationKey)).toEqual(
        admissions.map((admission) => admission.mutationKey),
      );
      expect(
        receipts.flatMap((receipt) => receipt.items.map((item) => item.id)),
      ).toEqual(
        admissions.flatMap((admission) =>
          admission.items.map((item) => item.id),
        ),
      );
      expect(
        admissions.every(
          (admission) =>
            JSON.stringify(admission.target) === JSON.stringify(fixture.target),
        ),
      ).toBe(true);
      for (let index = 1; index < receipts.length; index += 1)
        expect(receipts[index]?.streamRevision).toBeGreaterThan(
          receipts[index - 1]?.streamRevision ?? 0,
        );
      await assertSpoolsDrained(
        spoolDirectory,
        created.mock.calls.length,
        closed.mock.calls.length,
      );

      await checkpointAndReopen(fixture);
      const persisted = await rows(fixture);
      const command = persisted.find((row) => row.id.endsWith('::command-c28'));
      if (!command)
        throw new Error('The completed Codex command was not stored');
      expect(command.final).toBe(true);
      expect(commandOutput(command)).toBe('slow-admission');
      expect(
        persisted.some((row) =>
          row.blocks.some(
            (block) => block.type === 'text' && block.text === 'after command',
          ),
        ),
      ).toBe(true);
    },
  );

  it.each(C28_PORT_KINDS)(
    'keeps healthy cancellation and command finalization clean on the %s port',
    async (portKind) => {
      const root = await testRoot();
      const fixture = await c28Fixture(
        portKind,
        root,
        `c28-cancel-${portKind}`,
      );
      const spoolDirectory = await spoolRoot(root);
      const created = jest.spyOn(FieldSpool, 'create');
      const closed = jest.spyOn(FieldSpool.prototype, 'close');
      const outputStored = gate();
      const threadId = 'thread-c28-cancel';
      const turnId = 'turn-c28-cancel';
      const handle = fakeHandle(threadId, async (turn, interrupted) => {
        await sendCodexEvent(turn, turnStartEvent(threadId, turnId));
        await sendCodexEvent(turn, commandStartEvent(threadId, turnId));
        await sendCodexEvent(
          turn,
          commandDeltaEvent(threadId, turnId, 'healthy partial output'),
        );
        outputStored.release();
        await interrupted;
        return { status: 'interrupted', text: '' };
      });
      const harness = runCodex({
        prepare: () => Promise.resolve(preparation()),
        handles: [handle],
        runRequest: runnerRequest(fixture.target),
        transcriptPort: activePort(fixture),
        spools: () => createCommandOutputSpools({ root: () => spoolDirectory }),
      });

      await outputStored.promise;
      await harness.stop();
      await expect(harness.terminal).resolves.toMatchObject({
        type: 'terminal',
        status: 'cancelled',
      });
      await assertSpoolsDrained(
        spoolDirectory,
        created.mock.calls.length,
        closed.mock.calls.length,
      );
      await checkpointAndReopen(fixture);
      const command = (await rows(fixture)).find((row) =>
        row.id.endsWith('::command-c28'),
      );
      if (!command)
        throw new Error('The interrupted Codex command was not stored');
      expect(command.final).toBe(true);
      expect(commandOutput(command)).toBe('healthy partial output');
      expect(JSON.stringify(command.blocks)).toContain('"isError":true');
    },
  );

  it.each(C28_REQUIRED_CASES)(
    'latches a gated $operation spool failure over Stop on the $portKind port and removes every handle/file',
    async ({ portKind, operation }) => {
      const root = await testRoot();
      const fixture = await c28Fixture(
        portKind,
        root,
        `c28-${operation}-${portKind}`,
      );
      const spoolDirectory = await spoolRoot(root);
      const created = jest.spyOn(FieldSpool, 'create');
      const closed = jest.spyOn(FieldSpool.prototype, 'close');
      const operationStarted = gate();
      const releaseOperation = gate();
      const failure = new Error(`injected required ${operation}`);
      const operations: {
        readonly operation: CommandSpoolOperation;
        readonly key: string;
      }[] = [];
      let injected = false;
      const reportError = jest.fn();
      const threadId = `thread-c28-${operation}`;
      const turnId = `turn-c28-${operation}`;
      const handle = fakeHandle(threadId, async (turn, interrupted) => {
        await sendCodexEvent(turn, turnStartEvent(threadId, turnId));
        await sendCodexEvent(turn, commandStartEvent(threadId, turnId));
        if (operation === 'append') {
          void turn.onEvent?.(
            commandDeltaEvent(threadId, turnId, 'uncommitted output'),
          );
        } else {
          await sendCodexEvent(
            turn,
            commandDeltaEvent(threadId, turnId, 'uncommitted output'),
          );
          void turn.onEvent?.(commandCompleteEvent(threadId, turnId));
        }
        await interrupted;
        return { status: 'interrupted', text: '' };
      });
      const harness = runCodex({
        prepare: () => Promise.resolve(preparation()),
        handles: [handle],
        runRequest: runnerRequest(fixture.target),
        transcriptPort: activePort(fixture),
        spools: () =>
          createCommandOutputSpools({
            root: () => spoolDirectory,
            faults: {
              before: async (currentOperation, key): Promise<void> => {
                operations.push({ operation: currentOperation, key });
                if (currentOperation !== operation || injected) return;
                injected = true;
                operationStarted.release();
                await releaseOperation.promise;
                throw failure;
              },
            },
          }),
        reportError,
      });

      await operationStarted.promise;
      const stopping = harness.stop();
      await Promise.resolve();
      expect(handle.interrupt).toHaveBeenCalledTimes(1);
      releaseOperation.release();
      await stopping;
      await expect(harness.terminal).resolves.toMatchObject({
        type: 'terminal',
        status: 'failed',
        error: {
          code: 'runtime_error',
          message:
            'The delegated transcript could not be saved. Retained partial output is available.',
        },
      });
      expect(reportError).toHaveBeenCalledWith(failure);
      const failedAt = operations.findIndex(
        (entry) => entry.operation === operation,
      );
      const closedAt = operations.findIndex(
        (entry) => entry.operation === 'close',
      );
      const removedAt = operations.findIndex(
        (entry) => entry.operation === 'remove' && entry.key === '',
      );
      expect(failedAt).toBeGreaterThanOrEqual(0);
      expect(failedAt).toBeLessThan(closedAt);
      expect(closedAt).toBeLessThan(removedAt);
      await assertSpoolsDrained(
        spoolDirectory,
        created.mock.calls.length,
        closed.mock.calls.length,
      );
      await checkpointAndReopen(fixture);
    },
  );

  it.each(C28_PORT_KINDS)(
    'attributes a rejected final admission to transcript storage and still drains spools on the %s port',
    async (portKind) => {
      const root = await testRoot();
      const fixture = await c28Fixture(
        portKind,
        root,
        `c28-rejected-${portKind}`,
      );
      const active = activePort(fixture);
      const spoolDirectory = await spoolRoot(root);
      const created = jest.spyOn(FieldSpool, 'create');
      const closed = jest.spyOn(FieldSpool.prototype, 'close');
      const append = active.appendChanges.bind(active);
      const attempts: {
        readonly target: DelegationTranscriptTarget;
        readonly finalIds: readonly string[];
      }[] = [];
      let rejectedFinal:
        | Parameters<DelegationTranscriptPort['appendChanges']>[0]
        | undefined;
      jest
        .spyOn(active, 'appendChanges')
        .mockImplementation(async (input, signal) => {
          const finalIds = input.changes
            .filter(({ row }) => row.final && row.id.endsWith('::command-c28'))
            .map(({ row }) => row.id);
          attempts.push({ target: input.target, finalIds });
          if (finalIds.length > 0) {
            rejectedFinal ??= input;
            return {
              ok: false,
              error: {
                code: 'storage_failure',
                message: 'Injected transcript admission failure',
                retryable: false,
              },
            };
          }
          return append(input, signal);
        });
      const threadId = 'thread-c28-rejected';
      const turnId = 'turn-c28-rejected';
      const handle = fakeHandle(threadId, async (turn) => {
        await sendCodexEvent(turn, turnStartEvent(threadId, turnId));
        await sendCodexEvent(turn, commandStartEvent(threadId, turnId));
        await sendCodexEvent(
          turn,
          commandDeltaEvent(threadId, turnId, 'rejected-output'),
        );
        await sendCodexEvent(turn, commandCompleteEvent(threadId, turnId));
        return { status: 'completed', text: 'done' };
      });
      const harness = runCodex({
        prepare: () => Promise.resolve(preparation()),
        handles: [handle],
        runRequest: runnerRequest(fixture.target),
        transcriptPort: active,
        spools: () => createCommandOutputSpools({ root: () => spoolDirectory }),
      });

      await expect(harness.terminal).resolves.toMatchObject({
        type: 'terminal',
        status: 'failed',
        error: {
          code: 'runtime_error',
          message:
            'The delegated transcript could not be saved. Retained partial output is available.',
        },
      });
      expect(rejectedFinal).toBeDefined();
      expect(attempts.some((attempt) => attempt.finalIds.length > 0)).toBe(
        true,
      );
      expect(
        attempts.every(
          (attempt) =>
            JSON.stringify(attempt.target) === JSON.stringify(fixture.target),
        ),
      ).toBe(true);
      const acceptedReceipts = harness.events.filter(
        (event) => event.type === 'transcript_receipt',
      );
      expect(
        acceptedReceipts.flatMap((receipt) =>
          receipt.items.filter((item) => item.final).map((item) => item.id),
        ),
      ).toEqual([]);
      await assertSpoolsDrained(
        spoolDirectory,
        created.mock.calls.length,
        closed.mock.calls.length,
      );
      await checkpointAndReopen(fixture);
    },
  );

  it('retries a failed repository admission, checkpoints it, and reads it through a fresh port instance', async () => {
    const root = await testRoot();
    const fixture = await c28Fixture(
      'repository',
      root,
      'c28-repository-retry',
    );
    const repository = fixture.repository;
    if (!repository) throw new Error('Expected the repository transcript port');
    const active = activePort(fixture);
    const spoolDirectory = await spoolRoot(root);
    const created = jest.spyOn(FieldSpool, 'create');
    const closed = jest.spyOn(FieldSpool.prototype, 'close');
    const append = active.appendChanges.bind(active);
    const attempts: Parameters<DelegationTranscriptPort['appendChanges']>[0][] =
      [];
    let failedFinal:
      | Parameters<DelegationTranscriptPort['appendChanges']>[0]
      | undefined;
    jest
      .spyOn(active, 'appendChanges')
      .mockImplementation(async (input, signal) => {
        attempts.push(input);
        const result = await append(input, signal);
        if (
          result.ok === false &&
          input.changes.some(
            ({ row }) => row.final && row.id.endsWith('::command-c28'),
          )
        )
          failedFinal = input;
        return result;
      });
    const threadId = 'thread-c28-repository-retry';
    const turnId = 'turn-c28-repository-retry';
    const handle = fakeHandle(threadId, async (turn) => {
      await sendCodexEvent(turn, turnStartEvent(threadId, turnId));
      await sendCodexEvent(turn, commandStartEvent(threadId, turnId));
      await sendCodexEvent(
        turn,
        commandDeltaEvent(threadId, turnId, 'repository-retry'),
      );
      repository.injectStorageFailure('before-write');
      await sendCodexEvent(turn, commandCompleteEvent(threadId, turnId));
      return { status: 'completed', text: 'done' };
    });
    const harness = runCodex({
      prepare: () => Promise.resolve(preparation()),
      handles: [handle],
      runRequest: runnerRequest(fixture.target),
      transcriptPort: active,
      spools: () => createCommandOutputSpools({ root: () => spoolDirectory }),
    });

    await expect(harness.terminal).resolves.toMatchObject({
      type: 'terminal',
      status: 'failed',
      error: {
        code: 'runtime_error',
        message:
          'The delegated transcript could not be saved. Retained partial output is available.',
      },
    });
    expect(failedFinal).toBeDefined();
    expect(
      attempts.some((input) => input.changes.some(({ row }) => row.final)),
    ).toBe(true);
    await assertSpoolsDrained(
      spoolDirectory,
      created.mock.calls.length,
      closed.mock.calls.length,
    );

    const retryInput = failedFinal;
    if (!retryInput)
      throw new Error('The failed repository admission was not captured');
    const retry = value(await append(retryInput));
    expect(retry.target).toEqual(fixture.target);
    expect(retry.mutationKey).toBe(retryInput.mutationKey);
    await repository.repository.flushScope(repository.scope);
    const previousPort = repository.port;
    await repository.reopen();
    expect(repository.port).not.toBe(previousPort);
    const command = (await rows(fixture)).find((row) =>
      row.id.endsWith('::command-c28'),
    );
    if (!command)
      throw new Error('The retried command was not stored after reopen');
    expect(command.final).toBe(true);
    expect(commandOutput(command)).toBe('repository-retry');
  });

  it.todo(
    'captures an open command-output prefix concurrently (not passed: this suite verifies orderly finalization and reopen, not crash-time open-file capture)',
  );
});
