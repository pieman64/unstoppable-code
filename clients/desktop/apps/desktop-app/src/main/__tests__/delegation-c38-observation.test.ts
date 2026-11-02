import { Buffer } from 'node:buffer';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fsStreams from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { finished } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fitDelegationReceiptAck } from '@canopy/desktop-shared/node/delegation/receipt-reply';
import { setChatTranscriptRewriteDiagnosticsForTests } from '../services/chat-transcript-rewrite-diagnostics';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import {
  C38_MANIFEST,
  c38Backing,
  c38ProbeIndices,
  c38Target,
  type C38Backing,
  type C38Card,
  type C38Operation,
} from './helpers/delegation-c38-harness';
import {
  evaluateC38StatusWindow,
  installC38IoObserver,
  installC38Observation,
  measureC38SerializedSizes,
  sampleC38Memory,
  type C38Observation,
  type C38ObservationWindow,
  type C38ParentRead,
} from './helpers/delegation-c38-observation';

jest.setTimeout(180_000);
const evidenceDirectory = process.env.CANOPY_C38_EVIDENCE_DIR ?? tmpdir();

type RawParentMessage = NonNullable<Awaited<ReturnType<C38Backing['rawCard']>>>;

function identityFor(card: C38Card): string {
  const target = c38Target(card);
  return `${target.kind}:${target.chatId}:${target.delegationId}:${target.runGeneration}`;
}

function delegationStatus(message: RawParentMessage | undefined): string {
  const block = message?.blocks.find(
    (candidate) => candidate.type === 'delegated_agent_call',
  );
  if (!block || block.type !== 'delegated_agent_call') {
    throw new Error('Missing raw delegated card');
  }
  return block.status;
}

function legacyStatusPatch(
  message: RawParentMessage,
  status: 'completed' | 'failed',
): RawParentMessage {
  return {
    ...message,
    blocks: message.blocks.map((block) =>
      block.type === 'delegated_agent_call' ? { ...block, status } : block,
    ),
  };
}

function legacyControlRow(message: RawParentMessage): RawParentMessage {
  return {
    ...message,
    blocks: message.blocks.map((block) => {
      if (block.type !== 'delegated_agent_call') return block;
      const { transcriptStore, ...legacy } = block;
      void transcriptStore;
      return legacy;
    }),
  };
}

function emptyWindow(
  overrides: Partial<C38ObservationWindow> = {},
): C38ObservationWindow {
  return {
    label: 'synthetic-control',
    io: {
      label: 'synthetic-control',
      apiTotals: {},
      totals: {
        'parent-jsonl': {
          bytesRead: 0,
          bytesWritten: 0,
          readOperations: 0,
          writeOperations: 0,
        },
        'active-sidecar': {
          bytesRead: 0,
          bytesWritten: 0,
          readOperations: 0,
          writeOperations: 0,
        },
        'parent-index': {
          bytesRead: 0,
          bytesWritten: 0,
          readOperations: 0,
          writeOperations: 0,
        },
        'child-log': {
          bytesRead: 0,
          bytesWritten: 0,
          readOperations: 0,
          writeOperations: 0,
        },
        artifact: {
          bytesRead: 0,
          bytesWritten: 0,
          readOperations: 0,
          writeOperations: 0,
        },
        metadata: {
          bytesRead: 0,
          bytesWritten: 0,
          readOperations: 0,
          writeOperations: 0,
        },
      },
      unclassifiedPaths: [],
      unmeasuredApis: [],
      replacements: [],
      openHandles: 0,
      complete: true,
    },
    rewrites: [],
    checkpoints: {
      mutationInputs: [],
      writerInputs: [],
      requests: [],
      boundaries: [],
      completedCheckpoints: 0,
      requestCauses: [],
      workCounterDelta: {
        generationBefore: 0,
        generationAfter: 0,
        generationChanged: false,
        ipc: {},
        chatStorage: {},
        provider: {},
      },
    },
    ...overrides,
  };
}

async function parentTranscriptHashes(path: string): Promise<{
  readonly allRows: string;
  readonly referenceRow: string;
}> {
  const bytes = await fs.readFile(path);
  const rows = bytes.toString('utf8').trimEnd().split('\n');
  const referenceRow = rows.find((row) =>
    row.includes('"id":"seed-reference"'),
  );
  if (referenceRow === undefined)
    throw new Error('Missing parent reference row');
  return {
    allRows: createHash('sha256').update(bytes).digest('hex'),
    referenceRow: createHash('sha256')
      .update(`${referenceRow}\n`)
      .digest('hex'),
  };
}

