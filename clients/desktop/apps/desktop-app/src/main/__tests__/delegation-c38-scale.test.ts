import { Buffer } from 'node:buffer';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import type {
  CardState,
  TranscriptStreamDescriptor,
} from '@canopy/protocol/canopy-core';
import type { DelegationTranscriptResultEntry } from '@canopy/desktop-shared/node/delegation/transcript-port';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import {
  C38_MANIFEST,
  c38Backing,
  c38CreationBytes,
  c38ProbeIndices,
  c38Target,
  type C38Backing,
  type C38Card,
  type C38Operation,
  type C38Size,
} from './helpers/delegation-c38-harness';
import {
  evaluateC38StatusWindow,
  installC38Observation,
  measureC38SerializedSizes,
  sampleC38Memory,
  type C38MemorySample,
  type C38IoWindow,
  type C38ObservationWindow,
} from './helpers/delegation-c38-observation';

// Bounds are byte/count assertions, not wall-clock thresholds. A cold small
// fixture plus ten real reopen cycles can exceed one minute on shared CI.
jest.setTimeout(180_000);

const MiB = 1024 * 1024;
type RawMessage = NonNullable<Awaited<ReturnType<C38Backing['rawCard']>>>;
let inFlightCase: Promise<void> | undefined;

// Jest does not cancel an async body on timeout. Wait for its finally block
// before permitting another fixture/global observer in this file.
afterEach(async () => {
  await inFlightCase?.catch(() => undefined);
  inFlightCase = undefined;
}, 30 * 60_000);