describe('C38 observation API sanity', () => {
  it('diagnoses the queued-amendment receipt identity independently of prompt bounds', () => {
    const identity = {
      chatId: 'c38-parent',
      delegationId: randomUUID(),
      receiptKind: 'command',
      key: 'a'.repeat(64),
      requestHash: 'b'.repeat(64),
      operationId: 'c38-queued-amendment',
      operation: 'steer',
      runGeneration: 2,
      admittedAt: 100,
    } satisfies Parameters<typeof fitDelegationReceiptAck>[0];
    const input = {
      ok: true,
      outcome: 'completed',
      snapshot: {
        delegationId: identity.delegationId,
        runGeneration: 2,
        status: 'pending',
        outputTruncated: false,
      },
    } satisfies Parameters<typeof fitDelegationReceiptAck>[1];
    expect(fitDelegationReceiptAck(identity, input)).toEqual({
      ok: false,
      reason: 'Invalid receipt identity or metadata',
    });
    expect(
      fitDelegationReceiptAck({ ...identity, operationId: randomUUID() }, input)
        .ok,
    ).toBe(true);
  });
  it('counts real promise, positioned-handle, path-stream and FileHandle-stream bytes once', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'c38-observer-io-'));
    const parentLog = join(root, 'parent.jsonl');
    await fs.writeFile(parentLog, 'abcdef');
    const observer = installC38IoObserver({
      root:
        process.env.CANOPY_C38_OBSERVER_FAULT === 'bytes'
          ? join(root, 'disabled-byte-wrapper')
          : root,
      ownerForPath: (path) =>
        basename(path).startsWith('parent.jsonl') ? 'parent-jsonl' : 'metadata',
    });
    try {
      const before = observer.snapshot();
      const positionedHandle = await fs.open(parentLog, 'r');
      const positionedBuffer = Buffer.alloc(2);
      const positioned = await positionedHandle.read(
        positionedBuffer,
        0,
        positionedBuffer.byteLength,
        1,
      );
      await positionedHandle.close();

      let pathStreamBytes = 0;
      const pathStream = fsStreams.createReadStream(parentLog, {
        start: 0,
        end: 2,
      });
      for await (const chunk of pathStream) {
        if (Buffer.isBuffer(chunk)) pathStreamBytes += chunk.byteLength;
        else if (typeof chunk === 'string')
          pathStreamBytes += Buffer.byteLength(chunk, 'utf8');
        else throw new Error('Unexpected stream chunk');
      }

      const streamHandle = await fs.open(parentLog, 'r');
      let handleStreamBytes = 0;
      const handleStream = streamHandle.createReadStream({
        start: 0,
        end: 2,
        autoClose: false,
      });
      for await (const chunk of handleStream) {
        if (Buffer.isBuffer(chunk)) handleStreamBytes += chunk.byteLength;
        else if (typeof chunk === 'string')
          handleStreamBytes += Buffer.byteLength(chunk, 'utf8');
        else throw new Error('Unexpected stream chunk');
      }
      await streamHandle.close();

      const promisedRead = await fs.readFile(parentLog);
      const replacement = join(root, 'parent.jsonl.rewrite.tmp');
      await fs.writeFile(replacement, 'replacement');
      await fs.rename(replacement, parentLog);

      const appendHandle = await fs.open(parentLog, 'a');
      await appendHandle.writeFile('!');
      await appendHandle.close();

      const outputPath = join(root, 'parent.jsonl.stream.tmp');
      const output = fsStreams.createWriteStream(outputPath);
      output.write('stream');
      output.end('-end');
      await finished(output);

      const window = observer.windowSince('real-io', before);
      expect(positioned.bytesRead).toBe(2);
      expect(pathStreamBytes).toBe(3);
      expect(handleStreamBytes).toBe(3);
      expect(promisedRead.byteLength).toBe(6);
      expect(window.totals['parent-jsonl'].bytesRead).toBe(14);
      expect(window.totals['parent-jsonl'].bytesWritten).toBe(22);
      expect(window.totals['parent-jsonl'].writeOperations).toBe(4);
      expect(window.unclassifiedPaths).toEqual([]);
      expect(window.unmeasuredApis).toEqual([]);
      expect(window.replacements).toEqual([
        {
          from: replacement,
          to: parentLog,
          fromOwner: 'parent-jsonl',
          toOwner: 'parent-jsonl',
        },
      ]);
      expect(window.complete).toBe(true);
      expect(window.openHandles).toBe(0);
    } finally {
      observer.restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('retains repeated unmeasured-path occurrences and marks each window incomplete', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'c38-observer-gap-'));
    const path = join(root, 'unmeasured.jsonl');
    const observer = installC38IoObserver({
      root,
      ownerForPath: () => 'metadata',
    });
    try {
      const firstBefore = observer.snapshot();
      await fs.writeFile(path, Readable.from(['first']));
      const first = observer.windowSince('gap-1', firstBefore);
      const secondBefore = observer.snapshot();
      await fs.writeFile(path, Readable.from(['second']));
      const second = observer.windowSince('gap-2', secondBefore);
      expect(first.complete).toBe(false);
      expect(second.complete).toBe(false);
      expect(first.unmeasuredApis).toHaveLength(1);
      expect(second.unmeasuredApis).toHaveLength(1);
      expect(second.unmeasuredApis[0]).toContain(path);
    } finally {
      observer.restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a pure checkpoint even when independent raw-row oracles are unchanged', () => {
    const control = emptyWindow({
      checkpoints: {
        mutationInputs: [{ checkpointRequested: true }],
        writerInputs: [],
        requests: [{ kind: 'flush' }],
        boundaries: [{ kind: 'flush', result: 'completed' }],
        completedCheckpoints: 1,
        requestCauses: ['flush'],
        workCounterDelta: {
          generationBefore: 3,
          generationAfter: 3,
          generationChanged: false,
          ipc: {},
          chatStorage: { 'deltaJournal.checkpoints': 1 },
          provider: {},
        },
      },
    });
    const evaluation = evaluateC38StatusWindow(control, {
      rawParentRowsUnchanged: true,
      rawReferenceUnchanged: true,
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.violations.join(' ')).toContain(
      'Completed 1 physical checkpoint',
    );
    expect(evaluation.violations.join(' ')).toContain(
      'Observed checkpoint cause',
    );
  });

  it('reports serialized bytes and does not claim controlled GC from the ambient process', () => {
    expect(measureC38SerializedSizes([{ x: 'é' }, {}])).toMatchObject({
      count: 2,
      sizesBytes: [10, 2],
      sumBytes: 12,
      minBytes: 2,
      p50Bytes: 2,
      p95Bytes: 10,
      maxBytes: 10,
    });
    const memory = sampleC38Memory();
    expect(memory.gcAvailable).toBe(false);
    expect(memory.postGcHeapUsedBytes).toBeNull();
    expect(memory.postGcRssBytes).toBeNull();
  });
});