function serialCase(run: () => Promise<void>): () => Promise<void> {
  return () => {
    inFlightCase = run();
    return inFlightCase;
  };
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function rawRows(path: string): Promise<readonly string[]> {
  return (await fs.readFile(path, 'utf8')).trimEnd().split('\n');
}

function referenceRow(rows: readonly string[]): string | undefined {
  return rows.find((row) => row.includes('"id":"seed-reference"'));
}

function cardRow(rows: readonly string[], card: C38Card): string {
  const row = rows.find((candidate) =>
    candidate.startsWith(`{"id":${JSON.stringify(card.messageId)},`),
  );
  if (!row) throw new Error(`Missing creation row ${card.messageId}`);
  return row;
}

function rawBlock(
  row: RawMessage,
): Extract<RawMessage['blocks'][number], { type: 'delegated_agent_call' }> {
  const block = row.blocks.find((item) => item.type === 'delegated_agent_call');
  if (!block || block.type !== 'delegated_agent_call')
    throw new Error('Missing creation card block');
  return block;
}

/** Only nondeterministic identity/time facts come from the raw row. All
 * workload, route, state and prompt fields below are independent literals.
 * In particular A never consumes a candidate buffer, row spread or diff. */
function expectedCreation(
  card: C38Card,
  row: RawMessage,
  ordinal?: number,
): RawMessage {
  const block = rawBlock(row);
  const operationId = block.control?.operationId;
  if (card.runGeneration > 1 && operationId === undefined)
    throw new Error('Continuation is missing its control identity');
  const expectedId = `delegated-agent-${card.delegationId}${card.runGeneration > 1 ? `-run-${card.runGeneration}` : ''}`;
  return {
    id: expectedId,
    role: 'assistant',
    timestamp: row.timestamp,
    blocks: [
      {
        delegationId: card.delegationId,
        depth: 1,
        nestedDelegation: 'not_enabled',
        runGeneration: card.runGeneration,
        permissions: { writePaths: card.isolated ? ['src'] : [] },
        status: 'pending',
        ...(card.runGeneration > 1 && operationId !== undefined
          ? {
              control: {
                operationId,
                operation: 'follow_up',
                status: 'completed',
              },
            }
          : {}),
        ...(card.isolated
          ? {
              isolatedWorkspace: {
                revision: 'a'.repeat(40),
                dirtyParentChangesIncluded: false,
              },
            }
          : {}),
        routeSnapshot: {
          selectedModelId: 'logical-review-model',
          runtimeModelId: 'native-model',
          harnessId: 'third-harness',
          runtimeKind: 'local-sdk',
          runnerRegistrationId: 'third-local',
          runtimeVersion: '1.0',
          adapterVersion: '1',
          modelSource: 'test',
          providerType: 'test-inference',
          assignmentRevision: 'assignment-1',
          billingAuthority: 'native',
          aiCreditsRouted: false,
          capabilities: ['read', 'write', 'worktree', 'progress', 'resume'],
          supportedThinkingLevels: ['low', 'high'],
          capabilitySnapshotHash: 'capability-1',
          capabilityGeneration: 1,
          policyRevision: 'read-only-1',
        },
        outputTruncated: false,
        type: 'delegated_agent_call',
        agentBlockId: expectedId,
        sequence: 0,
        parentHarnessId: 'claude',
        parentTurnId: 'c38-origin',
        parentToolCallId:
          ordinal === undefined
            ? block.parentToolCallId
            : `c38-call-${ordinal}`,
        createdAt: row.timestamp,
        selectedModelId: 'logical-review-model',
        runtimeModelId: 'native-model',
        targetHarnessId: 'third-harness',
        description: 'd'.repeat(64),
        prompt: (card.runGeneration > 1 ? 'f' : 'p').repeat(256),
        executionMode: 'background',
        transcriptStore: 'chat-stream-v2',
      },
    ],
  };
}

async function states(
  backing: C38Backing,
  cards: readonly C38Card[],
): Promise<{
  descriptors: TranscriptStreamDescriptor[];
  cardStates: Array<Extract<CardState, { version: 2 }>>;
}> {
  const descriptors: TranscriptStreamDescriptor[] = [];
  const cardStates: Array<Extract<CardState, { version: 2 }>> = [];
  for (const card of cards) {
    const result = await backing.port.generation(c38Target(card));
    if (!result.ok) throw new Error(result.error.message);
    const descriptor = await backing.repository.getChildStreamState(
      backing.scope,
      c38Target(card),
    );
    if (!descriptor || descriptor.cardState?.version !== 2)
      throw new Error('Missing version-2 card state');
    descriptors.push(descriptor);
    cardStates.push(descriptor.cardState);
  }
  return { descriptors, cardStates };
}

async function resultIdentity(
  backing: C38Backing,
  card: C38Card,
  answer?: string,
): Promise<DelegationTranscriptResultEntry> {
  const result = await backing.port.resultByGeneration(c38Target(card));
  if (!result.ok) throw new Error(result.error.message);
  const entry = result.value;
  expect(entry.outcome.status).toBe('completed');
  if (answer === undefined) expect(entry.answer).toEqual({ kind: 'none' });
  else if (answer === '')
    expect(entry.answer).toEqual({ kind: 'empty', role: 'final' });
  else {
    expect(entry.answer).toMatchObject({
      kind: 'body',
      role: 'final',
      encoding: 'utf8',
      byteLength: Buffer.byteLength(answer),
      sha256: hash(answer),
    });
    let next: number | undefined = 0;
    let body = '';
    while (next !== undefined) {
      const offset: number = next;
      const range = await backing.port.resultAnswerRange({
        ...c38Target(card),
        resultIndex: entry.resultIndex,
        offset,
        limit: 65536,
      });
      if (!range.ok) throw new Error(range.error.message);
      body += range.value.text;
      next = range.value.nextOffset;
      if (next !== undefined) expect(next).toBeGreaterThan(offset);
    }
    expect(body).toBe(answer);
  }
  return entry;
}

function creationBudget(
  window: C38ObservationWindow,
  A: number,
  count: number,
): {
  A: number;
  rows: number;
  parent: number;
  staging: number;
  parentLimit: number;
  stagingLimit: number;
  checkpoints: number | undefined;
  passed: boolean;
  window: C38ObservationWindow;
} {
  const parent = window.io.totals['parent-jsonl'].bytesWritten;
  const staging = window.io.totals['active-sidecar'].bytesWritten;
  return {
    A,
    rows: count,
    parent,
    staging,
    parentLimit: A + 65536,
    stagingLimit: 4 * A + MiB,
    checkpoints: window.checkpoints.completedCheckpoints,
    passed:
      window.io.complete &&
      parent <= A + 65536 &&
      staging <= 4 * A + MiB &&
      window.checkpoints.completedCheckpoints === count &&
      window.rewrites.length === 0,
    window,
  };
}

const fixtureSizes: C38Size[] =
  process.env.CANOPY_C38_SCALE === '1' ? ['small', 'full'] : ['small'];

describe.each(fixtureSizes)('C38 writer acceptance (%s)', (size) => {
  it(
    'preserves immutable creations and durable outcomes with bounded measured work',
    serialCase(async () => {
      const started = Date.now();
      const root = await fs.mkdtemp(join(tmpdir(), `c38-scale-${size}-`));
      const evidenceDirectory = process.env.CANOPY_C38_EVIDENCE_DIR ?? tmpdir();
      await fs.mkdir(evidenceDirectory, { recursive: true });
      const evidencePath = join(evidenceDirectory, `c38-writer-${size}.json`);
      let backing: C38Backing | undefined;
      const readSource = new AsyncLocalStorage<string>();
      const parentReadAttribution: Record<string, number> = {};
      const progressRestores: Array<() => void> = [];
      const observation = installC38Observation({
        root,
        ownerForPath: (path) => backing?.ioOwnerForPath(path),
        onParentRead: (event): void => {
          if (!event.window) return;
          const key = `${event.window}/parent-jsonl/${readSource.getStore() ?? 'other'}/${event.api}`;
          parentReadAttribution[key] =
            (parentReadAttribution[key] ?? 0) + event.bytes;
        },
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with call(this), not as a detached method.
      const page = ChatTranscriptLog.prototype.pageWithActiveMessages;
      const pageSpy = jest
        .spyOn(ChatTranscriptLog.prototype, 'pageWithActiveMessages')
        .mockImplementation(function (this: ChatTranscriptLog, ...args) {
          // Recorded results would retain every hydrated parent page.
          pageSpy.mockClear();
          return readSource.run('view-hydration', () =>
            page.call(this, ...args),
          );
        });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with call(this), not as a detached method.
      const maintenance = ChatStateV2Backend.prototype.maintainArtifacts;
      const maintenanceSpy = jest
        .spyOn(ChatStateV2Backend.prototype, 'maintainArtifacts')
        .mockImplementation(function (this: ChatStateV2Backend, ...args) {
          maintenanceSpy.mockClear();
          return readSource.run('artifact-maintenance', () =>
            maintenance.call(this, ...args),
          );
        });
      const memory: Array<{ point: string; sample: C38MemorySample }> = [];
      const sample = (point: string): void => {
        memory.push({ point, sample: sampleC38Memory() });
      };
      const evidence: Record<string, unknown> = {
        size,
        manifest: C38_MANIFEST,
        evidencePath,
        parentReadAttribution,
        environment: {
          commit:
            process.env.CANOPY_C38_COMMIT ??
            'unavailable: set CANOPY_C38_COMMIT',
          command: [
            'env',
            '-u',
            'ANTHROPIC_API_KEY',
            '-u',
            'ANTHROPIC_AUTH_TOKEN',
            '-u',
            'ANTHROPIC_BASE_URL',
            ...process.argv,
          ],
          scaleFlag: process.env.CANOPY_C38_SCALE ?? null,
          node: process.version,
          execArgv: process.execArgv,
          nodeOptions: process.env.NODE_OPTIONS ?? null,
          loader: 'repository SWC Jest transform (no inline runner)',
          os: platform(),
          release: release(),
          architecture: arch(),
          cpu: cpus()[0]?.model ?? null,
          logicalCpus: cpus().length,
          totalMemoryBytes: totalmem(),
        },
        memory,
        retainedHeapVerdict: 'unavailable',
        postGcDriftVerdict: 'unavailable',
        memoryLimitations:
          'Ambient Jest, no verified forced GC or isolated warmup. Raw whole-process diagnostics include observer arrays, raw-row/hash oracles, fake-runner starts/sinks and reader projections; not attributed to descriptors. 96 MiB heap, 192 MiB RSS and 16 MiB drift are not accepted from these samples.',
        aggregateBudgets:
          size === 'full'
            ? 'applicable'
            : 'inapplicable to the 25-card fixture',
        performance:
          'scripted test adapters; not release-like D11 or real Git apply evidence',
        ambientCheckpointControl:
          'not exercised here; isolated windows suppress only ambient triggers, and explicit forcing stays live. The separate default-threshold/field workload remains root-owned.',
      };
      const setupStart = observation.io.snapshot();
      try {
        const active = await c38Backing(root, { size, observation });
        backing = active;
        if (size === 'full') {
          // Keep the full manual run observably alive without a timer, sleep,
          // subprocess or helper change. These are persisted generation
          // identities, not the independent final creation-count oracle.
          const generations = new Set<string>();
          const commit = active.storage.commit.bind(active.storage);
          const progressSpy = jest
            .spyOn(active.storage, 'commit')
            .mockImplementation(
              async (
                record: Parameters<C38Backing['storage']['commit']>[0],
              ) => {
                progressSpy.mockClear();
                await commit(record);
                if (!('state' in record)) return;
                const key = `${record.state.delegationId}:${record.state.runGeneration}`;
                if (generations.has(key)) return;
                generations.add(key);
                if (generations.size % 25 === 0)
                  process.stdout.write(
                    `[C38 full] persisted generation identities: ${generations.size}\n`,
                  );
              },
            );
          progressRestores.push(() => progressSpy.mockRestore());
        }
        evidence.setupIo = observation.io.windowSince(
          'setup-before-owning-backing-is-assigned',
          setupStart,
        );
        evidence.setupIoVerdict =
          'Setup classification can be incomplete before the canonical backing is assigned; no setup byte bound or zero-byte claim is made.';
        const measuredStart = observation.io.snapshot();
        const rawOracles: C38IoWindow[] = [];
        evidence.rawOracleIo = rawOracles;
        const readParent = async (): Promise<readonly string[]> => {
          const before = observation.io.snapshot();
          const rows = await rawRows(active.parentLog);
          rawOracles.push(
            observation.io.windowSince(
              `raw-oracle-${rawOracles.length + 1}`,
              before,
            ),
          );
          return rows;
        };
        const packageVersion = async (name: string): Promise<string | null> => {
          const data: unknown = JSON.parse(
            await fs.readFile(
              join(process.cwd(), 'node_modules', name, 'package.json'),
              'utf8',
            ),
          );
          return data !== null &&
            typeof data === 'object' &&
            'version' in data &&
            typeof data.version === 'string'
            ? data.version
            : null;
        };
        evidence.toolVersions = {
          jest: await packageVersion('jest'),
          swcJest: await packageVersion('@swc/jest'),
        };
        sample('before-cards-warmed-seed');
        const seed = await readParent();
        expect(active.seed.physicalBytes).toBeGreaterThanOrEqual(
          C38_MANIFEST[size].minimumParentBytes,
        );
        expect(seed.map((row) => hash(`${row}\n`))).toEqual(
          active.seed.rowHashes,
        );
        evidence.seed = active.seed;

        const creation = await observation.withDrainedWindow(
          'genuine-card-creation',
          () => active.drain(),
          () => active.createCards(),
          () => active.drain(),
        );
        const cards: readonly C38Card[] = [...creation.value];
        evidence.creationObservation = creation.window;
        expect(cards).toHaveLength(C38_MANIFEST[size].cards);
        expect(new Set(cards.map((card) => card.messageId)).size).toBe(
          cards.length,
        );
        expect(new Set(cards.map((card) => card.delegationId)).size).toBe(
          C38_MANIFEST[size].distinctDelegations,
        );
        const initialRows = await readParent();
        const expectedRows: RawMessage[] = [];
        for (let index = 0; index < cards.length; index++) {
          const card = cards[index];
          if (!card) throw new Error('Missing manifest creation');
          expect(card.index).toBe(index);
          const raw = await active.rawCard(card);
          if (!raw) throw new Error('Missing raw card');
          const expected = expectedCreation(card, raw, index + 1);
          evidence.creationOracleUnderReview = { card, actual: raw, expected };
          expect(raw).toEqual(expected);
          const physical: unknown = JSON.parse(cardRow(initialRows, card));
          expect(physical).toEqual(expected);
          expect(
            Buffer.byteLength(JSON.stringify(expected)) + 1,
          ).toBeLessThanOrEqual(8192);
          expectedRows.push(expected);
        }
        delete evidence.creationOracleUnderReview;
        expect(initialRows.slice(0, seed.length)).toEqual(seed);
        expect(initialRows.slice(seed.length)).toEqual(
          cards.map((card) => cardRow(initialRows, card)),
        );
        evidence.creation = creationBudget(
          creation.window,
          c38CreationBytes(expectedRows),
          cards.length,
        );
        expect(evidence.creation).toMatchObject({ passed: true });
        const immutableCreations = cards.map((card) =>
          cardRow(initialRows, card),
        );
        sample('drained-at-card-count');

        const initial = await states(active, cards);
        const outcomes = initial.cardStates.map(
          (state) => state.canonical?.status ?? 'running',
        );
        evidence.initialCounts = {
          cards: cards.length,
          distinctDelegations: new Set(cards.map((card) => card.delegationId))
            .size,
          generation1: cards.filter((card) => card.runGeneration === 1).length,
          generation2: cards.filter((card) => card.runGeneration === 2).length,
          completed: outcomes.filter((status) => status === 'completed').length,
          failed: outcomes.filter((status) => status === 'failed').length,
          cancelled: outcomes.filter((status) => status === 'cancelled').length,
        };
        expect(evidence.initialCounts).toMatchObject({
          generation1: C38_MANIFEST[size].generation1Rows,
          generation2: 1,
          completed: C38_MANIFEST[size].completedBeforeWindows,
          failed: C38_MANIFEST[size].failedBeforeWindows,
          cancelled: C38_MANIFEST[size].stoppedBeforeWindows,
        });
        const queued = cards.find((card) => card.runGeneration === 2);
        if (!queued) throw new Error('Missing amended continuation');
        expect(initial.cardStates[cards.indexOf(queued)]?.prompt).toBe(
          'f'.repeat(256) + '\n\n' + 'q'.repeat(2048),
        );

        const operations: Array<{
          operation: C38Operation;
          window: C38ObservationWindow;
          evaluation: ReturnType<typeof evaluateC38StatusWindow>;
        }> = [];
        evidence.operations = operations;
        let parentWindow = 'idle';
        const indices = c38ProbeIndices(size);
        const probe = (name: keyof typeof indices): C38Card => {
          const card = cards.find(
            (candidate) => candidate.index === indices[name],
          );
          if (!card) throw new Error(`Missing ${name}`);
          return card;
        };
        // Independent body literal, intentionally not imported from the harness.
        const largeAnswer = 'answer 🌲漢字\n'.repeat(12288);
        const answers: readonly (readonly [
          C38Card,
          string | undefined,
          'apply' | 'discard',
        ])[] = [
          [probe('old-apply'), largeAnswer, 'apply'],
          [probe('old-discard'), largeAnswer, 'discard'],
          [probe('middle-apply'), undefined, 'apply'],
          [probe('middle-discard'), '', 'discard'],
        ];
        const durableBeforeControls = new Map<
          string,
          Awaited<ReturnType<typeof resultIdentity>>
        >();
        for (let index = 0; index < C38_MANIFEST.operations.length; index++) {
          const operation = C38_MANIFEST.operations[index];
          if (!operation) throw new Error('Missing frozen operation');
          if (operation.window !== parentWindow) {
            if (operation.window === 'active') await active.beginParentTurn();
            else await active.endParentTurn();
            parentWindow = operation.window;
          }
          const before = await readParent();
          const result = await observation.withDrainedWindow(
            `status-${index + 1}-${operation.probe}-${operation.operation}-${operation.window}`,
            () => active.drain(),
            () => active.runOperation(operation),
            () => active.drain(),
          );
          const after = await readParent();
          const evaluation = evaluateC38StatusWindow(result.window, {
            rawParentRowsUnchanged:
              hash(before.join('\n')) === hash(after.join('\n')),
            rawReferenceUnchanged: referenceRow(before) === referenceRow(after),
          });
          operations.push({ operation, window: result.window, evaluation });
          expect(
            after.filter((row) => immutableCreations.includes(row)),
          ).toEqual(immutableCreations);
          expect(referenceRow(after)).toBe(referenceRow(seed));
          expect(evaluation).toEqual({ passed: true, violations: [] });
          if (operation.operation === 'completed') {
            const answerCase = answers.find(
              ([card]) => card.messageId === probe(operation.probe).messageId,
            );
            if (answerCase)
              durableBeforeControls.set(
                answerCase[0].messageId,
                await resultIdentity(active, answerCase[0], answerCase[1]),
              );
          }
          expect(active.ingress.completed).toBe(active.ingress.enqueued);
          expect(active.ingressErrors).toEqual([]);
        }
        const statusReads = operations.map(
          (op) => op.window.io.totals['parent-jsonl'].bytesRead,
        );
        evidence.statusSummary = {
          count: operations.length,
          parentReadSum: statusReads.reduce((sum, bytes) => sum + bytes, 0),
          parentReadMaximum: Math.max(...statusReads),
          parentWriteSum: operations.reduce(
            (sum, op) => sum + op.window.io.totals['parent-jsonl'].bytesWritten,
            0,
          ),
        };
        expect(operations).toHaveLength(32);
        expect(
          statusReads.reduce((sum, bytes) => sum + bytes, 0),
        ).toBeLessThanOrEqual(64 * MiB);
        for (const op of operations.filter(
          (op) => op.operation.operation === 'publication',
        )) {
          expect(op.window.io.totals['parent-jsonl']).toMatchObject({
            bytesRead: 0,
            bytesWritten: 0,
          });
        }
        evidence.parentTurnBoundaries = active.parentTurnBoundaries;
        expect(active.parentTurnBoundaries).toHaveLength(2);
        expect(
          active.parentTurnBoundaries.every(
            (boundary) => boundary.observation?.io.complete,
          ),
        ).toBe(true);
        for (const boundary of active.parentTurnBoundaries) {
          const attributed = Object.entries(parentReadAttribution)
            .filter(([key]) => key.startsWith(`${boundary.label}/`))
            .reduce((sum, [, bytes]) => sum + bytes, 0);
          expect(attributed).toBe(
            boundary.observation?.io.totals['parent-jsonl'].bytesRead,
          );
        }

        const controls = [];
        for (const [card, answer, operation] of answers) {
          const record = await active.record(card);
          expect(record.control).toMatchObject({
            operation,
            status: 'completed',
          });
          const result = await resultIdentity(active, card, answer);
          expect(result).toEqual(durableBeforeControls.get(card.messageId));
          controls.push({ card, control: record.control, result });
        }
        evidence.controls = controls;
        expect(active.runner.stopped).toContain(
          probe('tail-stop').delegationId,
        );
        expect(
          (await active.record(probe('tail-stop'))).latestResult,
        ).toMatchObject({ status: 'cancelled', stopReason: 'user_cancelled' });
        expect(
          (await active.record(probe('tail-fail'))).latestResult,
        ).toMatchObject({ status: 'failed' });

        const readersBefore = observation.io.snapshot();
        const measuredStates = await states(active, cards);
        const cardSizes = measureC38SerializedSizes(measuredStates.cardStates);
        const descriptorSizes = measureC38SerializedSizes(
          measuredStates.descriptors,
        );
        evidence.serialized = {
          cardStates: cardSizes,
          descriptors: descriptorSizes,
          includesPromptOverrides: true,
        };
        if (size === 'full') {
          expect(cardSizes.sumBytes).toBeLessThanOrEqual(16 * MiB);
          expect(descriptorSizes.sumBytes).toBeLessThanOrEqual(24 * MiB);
        }
        const loaded = await active.service.getState(active.scope);
        expect(loaded).toBeDefined();
        sample('loaded-readers');
        evidence.readerSweepIo = observation.io.windowSince(
          'reader-sweep-excluded-from-status',
          readersBefore,
        );
        const beforeReopen = await readParent();
        const reopen = await observation.withDrainedWindow(
          'repository-reopen-excluded-from-status',
          () => active.drain(),
          () => active.reopenRepository(),
          () => active.drain(),
        );
        evidence.reopen = reopen.window;
        expect(await readParent()).toEqual(beforeReopen);
        for (const [card, answer] of answers) {
          expect(await resultIdentity(active, card, answer)).toEqual(
            durableBeforeControls.get(card.messageId),
          );
        }
        sample('reopened');
        for (let cycle = 0; cycle < 10; cycle++) {
          await active.service.getState(active.scope);
          await active.reopenRepository();
        }
        sample('after-ten-reader-load-and-repository-unload-cycles');
        evidence.readerCycles = {
          count: 10,
          method:
            'getState then repository reopen; broker retained, not a renderer unload',
          postGcDrift: null,
        };

        const ancestor = cards.find((card) => card.index === 6);
        if (!ancestor) throw new Error('Missing continuation ancestor');
        const prefix = await readParent();
        const continuation = await observation.withDrainedWindow(
          'idle-tail-continuation',
          () => active.drain(),
          () => active.followUp(ancestor),
          () => active.drain(),
        );
        const tail = continuation.value;
        const tailRaw = await active.rawCard(tail);
        if (!tailRaw) throw new Error('Missing tail creation');
        // Five turn-boundary identities, four workspace controls, one stop,
        // then follow_up. This is the frozen workload's independent input id.
        const tailExpected = expectedCreation(tail, tailRaw, cards.length + 11);
        expect(tailRaw).toEqual(tailExpected);
        const afterTail = await readParent();
        expect(afterTail.slice(0, prefix.length)).toEqual(prefix);
        expect(afterTail.slice(prefix.length)).toEqual([
          cardRow(afterTail, tail),
        ]);
        expect(active.cards).toHaveLength(C38_MANIFEST[size].afterContinuation);
        expect(new Set(active.cards.map((card) => card.messageId)).size).toBe(
          active.cards.length,
        );
        evidence.continuation = creationBudget(
          continuation.window,
          c38CreationBytes([tailExpected]),
          1,
        );
        expect(evidence.continuation).toMatchObject({ passed: true });
        sample('separate-continuation-card-count');
        const afterContinuationStates = await states(active, active.cards);
        evidence.afterContinuationCounts = {
          cards: active.cards.length,
          distinctDelegations: new Set(
            active.cards.map((card) => card.delegationId),
          ).size,
          generation1: active.cards.filter((card) => card.runGeneration === 1)
            .length,
          generation2: active.cards.filter((card) => card.runGeneration === 2)
            .length,
          completed: afterContinuationStates.cardStates.filter(
            (state) => state.canonical?.status === 'completed',
          ).length,
          failed: afterContinuationStates.cardStates.filter(
            (state) => state.canonical?.status === 'failed',
          ).length,
          cancelled: afterContinuationStates.cardStates.filter(
            (state) => state.canonical?.status === 'cancelled',
          ).length,
        };
        expect(evidence.afterContinuationCounts).toMatchObject({
          cards: C38_MANIFEST[size].afterContinuation,
          distinctDelegations: C38_MANIFEST[size].distinctDelegations,
          generation1: C38_MANIFEST[size].afterContinuationGeneration1Rows,
          generation2: C38_MANIFEST[size].afterContinuationGeneration2Rows,
          completed: C38_MANIFEST[size].completedBeforeWindows + 4,
          failed: C38_MANIFEST[size].failedBeforeWindows + 1,
          cancelled: C38_MANIFEST[size].stoppedBeforeWindows + 1,
        });
        await active.reopenRepository();
        expect(await readParent()).toEqual(afterTail);
        for (const [card, answer] of answers) {
          expect(await resultIdentity(active, card, answer)).toEqual(
            durableBeforeControls.get(card.messageId),
          );
        }
        evidence.allPostSetupIo = observation.io.windowSince(
          'all-post-setup-work-including-raw-oracles-and-readers',
          measuredStart,
        );
        expect(active.errors).toEqual([]);
        evidence.ingress = active.ingress;
        evidence.passed = true;
      } catch (error) {
        evidence.passed = false;
        evidence.failure =
          error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        evidence.workloadRuntimeMs = Date.now() - started;
        try {
          await backing?.dispose();
        } finally {
          pageSpy.mockRestore();
          maintenanceSpy.mockRestore();
          for (const restore of progressRestores) restore();
          readSource.disable();
          observation.restore();
          evidence.runtimeMs = Date.now() - started;
          await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2));
          await fs.rm(root, { recursive: true, force: true });
        }
      }
      const persistedEvidence: unknown = JSON.parse(
        await fs.readFile(evidencePath, 'utf8'),
      );
      expect(persistedEvidence).toMatchObject({
        size,
        passed: true,
        retainedHeapVerdict: 'unavailable',
        postGcDriftVerdict: 'unavailable',
        statusSummary: { count: 32, parentWriteSum: 0 },
        creation: { passed: true },
        continuation: { passed: true, checkpoints: 1 },
      });
    }),
    // The full body took 104 minutes at load average 13 to 16.
    size === 'full' ? 180 * 60_000 : 180_000,
  );
});

describe('C38 sensitivity controls', () => {
  it(
    'reports a genuine queued continuation at the maximum amended-prompt length separately',
    serialCase(async () => {
      const root = await fs.mkdtemp(join(tmpdir(), 'c38-b-max-prompt-'));
      let backing: C38Backing | undefined;
      const report: Record<string, unknown> = {
        provenance:
          'public queued continuation amendments; eight ordinary running capacity holders; not 500 simultaneous maximum states',
        retainedMemoryVerdict: 'unresolved',
        typicalAggregateBudgets: 'inapplicable to this adversarial sample',
        conservative500CardCeilingBytes: 160332500,
        nonPromptMaximaCoexistence: 'not demonstrated',
      };
      try {
        const active = await c38Backing(root);
        backing = active;
        const ancestor = await active.spawn(0);
        await active.terminal(ancestor, 'completed', 'ancestor');
        const holders: C38Card[] = [];
        for (let index = 1; index <= 8; index++)
          holders.push(await active.spawn(index));
        const queued = await active.followUp(ancestor, {
          queued: true,
          index: 9,
        });
        const rejectedPrompt =
          'f'.repeat(256) + '\n\n' + '\u0000'.repeat(32510);
        const rejected = await active.broker.deliverHostMessage(
          queued.delegationId,
          '\u0000'.repeat(32510),
          randomUUID(),
        );
        report.rejectedNulVariant = {
          requestedPromptCodeUnits: rejectedPrompt.length,
          requestedPromptJsonBytes: Buffer.byteLength(
            JSON.stringify(rejectedPrompt),
          ),
          outcome: rejected,
          admission:
            'protocol/src/delegation/index.ts:574–580 boundedText forbids NUL and caps prompt length at 32768 UTF-16 code units (:555); parse prompt :633 -> record-v3.ts:720–723 isTask/:489 codec guard -> broker.ts:8217–8220 pre_write -> :3298/:3277–3285 generic capacity_exceeded. Not an encoded-byte rejection.',
        };
        expect(rejected).toMatchObject({
          ok: false,
          error: { code: 'capacity_exceeded' },
        });
        expect((await active.record(queued)).task.prompt).toBe('f'.repeat(256));
        const acceptedVariants: Array<Record<string, unknown>> = [];
        report.acceptedVariants = acceptedVariants;
        const variants: readonly (readonly [string, string, number])[] = [
          ['ascii', 'x', 32772],
          ['escaped', '\u0001', 195322],
        ];
        let previous = queued;
        for (const [variant, character, promptBytes] of variants) {
          // A fresh queued generation for each variant. Never lower a prompt
          // bound or write state directly after an admission rejection.
          const candidate =
            variant === 'ascii'
              ? queued
              : await active.followUp(previous, { queued: true, index: 10 });
          const amended = await active.broker.deliverHostMessage(
            candidate.delegationId,
            character.repeat(32510),
            randomUUID(),
          );
          if (!amended.ok) throw new Error(JSON.stringify(amended.error));
          const holder = holders.shift();
          if (!holder) throw new Error('Missing capacity holder');
          await active.stop(holder);
          await active.start(candidate);
          const result = await states(active, [candidate]);
          const state = result.cardStates[0];
          if (!state) throw new Error('Missing maximum-prompt state');
          const expected = 'f'.repeat(256) + '\n\n' + character.repeat(32510);
          acceptedVariants.push({
            variant,
            runGeneration: candidate.runGeneration,
            achievedPromptCodeUnits: state.prompt?.length,
            promptJsonBytes: Buffer.byteLength(JSON.stringify(state.prompt)),
            cardStateSizes: measureC38SerializedSizes(result.cardStates),
            fullDescriptorSizes: measureC38SerializedSizes(result.descriptors),
            memory: sampleC38Memory(),
          });
          expect((await active.record(candidate)).task.prompt).toBe(expected);
          expect(state.prompt).toBe(expected);
          expect(state.prompt?.length).toBe(32768);
          expect(Buffer.byteLength(JSON.stringify(state.prompt))).toBe(
            promptBytes,
          );
          await active.terminal(
            candidate,
            'completed',
            'maximum-prompt-answer',
          );
          previous = candidate;
          // Restore normal capacity through the public spawn/start path.
          holders.push(await active.spawn(20 + acceptedVariants.length));
        }
        report.passed = true;
      } catch (error) {
        report.passed = false;
        report.failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        try {
          await backing?.dispose();
        } finally {
          const directory = process.env.CANOPY_C38_EVIDENCE_DIR ?? tmpdir();
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(
            join(directory, 'c38-writer-max-prompt.json'),
            JSON.stringify(report, null, 2),
          );
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    }),
  );

  it(
    'rejects an actual legacy status rewrite and a pure forced checkpoint with the same evaluator',
    serialCase(async () => {
      const root = await fs.mkdtemp(join(tmpdir(), 'c38-b-controls-'));
      let backing: C38Backing | undefined;
      const observation = installC38Observation({
        root,
        ownerForPath: (path) => backing?.ioOwnerForPath(path),
      });
      const controls = [];
      try {
        const active = await c38Backing(root);
        backing = active;
        const card = await active.spawn(0);
        await active.terminal(card, 'completed', 'control-answer');
        const before = await rawRows(active.parentLog);
        const forced = await observation.withDrainedWindow(
          'pure-forced-checkpoint',
          () => active.drain(),
          () =>
            active.repository.transact(active.scope, [], {
              mutationId: `force:${randomUUID()}`,
              source: 'provider',
              checkpoint: true,
            }),
          () => active.drain(),
        );
        expect(await rawRows(active.parentLog)).toEqual(before);
        const forceEvaluation = evaluateC38StatusWindow(forced.window, {
          rawParentRowsUnchanged: true,
          rawReferenceUnchanged: true,
        });
        controls.push({
          kind: 'force',
          window: forced.window,
          evaluation: forceEvaluation,
        });
        expect(forceEvaluation.violations.join(' ')).toContain(
          'commit-checkpoint-flag',
        );
        expect(forceEvaluation.passed).toBe(
          process.env.CANOPY_C38_B_RED === 'force',
        );
        const raw = await active.rawCard(card);
        if (!raw) throw new Error('Missing legacy-control card');
        const legacy = {
          ...raw,
          blocks: raw.blocks.map((block) => {
            if (block.type !== 'delegated_agent_call') return block;
            const { transcriptStore, ...rest } = block;
            void transcriptStore;
            return rest;
          }),
        };
        await active.repository.transact(
          active.scope,
          [
            {
              type: 'message.upserted',
              chatId: active.chatId,
              message: legacy,
            },
          ],
          { mutationId: `legacy-setup:${randomUUID()}`, source: 'provider' },
        );
        const legacyBefore = await rawRows(active.parentLog);
        const patched = await observation.withDrainedWindow(
          'legacy-status-patch',
          () => active.drain(),
          () =>
            active.repository.transact(
              active.scope,
              [
                {
                  type: 'message.upserted',
                  chatId: active.chatId,
                  message: {
                    ...legacy,
                    blocks: legacy.blocks.map((block) =>
                      block.type === 'delegated_agent_call'
                        ? { ...block, status: 'failed' }
                        : block,
                    ),
                  },
                },
              ],
              {
                mutationId: `legacy-patch:${randomUUID()}`,
                source: 'provider',
              },
            ),
          () => active.drain(),
        );
        const legacyAfter = await rawRows(active.parentLog);
        const legacyEvaluation = evaluateC38StatusWindow(patched.window, {
          rawParentRowsUnchanged:
            hash(legacyBefore.join('\n')) === hash(legacyAfter.join('\n')),
          rawReferenceUnchanged:
            referenceRow(legacyBefore) === referenceRow(legacyAfter),
        });
        controls.push({
          kind: 'legacy',
          window: patched.window,
          evaluation: legacyEvaluation,
        });
        expect(legacyEvaluation.violations.join(' ')).toContain(
          'rewrite diagnostic',
        );
        expect(legacyEvaluation.violations.join(' ')).toContain(
          'Parent JSONL wrote',
        );
        expect(legacyEvaluation.violations.join(' ')).toContain(
          'Raw parent rows changed',
        );
        expect(legacyEvaluation.passed).toBe(
          process.env.CANOPY_C38_B_RED === 'legacy',
        );
      } finally {
        try {
          await backing?.dispose();
        } finally {
          observation.restore();
          const directory = process.env.CANOPY_C38_EVIDENCE_DIR ?? tmpdir();
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(
            join(directory, 'c38-writer-controls.json'),
            JSON.stringify(controls, null, 2),
          );
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    }),
  );
});