describe('C38 small genuine broker integration', () => {
  it('attributes the first active-turn scan to ordinary foreground view hydration', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'c38-hydration-control-'));
    let backing: C38Backing | undefined;
    const readSource = new AsyncLocalStorage<string>();
    const reads: Array<C38ParentRead & { source: string }> = [];
    const observation = installC38Observation({
      root,
      ownerForPath: (path) => backing?.ioOwnerForPath(path),
      onParentRead: (event): void => {
        if (event.window)
          reads.push({
            ...event,
            source: readSource.getStore() ?? 'unattributed',
          });
      },
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured before spy and explicitly invoked with call(this).
    const pageWithActive = ChatTranscriptLog.prototype.pageWithActiveMessages;
    const pageSpy = jest
      .spyOn(ChatTranscriptLog.prototype, 'pageWithActiveMessages')
      .mockImplementation(function (this: ChatTranscriptLog, ...args) {
        return readSource.run('backend-view/page-hydration', () =>
          pageWithActive.call(this, ...args),
        );
      });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with call(this), never unbound.
    const maintainArtifacts = ChatStateV2Backend.prototype.maintainArtifacts;
    const maintenanceSpy = jest
      .spyOn(ChatStateV2Backend.prototype, 'maintainArtifacts')
      .mockImplementation(function (this: ChatStateV2Backend, ...args) {
        return readSource.run('artifact-maintenance', () =>
          maintainArtifacts.call(this, ...args),
        );
      });
    try {
      backing = await c38Backing(root);
      const active = backing;
      const cards = await active.createCards();
      await active.beginParentTurn({ warmView: false });
      const foreground = await observation.withDrainedWindow(
        'turn-boundary-ordinary-foreground-append',
        () => active.drain(),
        () =>
          active.repository.transact(
            active.scope,
            [
              {
                type: 'message.upserted',
                chatId: active.chatId,
                message: {
                  id: 'c38-hydration-control-ordinary',
                  role: 'assistant',
                  timestamp: 50,
                  blocks: [
                    { type: 'text', text: 'ordinary foreground answer' },
                  ],
                },
              },
            ],
            {
              chatIds: [active.chatId],
              source: 'provider',
              mutationId: 'c38:ordinary-hydration',
            },
          ),
        () => active.drain(),
      );
      const foregroundPhysicalBytes = (await fs.stat(active.parentLog)).size;
      const probe = cards.find(
        (card) => card.index === c38ProbeIndices('small')['old-apply'],
      );
      if (!probe) throw new Error('Missing old-card hydration probe');
      const status = await observation.withDrainedWindow(
        'status-after-ordinary-foreground-hydration',
        () => active.drain(),
        () => active.progress(probe),
        () => active.drain(),
      );
      const ending = await observation.withDrainedWindow(
        'end-boundary-maintenance-control',
        () => active.drain(),
        () => active.endParentTurn({ warmView: false }),
        () => active.drain(),
      );
      expect(
        active.repository.getArtifactMaintenanceStatus(active.scope),
      ).toMatchObject({ pendingChats: 0, deferredChats: 0 });
      const postEnd = await observation.withDrainedWindow(
        'post-end-ordinary-parent-read',
        () => active.drain(),
        () =>
          active.repository.getState(active.scope, {
            chatIds: [active.chatId],
          }),
        () => active.drain(),
      );
      const postEndStatus = await observation.withDrainedWindow(
        'post-end-status-after-hydration',
        () => active.drain(),
        () => active.progress(probe),
        () => active.drain(),
      );
      await fs.writeFile(
        join(evidenceDirectory, 'c38-observation-hydration-control.json'),
        JSON.stringify(
          {
            foreground: foreground.window,
            status: status.window,
            ending: ending.window,
            postEnd: postEnd.window,
            postEndStatus: postEndStatus.window,
            reads,
          },
          null,
          2,
        ),
      );
      expect(
        foreground.window.io.totals['parent-jsonl'].bytesRead,
      ).toBeGreaterThan(3 * 1024 * 1024);
      expect(
        foreground.window.io.totals['parent-jsonl'].bytesRead,
      ).toBeLessThan(4 * 1024 * 1024);
      expect(foreground.window.io.totals['parent-jsonl'].bytesRead).toBe(
        foregroundPhysicalBytes,
      );
      const foregroundReads = reads.filter(
        (event) => event.window === 'turn-boundary-ordinary-foreground-append',
      );
      expect(foregroundReads.length).toBeGreaterThan(0);
      expect(
        foregroundReads.every(
          (event) => event.source === 'backend-view/page-hydration',
        ),
      ).toBe(true);
      expect(evaluateC38StatusWindow(status.window)).toEqual({
        passed: true,
        violations: [],
      });
      expect(postEnd.window.io.totals['parent-jsonl'].bytesRead).toBe(
        (await fs.stat(active.parentLog)).size,
      );
      expect(
        reads
          .filter((event) => event.window === 'post-end-ordinary-parent-read')
          .every((event) => event.source === 'backend-view/page-hydration'),
      ).toBe(true);
      expect(evaluateC38StatusWindow(postEndStatus.window)).toEqual({
        passed: true,
        violations: [],
      });
    } finally {
      try {
        await backing?.dispose();
      } finally {
        pageSpy.mockRestore();
        maintenanceSpy.mockRestore();
        readSource.disable();
        observation.restore();
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it('rejects a real pure checkpoint request even when the raw card is immutable', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'c38-checkpoint-control-'));
    let backing: C38Backing | undefined;
    const observation = installC38Observation({
      root,
      ownerForPath: (path) => backing?.ioOwnerForPath(path),
    });
    try {
      backing = await c38Backing(root);
      const active = backing;
      const card = await active.spawn(0);
      await active.terminal(card, 'completed', 'checkpoint-control-answer');
      const before = await parentTranscriptHashes(active.parentLog);
      const result = await observation.withDrainedWindow(
        'pure-force-unchanged-card',
        () => active.drain(),
        () =>
          active.repository.transact(active.scope, [], {
            source: 'provider',
            mutationId: 'c38:pure-force',
            checkpoint: true,
          }),
        () => active.drain(),
      );
      const after = await parentTranscriptHashes(active.parentLog);
      expect(after).toEqual(before);
      const evaluation = evaluateC38StatusWindow(result.window, {
        rawParentRowsUnchanged: true,
        rawReferenceUnchanged: true,
      });
      expect(evaluation.passed).toBe(false);
      expect(evaluation.violations.join(' ')).toContain(
        'commit-checkpoint-flag',
      );
      expect(result.window.io.totals['parent-jsonl'].bytesWritten).toBe(0);
    } finally {
      try {
        await backing?.dispose();
      } finally {
        observation.restore();
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });

  it('restores every observer and preserves open handles after a thrown window', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'c38-restore-'));
    const path = join(root, 'parent.jsonl');
    await fs.writeFile(path, 'restorable');
    const originalOpen = fs.open;
    const originalStream = fsStreams.createReadStream;
    const observation = installC38Observation({
      root,
      ownerForPath: () => 'parent-jsonl',
    });
    const handle = await fs.open(path, 'r');
    const descriptor = handle.fd;
    let drained = false;
    try {
      await expect(
        observation.withDrainedWindow(
          'throws',
          () => Promise.resolve(),
          () => Promise.reject(new Error('intentional window failure')),
          () => {
            drained = true;
            return Promise.resolve();
          },
        ),
      ).rejects.toThrow('intentional window failure');
      expect(drained).toBe(true);
      expect(observation.lastWindow?.label).toBe('throws');
    } finally {
      observation.restore();
    }
    try {
      expect(fs.open).toBe(originalOpen);
      expect(fsStreams.createReadStream).toBe(originalStream);
      const restoredRead: unknown = Reflect.get(handle, 'read');
      const restoredClose: unknown = Reflect.get(handle, 'close');
      expect(jest.isMockFunction(restoredRead)).toBe(false);
      expect(jest.isMockFunction(restoredClose)).toBe(false);
      expect(handle.fd).toBe(descriptor);
      expect((await handle.read(Buffer.alloc(2), 0, 2, 0)).bytesRead).toBe(2);
    } finally {
      await handle.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('runs the frozen 25-card/32-operation fixture with exact barriers, controls, reopen and continuation', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'c38-observer-broker-'));
    let backing: C38Backing | undefined;
    let observation: C38Observation | undefined;
    const readSource = new AsyncLocalStorage<string>();
    const reads: Array<C38ParentRead & { source: string }> = [];
    const restores: Array<() => void> = [];
    try {
      observation = installC38Observation({
        root,
        ownerForPath: (path) => backing?.ioOwnerForPath(path),
        onParentRead: (event): void => {
          if (event.window)
            reads.push({
              ...event,
              source:
                readSource.getStore() ?? 'outside-tagged-host-and-descriptor',
            });
        },
      });
      const activeBacking = await c38Backing(root, {
        size: 'small',
        observation,
      });
      backing = activeBacking;
      const cards = await activeBacking.createCards();
      const queued = cards.find((card) => card.runGeneration === 2);
      if (!queued) throw new Error('Missing queued generation-2 row');
      const queuedCreation = JSON.stringify(
        await activeBacking.rawCard(queued),
      );
      expect((await activeBacking.record(queued)).task.prompt).toBe(
        'f'.repeat(256) + '\n\n' + 'q'.repeat(2048),
      );
      const queuedState = await activeBacking.port.generation(
        c38Target(queued),
      );
      if (!queuedState.ok) throw new Error(queuedState.error.message);
      expect(queuedState.value.stream?.cardState).toMatchObject({
        version: 2,
        prompt: 'f'.repeat(256) + '\n\n' + 'q'.repeat(2048),
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Captured before spy and explicitly invoked with call(this).
      const pageWithActive = ChatTranscriptLog.prototype.pageWithActiveMessages;
      const pageSpy = jest
        .spyOn(ChatTranscriptLog.prototype, 'pageWithActiveMessages')
        .mockImplementation(function (this: ChatTranscriptLog, ...args) {
          return readSource.run('backend-view/page-hydration', () =>
            pageWithActive.call(this, ...args),
          );
        });
      restores.push(() => pageSpy.mockRestore());
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoked with call(this), never unbound.
      const maintainArtifacts = ChatStateV2Backend.prototype.maintainArtifacts;
      const maintenanceSpy = jest
        .spyOn(ChatStateV2Backend.prototype, 'maintainArtifacts')
        .mockImplementation(function (this: ChatStateV2Backend, ...args) {
          return readSource.run('artifact-maintenance', () =>
            maintainArtifacts.call(this, ...args),
          );
        });
      restores.push(() => maintenanceSpy.mockRestore());
      const ingest = activeBacking.service.ingestProviderEventWithOutcome.bind(
        activeBacking.service,
      );
      const ingestSpy = jest
        .spyOn(activeBacking.service, 'ingestProviderEventWithOutcome')
        .mockImplementation((input) =>
          readSource.run('host-provider-ingestion', () => ingest(input)),
        );
      restores.push(() => ingestSpy.mockRestore());
      const publish = activeBacking.port.updateCardState.bind(
        activeBacking.port,
      );
      const publishSpy = jest
        .spyOn(activeBacking.port, 'updateCardState')
        .mockImplementation((...args) =>
          readSource.run('descriptor-only-publication', () => publish(...args)),
        );
      restores.push(() => publishSpy.mockRestore());
      const baselineIngress = activeBacking.ingress.enqueued;
      expect(cards).toHaveLength(C38_MANIFEST.small.cards);
      expect(new Set(cards.map(identityFor)).size).toBe(
        C38_MANIFEST.small.cards,
      );
      expect(new Set(cards.map((card) => card.messageId)).size).toBe(
        C38_MANIFEST.small.cards,
      );
      expect(new Set(cards.map((card) => card.delegationId)).size).toBe(
        C38_MANIFEST.small.distinctDelegations,
      );
      expect(cards.filter((card) => card.runGeneration === 1)).toHaveLength(
        C38_MANIFEST.small.generation1Rows,
      );
      expect(cards.filter((card) => card.runGeneration === 2)).toHaveLength(
        C38_MANIFEST.small.generation2Rows,
      );
      expect(activeBacking.ingress.enqueued).toBe(baselineIngress);
      expect(activeBacking.ingress.completed).toBe(baselineIngress);
      expect(activeBacking.ingressErrors).toEqual([]);
      expect(activeBacking.notifications).toHaveLength(
        C38_MANIFEST.small.settledBeforeWindows,
      );

      const baselineGenerationOne = cards.filter(
        (card) => card.runGeneration === 1,
      );
      const baselineStatuses = await Promise.all(
        baselineGenerationOne.map(async (card) => {
          const generation = await activeBacking.port.generation(
            c38Target(card),
          );
          if (!generation.ok) throw new Error(generation.error.message);
          const state = generation.value.stream?.cardState;
          return state?.version === 2
            ? (state.canonical?.status ?? 'running')
            : 'running';
        }),
      );
      expect(
        baselineStatuses.filter((status) => status === 'completed'),
      ).toHaveLength(C38_MANIFEST.small.completedBeforeWindows);
      expect(
        baselineStatuses.filter((status) => status === 'failed'),
      ).toHaveLength(C38_MANIFEST.small.failedBeforeWindows);
      expect(
        baselineStatuses.filter((status) => status === 'cancelled'),
      ).toHaveLength(C38_MANIFEST.small.stoppedBeforeWindows);
      expect(
        baselineStatuses.filter(
          (status) =>
            status !== 'completed' &&
            status !== 'failed' &&
            status !== 'cancelled',
        ),
      ).toHaveLength(
        C38_MANIFEST.small.generation1Rows -
          C38_MANIFEST.small.settledBeforeWindows,
      );

      let parentWindow: 'idle' | 'active' = 'idle';
      let transitions = 0;
      const statusResults: Array<{
        operation: C38Operation;
        label: string;
        passed: boolean;
        violations: readonly string[];
      }> = [];
      for (let index = 0; index < C38_MANIFEST.operations.length; index++) {
        const operation = C38_MANIFEST.operations[index];
        if (!operation) throw new Error('Missing manifest operation');
        if (operation.window !== parentWindow) {
          if (operation.window === 'active')
            await activeBacking.beginParentTurn();
          else await activeBacking.endParentTurn();
          parentWindow = operation.window;
          transitions++;
        }
        const targetIndex = c38ProbeIndices('small')[operation.probe];
        const targetCard = cards.find((card) => card.index === targetIndex);
        if (!targetCard) throw new Error(`Missing probe ${operation.probe}`);
        const beforeParent = await parentTranscriptHashes(
          activeBacking.parentLog,
        );
        const result = await observation.withDrainedWindow(
          `op-${index + 1}-${operation.probe}-${operation.operation}-${operation.window}`,
          () => activeBacking.drain(),
          () => activeBacking.runOperation(operation),
          () => activeBacking.drain(),
        );
        const afterParent = await parentTranscriptHashes(
          activeBacking.parentLog,
        );
        const evaluation = evaluateC38StatusWindow(result.window, {
          rawParentRowsUnchanged: beforeParent.allRows === afterParent.allRows,
          rawReferenceUnchanged:
            beforeParent.referenceRow === afterParent.referenceRow,
        });
        statusResults.push({
          operation,
          label: result.window.label,
          passed: evaluation.passed,
          violations: evaluation.violations,
        });
        expect(activeBacking.ingress.completed).toBe(
          activeBacking.ingress.enqueued,
        );
        expect(activeBacking.ingressErrors).toEqual([]);
      }
      if (parentWindow === 'active') await activeBacking.endParentTurn();
      expect(transitions).toBe(2);
      expect(C38_MANIFEST.operations).toHaveLength(32);
      expect(statusResults).toHaveLength(C38_MANIFEST.operations.length);

      const stopCard = cards.find(
        (card) => card.index === c38ProbeIndices('small')['tail-stop'],
      );
      if (!stopCard) throw new Error('Missing stopped probe');
      expect(activeBacking.runner.stopped).toContain(stopCard.delegationId);
      expect((await activeBacking.record(stopCard)).latestResult).toMatchObject(
        {
          status: 'cancelled',
          stopReason: 'user_cancelled',
        },
      );

      const indices = c38ProbeIndices('small');
      const oldApply = cards.find(
        (card) => card.index === indices['old-apply'],
      );
      const oldDiscard = cards.find(
        (card) => card.index === indices['old-discard'],
      );
      const middleApply = cards.find(
        (card) => card.index === indices['middle-apply'],
      );
      const middleDiscard = cards.find(
        (card) => card.index === indices['middle-discard'],
      );
      if (!oldApply || !oldDiscard || !middleApply || !middleDiscard) {
        throw new Error('Missing apply/discard smoke probes');
      }
      const controls: readonly (readonly [C38Card, 'apply' | 'discard'])[] = [
        [oldApply, 'apply'],
        [oldDiscard, 'discard'],
        [middleApply, 'apply'],
        [middleDiscard, 'discard'],
      ];
      for (const [card, expectedOperation] of controls) {
        const record = await activeBacking.record(card);
        expect(record.control).toMatchObject({
          operation: expectedOperation,
          status: 'completed',
        });
      }

      const reopenCardBefore = await activeBacking.rawCard(oldApply);
      await activeBacking.reopenRepository();
      await activeBacking.drain();
      expect(await activeBacking.rawCard(oldApply)).toEqual(reopenCardBefore);
      expect(JSON.stringify(await activeBacking.rawCard(queued))).toBe(
        queuedCreation,
      );
      const beforeFollowUpIngress = activeBacking.ingress.enqueued;
      const continuationAncestor = cards.find(
        (card) => card.index === C38_MANIFEST.idleContinuationAncestorIndex,
      );
      if (!continuationAncestor)
        throw new Error('Missing idle continuation ancestor');
      const continuation = await activeBacking.followUp(continuationAncestor);
      expect(continuation.runGeneration).toBe(2);
      expect(activeBacking.ingress.enqueued).toBeGreaterThan(
        beforeFollowUpIngress,
      );
      expect(activeBacking.ingress.completed).toBe(
        activeBacking.ingress.enqueued,
      );
      expect(activeBacking.ingressErrors).toEqual([]);

      const afterContinuation = activeBacking.cards;
      expect(afterContinuation).toHaveLength(
        C38_MANIFEST.small.afterContinuation,
      );
      expect(new Set(afterContinuation.map(identityFor)).size).toBe(
        C38_MANIFEST.small.afterContinuation,
      );
      expect(
        new Set(afterContinuation.map((card) => card.messageId)).size,
      ).toBe(C38_MANIFEST.small.afterContinuation);
      expect(
        afterContinuation.filter((card) => card.runGeneration === 1),
      ).toHaveLength(C38_MANIFEST.small.afterContinuationGeneration1Rows);
      expect(
        afterContinuation.filter((card) => card.runGeneration === 2),
      ).toHaveLength(C38_MANIFEST.small.afterContinuationGeneration2Rows);
      const rawRows = await Promise.all(
        afterContinuation.map((card) => activeBacking.rawCard(card)),
      );
      expect(rawRows.filter((row) => row !== undefined)).toHaveLength(
        C38_MANIFEST.small.afterContinuation,
      );
      expect(delegationStatus(await activeBacking.rawCard(continuation))).toBe(
        'pending',
      );
      expect(activeBacking.parentTurnBoundaries).toHaveLength(2);
      expect(
        activeBacking.parentTurnBoundaries.every(
          (boundary) => boundary.observation !== null,
        ),
      ).toBe(true);
      for (const boundary of activeBacking.parentTurnBoundaries) {
        expect(
          boundary.observation?.io.apiTotals['parent-jsonl/fs.createReadStream']
            ?.bytesRead,
        ).toBeGreaterThan(3 * 1024 * 1024);
      }
      await fs.writeFile(
        join(evidenceDirectory, 'c38-observation-read-trace.json'),
        JSON.stringify(
          {
            statusResults,
            parentTurnBoundaries: activeBacking.parentTurnBoundaries,
            reads,
          },
          null,
          2,
        ),
      );
      expect(statusResults.filter((result) => !result.passed)).toEqual([]);
    } finally {
      for (const restore of restores.reverse()) restore();
      readSource.disable();
      try {
        observation?.restore();
      } finally {
        try {
          await backing?.dispose();
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  }, 180_000);

  it('uses the same evaluator to reject two committed legacy same-chat patches', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'c38-observer-legacy-'));
    let backing: C38Backing | undefined;
    let observation: C38Observation | undefined;
    try {
      observation = installC38Observation({
        root,
        ownerForPath: (path) => backing?.ioOwnerForPath(path),
      });
      if (process.env.CANOPY_C38_OBSERVER_FAULT === 'sink') {
        setChatTranscriptRewriteDiagnosticsForTests({
          sink: (): void => undefined,
        });
      }
      backing = await c38Backing(root, { size: 'small' });
      const first = await backing.spawn(0);
      const second = await backing.spawn(1);
      const firstStream = await backing.rawCard(first);
      const secondStream = await backing.rawCard(second);
      if (!firstStream || !secondStream)
        throw new Error('Missing raw patch rows');
      // Deliberate legacy control, outside measurement: commit full valid
      // legacy rows (no stream marker), then patch each committed row twice
      // through the real repository. Not a production marker migration.
      const beforeFirst = legacyControlRow(firstStream);
      const beforeSecond = legacyControlRow(secondStream);
      await backing.repository.transact(
        backing.scope,
        [
          {
            type: 'message.upserted',
            chatId: backing.chatId,
            message: beforeFirst,
          },
          {
            type: 'message.upserted',
            chatId: backing.chatId,
            message: beforeSecond,
          },
        ],
        { mutationId: 'c38:legacy-control-setup', source: 'provider' },
      );
      await backing.drain();
      const beforeParent = await parentTranscriptHashes(backing.parentLog);

      const result = await observation.withDrainedWindow(
        'legacy-style-status-patch-control',
        () => backing?.drain() ?? Promise.resolve(),
        async () => {
          await backing?.repository.transact(
            backing.scope,
            [
              {
                type: 'message.upserted',
                chatId: backing.chatId,
                message: legacyStatusPatch(beforeFirst, 'completed'),
              },
            ],
            { mutationId: 'c38:legacy-patch:first', source: 'provider' },
          );
          await backing?.repository.transact(
            backing.scope,
            [
              {
                type: 'message.upserted',
                chatId: backing.chatId,
                message: legacyStatusPatch(beforeSecond, 'failed'),
              },
            ],
            { mutationId: 'c38:legacy-patch:second', source: 'provider' },
          );
          return backing?.drain();
        },
        () => backing?.drain() ?? Promise.resolve(),
      );
      const afterFirst = await backing.rawCard(first);
      const afterSecond = await backing.rawCard(second);
      expect(delegationStatus(afterFirst)).toBe('completed');
      expect(delegationStatus(afterSecond)).toBe('failed');
      const afterParent = await parentTranscriptHashes(backing.parentLog);
      const evaluation = evaluateC38StatusWindow(result.window, {
        rawParentRowsUnchanged: beforeParent.allRows === afterParent.allRows,
        rawReferenceUnchanged:
          beforeParent.referenceRow === afterParent.referenceRow,
      });
      expect(result.window.rewrites).toHaveLength(2);
      expect(
        result.window.rewrites.every((rewrite) =>
          rewrite.chatTranscriptRewritePatchedBlockTypes.includes(
            'delegated_agent_call',
          ),
        ),
      ).toBe(true);
      expect(evaluation.passed).toBe(false);
      expect(evaluation.violations.join(' ')).toContain('rewrite diagnostic');
      expect(evaluation.violations.join(' ')).toContain('Parent JSONL wrote');
      expect(evaluation.violations.join(' ')).toContain(
        'Raw parent rows changed',
      );
    } finally {
      try {
        observation?.restore();
      } finally {
        try {
          await backing?.dispose();
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }
    }
  });
});
