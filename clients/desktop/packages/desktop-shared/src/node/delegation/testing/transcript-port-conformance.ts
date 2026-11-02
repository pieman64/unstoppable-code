import {
  fitDelegationReceiptAck,
  fitDelegationStopReceipt,
  fitDelegationStopOutcomeReceipt,
  type DelegationReceiptDraft,
  type DelegationReceiptFitResult,
} from '../receipt-reply';
import { delegationTranscriptSettlementDigest } from '../settlement-identity';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import type { PersistedToolOutputReference } from '@canopy/protocol/canopy-core/core';
import type {
  afterEach as jestAfterEach,
  describe as jestDescribe,
  expect as jestExpect,
  it as jestIt,
} from '@jest/globals';
import type {
  DelegationTranscriptReceiptEntry,
  DelegationTranscriptContentRange,
  DelegationTranscriptSettleRequest,
  DelegationTranscriptGenerationRegistration,
  DelegationTranscriptPort,
  DelegationTranscriptPortError,
  DelegationTranscriptPortResult,
  DelegationTranscriptTarget,
} from '../transcript-port';

export type DelegationTranscriptPortFailurePhase =
  | 'before-write'
  | 'after-write';

/**
 * 11c1 physical engine boundaries a fixture can fail once:
 * - `finalize-artifact`: artifact preparation before publication.
 * - `finalize-journal`: the journal append before publication.
 * - `finalize-checkpoint`: checkpoint materialization after durable publication.
 * - `receipt-effect`: the receipt effect append.
 */
export type DelegationTranscriptRegistryFaultBoundary =
  | 'receipt-effect'
  | 'finalize-artifact'
  | 'finalize-journal'
  | 'finalize-checkpoint';

declare const afterEach: typeof jestAfterEach;
declare const describe: typeof jestDescribe;
declare const expect: typeof jestExpect;
declare const it: typeof jestIt;

export interface DelegationTranscriptPortConformanceFixture {
  readonly port: DelegationTranscriptPort;
  readonly ownedTarget: (
    chatId: string,
    delegationId: string,
    generation: number,
  ) => DelegationTranscriptTarget;
  readonly foreignTarget: DelegationTranscriptTarget;
  readonly reopen?: () =>
    | void
    | DelegationTranscriptPort
    | Promise<void | DelegationTranscriptPort>;
  readonly injectStorageFailure?: (
    phase: DelegationTranscriptPortFailurePhase,
  ) => void | Promise<void>;
  /** Explicit engine boundaries; declaring support requires the hook to exist. */
  readonly checkpoint?: () => void | Promise<void>;
  readonly freshInstance?: () =>
    | DelegationTranscriptPort
    | Promise<DelegationTranscriptPort>;
  readonly noJournal?: () =>
    | DelegationTranscriptPort
    | Promise<DelegationTranscriptPort>;
  /**
   * Repository-only post-read assertion: no journal was recreated after noJournal;
   * an absent chat must also remain without chat-owned storage.
   */
  readonly assertNoStorageCreated?: (chatId: string) => void | Promise<void>;
  /** Repository-only physical view: public message/page reads expand and remove refs. */
  readonly readStoredToolOutputReference?: (
    target: DelegationTranscriptTarget,
    messageId: string,
    blockOrdinal: number,
  ) =>
    | PersistedToolOutputReference
    | undefined
    | Promise<PersistedToolOutputReference | undefined>;
  /** Memory-only view with no ownsChat predicate (not an always-false predicate). */
  readonly portWithoutChatOwnership?: () =>
    | DelegationTranscriptPort
    | Promise<DelegationTranscriptPort>;
  readonly updateCardState?: (
    target: DelegationTranscriptTarget,
  ) => void | Promise<void>;
  readonly seedMetadataLessRows?: (
    target: DelegationTranscriptTarget,
    rows: readonly DelegationChildRow[],
  ) => void | Promise<void>;
  /** Removes an owned chat with everything it owns (receipts, registry, streams). */
  readonly removeChat?: (chatId: string) => void | Promise<void>;
  /** Fails the next operation once at the named 11c1 boundary. */
  readonly injectRegistryFault?: (
    boundary: DelegationTranscriptRegistryFaultBoundary,
  ) => void | Promise<void>;
  readonly dispose?: () => void | Promise<void>;
}

export interface DelegationTranscriptPortConformanceFactory {
  ():
    | DelegationTranscriptPortConformanceFixture
    | Promise<DelegationTranscriptPortConformanceFixture>;
  readonly capabilities?: {
    readonly reopen?: boolean;
    readonly storageFailure?: boolean;
    readonly checkpoint: boolean;
    readonly freshInstance: boolean;
    readonly noJournal: boolean;
    readonly faults: boolean;
    /** Required by the 11c1 feature groups. */
    readonly chatRemoval?: boolean;
    readonly registryFaults?: boolean;
    readonly assertNoStorageCreated?: boolean;
    readonly storedToolOutputReference?: boolean;
  };
}

function successValue<T>(result: DelegationTranscriptPortResult<T>): T {
  if (!result.ok)
    throw new Error(
      `Expected success, received ${result.error.code}: ${result.error.message}`,
    );
  return result.value;
}

function errorValue<T>(
  result: DelegationTranscriptPortResult<T>,
): DelegationTranscriptPortError {
  if (result.ok)
    throw new Error('Expected the transcript port operation to fail.');
  return result.error;
}

function textRow(
  id: string,
  text: string,
  itemRevision = 0,
  options: {
    readonly final?: boolean;
    readonly segment?: string;
    readonly sequence?: number;
  } = {},
): DelegationChildRow {
  return {
    id,
    role: 'assistant',
    timestamp: 123,
    parentBlockId: 'child-card',
    delegationSequence: options.sequence ?? 0,
    delegationSegment: options.segment ?? 'segment-1',
    blocks: [{ type: 'text', text }],
    itemRevision,
    final: options.final ?? false,
  };
}

function toolRow(id: string): DelegationChildRow {
  return {
    id,
    role: 'assistant',
    timestamp: 123,
    parentBlockId: 'child-card',
    delegationSequence: 0,
    delegationSegment: 'segment-1',
    blocks: [
      {
        type: 'tool_use',
        toolUseId: `${id}-call`,
        toolName: 'tool',
        input: 'request input',
      },
      {
        type: 'tool_result',
        toolUseId: `${id}-call`,
        toolName: 'tool',
        output: 'tool output',
        isError: false,
      },
    ],
    itemRevision: 0,
    final: false,
  };
}

function generationRegistration(
  target: DelegationTranscriptTarget,
): DelegationTranscriptGenerationRegistration {
  return {
    chatId: target.chatId,
    delegationId: target.delegationId,
    runGeneration: target.runGeneration,
    createdAt: 100,
    store: 'stream',
    origin: { kind: 'launch', anchorMessageId: 'creation-card' },
    executionMode: 'background',
  };
}
function settlementRequest(
  target: DelegationTranscriptTarget,
  resultIndex = 1,
): DelegationTranscriptSettleRequest {
  return {
    target,
    settlementKey: `settle-${target.runGeneration}`,
    resultIndex,
    outcome: { status: 'completed', startedAt: 100, finishedAt: 456 },
    finalChanges: [],
    answer: null,
  };
}

/** Valid representatives exercise every receipt namespace on error-only views. */
function receiptVariants(
  target: DelegationTranscriptTarget,
): readonly DelegationTranscriptReceiptEntry[] {
  const draft: DelegationReceiptDraft = {
    chatId: target.chatId,
    delegationId: target.delegationId,
    runGeneration: target.runGeneration,
    receiptKind: 'command',
    key: 'a'.repeat(64),
    requestHash: 'b'.repeat(64),
    operationId: 'abcdef12-3456-7890-abcd-1234567890ab',
    operation: 'follow_up',
    admittedAt: 123,
  };
  return [
    fitDelegationReceiptAck(draft, {
      ok: true,
      outcome: 'accepted',
      snapshot: {
        delegationId: target.delegationId,
        status: 'running',
        outputTruncated: false,
      },
    }),
    fitDelegationStopReceipt(
      { ...draft, receiptKind: 'stop', operation: 'stop' },
      'accepted',
    ),
    fitDelegationStopOutcomeReceipt(
      {
        ...draft,
        receiptKind: 'stop_outcome',
        operation: 'stop',
        key: draft.operationId,
        requestHash: null,
      },
      { status: 'completed', finishedAt: 456 },
    ),
  ].map((result) => {
    if (!result.ok) throw new Error(`Receipt fixture failed: ${result.reason}`);
    return result.entry;
  });
}

export interface DelegationTranscriptPortConformanceOptions {
  readonly registry: boolean;
  /**
   * 11c1 feature groups (`registry receipts`, `registry repair`), default off.
   * Enabling one requires `registry: true` and the declared hooks; missing
   * hooks fail setup, nothing is skipped. Existing invocations are unchanged.
   */
  readonly features?: {
    readonly receipts?: boolean;
    readonly repair?: boolean;
  };
  /** Repository is the required durable 11a gate; memory exclusions are skips. */
  readonly durability: 'repository' | 'memory';
}

type RepositoryDurabilityFixture = DelegationTranscriptPortConformanceFixture &
  Required<
    Pick<
      DelegationTranscriptPortConformanceFixture,
      | 'reopen'
      | 'checkpoint'
      | 'freshInstance'
      | 'noJournal'
      | 'injectStorageFailure'
    >
  >;

function requireRepositoryDurability(
  fixture: DelegationTranscriptPortConformanceFixture,
  factory: DelegationTranscriptPortConformanceFactory,
): asserts fixture is RepositoryDurabilityFixture {
  for (const [capability, hook] of [
    [factory.capabilities?.reopen, fixture.reopen],
    [factory.capabilities?.checkpoint, fixture.checkpoint],
    [factory.capabilities?.freshInstance, fixture.freshInstance],
    [factory.capabilities?.noJournal, fixture.noJournal],
    [factory.capabilities?.faults, fixture.injectStorageFailure],
  ]) {
    if (capability !== true || typeof hook !== 'function')
      throw new Error(
        'Repository registry profile requires reopen/checkpoint/fresh-instance/no-journal/fault capabilities and hooks',
      );
  }
}

/** Register the same acceptance cases against any transcript-port fixture. */
export function describeDelegationTranscriptPortConformance(
  name: string,
  factory: DelegationTranscriptPortConformanceFactory,
  options: DelegationTranscriptPortConformanceOptions,
): void {
  if (
    (options.features?.receipts || options.features?.repair) &&
    !options.registry
  )
    throw new Error(
      'Registry receipt and repair features require registry: true',
    );
  describe(`${name} delegation transcript port conformance`, () => {
    const fixturesForCleanup: DelegationTranscriptPortConformanceFixture[] = [];
    async function createFixture(): Promise<DelegationTranscriptPortConformanceFixture> {
      const fixture = await factory();
      fixturesForCleanup.push(fixture);
      if (options.registry && options.durability === 'repository')
        requireRepositoryDurability(fixture, factory);
      if (options.features?.receipts || options.features?.repair) {
        if (
          factory.capabilities?.chatRemoval !== true ||
          typeof fixture.removeChat !== 'function'
        )
          throw new Error(
            'Registry features require the chatRemoval capability and removeChat hook',
          );
        if (
          options.durability === 'repository' &&
          (factory.capabilities?.registryFaults !== true ||
            typeof fixture.injectRegistryFault !== 'function')
        )
          throw new Error(
            'Repository registry features require the registryFaults capability and injectRegistryFault hook',
          );
        if (
          options.durability === 'repository' &&
          (factory.capabilities?.assertNoStorageCreated !== true ||
            typeof fixture.assertNoStorageCreated !== 'function')
        )
          throw new Error(
            'Repository registry features require the assertNoStorageCreated capability and hook',
          );
        if (
          options.durability === 'repository' &&
          options.features?.repair &&
          (factory.capabilities?.storedToolOutputReference !== true ||
            typeof fixture.readStoredToolOutputReference !== 'function')
        )
          throw new Error(
            'Repository registry repair requires the storedToolOutputReference capability and readStoredToolOutputReference hook',
          );
        if (
          options.durability === 'memory' &&
          options.features?.receipts &&
          typeof fixture.portWithoutChatOwnership !== 'function'
        )
          throw new Error(
            'Memory registry receipts require the portWithoutChatOwnership hook',
          );
      }
      return fixture;
    }
    /** Every repository boundary runs; no optional omission can pass the gate. */
    async function visitDurabilityViews(
      fixture: DelegationTranscriptPortConformanceFixture,
      verify: (port: DelegationTranscriptPort) => Promise<void>,
    ): Promise<void> {
      if (options.durability === 'memory') return;
      requireRepositoryDurability(fixture, factory);
      const reopened = (await fixture.reopen()) ?? fixture.port;
      await verify(reopened);
      await fixture.checkpoint();
      await verify(reopened);
      await verify(await fixture.freshInstance());
      await verify(await fixture.noJournal());
    }

    afterEach(async (): Promise<void> => {
      const fixtures = fixturesForCleanup.splice(0);
      await Promise.all(
        fixtures.map(async (fixture): Promise<void> => fixture.dispose?.()),
      );
    });

    it('opens idempotently, supports concurrent opens, and isolates complete targets', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      const first = successValue(await fixture.port.open({ target }));
      const second = successValue(await fixture.port.open({ target }));
      const simultaneous = await Promise.all([
        fixture.port.open({ target }),
        fixture.port.open({ target }),
        fixture.port.open({ target }),
      ]);

      expect(first).toMatchObject({
        target,
        status: 'open',
        streamRevision: 0,
      });
      expect(second).toEqual(first);
      expect(simultaneous.map(successValue)).toEqual([first, first, first]);

      const otherGeneration = fixture.ownedTarget('chat-a', 'child', 2);
      const isolated = successValue(
        await fixture.port.open({ target: otherGeneration }),
      );
      successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'open-isolation',
          changes: [{ row: textRow('one', 'one') }],
        }),
      );
      const otherPage = successValue(
        await fixture.port.page({
          target: otherGeneration,
          streamRevision: isolated.streamRevision,
        }),
      );
      expect(otherPage.rows).toEqual([]);
      expect(
        successValue(await fixture.port.open({ target })).streamRevision,
      ).toBe(1);
    });

    it('classifies item replay, revision conflicts, gaps, finalization, and changed segments in order', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      await fixture.port.open({ target });

      const revisionZero = textRow('item', 'zero');
      const first = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'zero',
          changes: [{ row: revisionZero }],
        }),
      );
      expect(first).toMatchObject({ streamRevision: 1, replayed: false });

      const replay = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'a-different-key-is-not-identity',
          changes: [
            {
              row: {
                ...revisionZero,
                blocks: [{ type: 'text', text: 'zero' }],
              },
            },
          ],
        }),
      );
      expect(replay).toMatchObject({ streamRevision: 1, replayed: true });

      const sameRevisionConflict = errorValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'same-revision-conflict',
          changes: [{ row: textRow('item', 'different') }],
        }),
      );
      expect(sameRevisionConflict).toMatchObject({
        code: 'conflict',
        storedItemRevision: 0,
      });

      const changedSegmentConflict = errorValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'changed-segment',
          changes: [
            { row: textRow('item', 'next', 1, { segment: 'segment-2' }) },
          ],
        }),
      );
      expect(changedSegmentConflict).toMatchObject({
        code: 'conflict',
        storedItemRevision: 0,
      });

      const gap = errorValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'gap',
          changes: [{ row: textRow('item', 'gap', 2) }],
        }),
      );
      expect(gap).toMatchObject({
        code: 'stale_identity',
        storedItemRevision: 0,
      });

      const newItemGap = errorValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'new-item-gap',
          changes: [{ row: textRow('new-item', 'not-zero', 1) }],
        }),
      );
      expect(newItemGap.code).toBe('stale_identity');
      expect(newItemGap).not.toHaveProperty('storedItemRevision');

      const revisionOne = textRow('item', 'one', 1);
      const advanced = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'one',
          changes: [{ row: revisionOne }],
        }),
      );
      expect(advanced).toMatchObject({ streamRevision: 2, replayed: false });

      const finalRow = textRow('item', 'final', 2, { final: true });
      const finalized = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'finalize',
          changes: [{ row: finalRow }],
        }),
      );
      expect(finalized).toMatchObject({ streamRevision: 3, replayed: false });
      expect(
        successValue(
          await fixture.port.appendChanges({
            target,
            mutationKey: 'final-replay',
            changes: [{ row: finalRow }],
          }),
        ),
      ).toMatchObject({ streamRevision: 3, replayed: true });

      const olderFinalConflict = errorValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'older-after-final',
          changes: [{ row: revisionZero }],
        }),
      );
      expect(olderFinalConflict).toMatchObject({
        code: 'conflict',
        storedItemRevision: 2,
      });
      const changedFinalConflict = errorValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'changed-final',
          changes: [{ row: textRow('item', 'changed-final', 3) }],
        }),
      );
      expect(changedFinalConflict).toMatchObject({
        code: 'conflict',
        storedItemRevision: 2,
      });
    });

    it('rejects duplicate item ids in a batch and applies a mixed replay/new admission once', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      await fixture.port.open({ target });
      const existing = textRow('existing', 'kept');
      successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'initial',
          changes: [{ row: existing }],
        }),
      );

      const duplicate = errorValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'duplicate',
          changes: [
            { row: textRow('duplicate-id', 'first') },
            { row: textRow('duplicate-id', 'second') },
          ],
        }),
      );
      expect(duplicate.code).toBe('invalid_request');
      expect(
        successValue(await fixture.port.flush({ target, streamRevision: 1 }))
          .streamRevision,
      ).toBe(1);
      expect(
        errorValue(
          await fixture.port.message({
            target,
            streamRevision: 1,
            messageId: 'duplicate-id',
          }),
        ).code,
      ).toBe('not_found');

      const mixed = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'mixed',
          changes: [{ row: existing }, { row: textRow('new', 'new') }],
        }),
      );
      expect(mixed).toMatchObject({ streamRevision: 2, replayed: false });
      expect(mixed.items.map(({ id }) => id)).toEqual(['existing', 'new']);
      expect(
        successValue(
          await fixture.port.message({
            target,
            streamRevision: 2,
            messageId: 'new',
          }),
        ).blocks,
      ).toEqual([{ type: 'text', text: 'new' }]);
    });

    it('rejects referenced rows and deep-copies admitted and returned data', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      await fixture.port.open({ target });
      const reference = {
        version: 1,
        artifactId: 'artifact',
        byteLength: 7,
        sha256: 'a'.repeat(64),
        encoding: 'utf-8',
        mediaType: 'text/plain',
      };
      const referencedRows = [
        textRow('blocks-ref', 'preview'),
        textRow('text-ref', 'preview'),
        toolRow('input-ref'),
        toolRow('output-ref'),
        textRow('partial-text-ref', 'preview'),
        textRow('final-text-ref', 'preview'),
      ];
      Reflect.set(referencedRows[0], 'blocksRef', reference);
      Reflect.set(referencedRows[1].blocks[0], 'textRef', reference);
      Reflect.set(referencedRows[2].blocks[0], 'inputRef', reference);
      Reflect.set(referencedRows[3].blocks[1], 'fullOutputRef', reference);
      Reflect.set(referencedRows[4].blocks[0], 'partialTextRef', reference);
      Reflect.set(referencedRows[5].blocks[0], 'finalTextRef', reference);
      for (const row of referencedRows) {
        expect(
          errorValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: `reference-${row.id}`,
              changes: [{ row }],
            }),
          ).code,
        ).toBe('invalid_request');
      }

      const undefinedReferencesRow = textRow(
        'undefined-references',
        'still inline',
      );
      Reflect.set(undefinedReferencesRow, 'blocksRef', undefined);
      for (const referenceField of [
        'textRef',
        'inputRef',
        'fullOutputRef',
        'partialTextRef',
        'finalTextRef',
      ]) {
        Reflect.set(
          undefinedReferencesRow.blocks[0],
          referenceField,
          undefined,
        );
      }
      expect(
        errorValue(
          await fixture.port.appendChanges({
            target,
            mutationKey: 'undefined-references',
            changes: [{ row: undefinedReferencesRow }],
          }),
        ).code,
      ).toBe('invalid_request');

      const row = textRow('copy', 'stored');
      successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'copy',
          changes: [{ row }],
        }),
      );
      row.blocks[0] = { type: 'text', text: 'mutated input' };
      const returned = successValue(
        await fixture.port.message({
          target,
          streamRevision: 1,
          messageId: 'copy',
        }),
      );
      expect(returned.blocks).toEqual([{ type: 'text', text: 'stored' }]);
      returned.blocks[0] = { type: 'text', text: 'mutated output' };
      expect(
        successValue(
          await fixture.port.message({
            target,
            streamRevision: 1,
            messageId: 'copy',
          }),
        ).blocks,
      ).toEqual([{ type: 'text', text: 'stored' }]);
    });

    it.each([false, true, undefined])(
      'rejects the storage-only outputTruncated marker (%s) before any write',
      async (marker) => {
        const fixture = await createFixture();
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        successValue(await fixture.port.open({ target }));
        const row = toolRow('truncated');
        Reflect.set(row.blocks[1], 'outputTruncated', marker);
        expect(
          errorValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'storage-only-marker',
              changes: [
                { row: textRow('clean', 'not partially visible') },
                { row },
              ],
            }),
          ).code,
        ).toBe('invalid_request');
        expect(
          successValue(await fixture.port.page({ target, streamRevision: 0 }))
            .rows,
        ).toEqual([]);
      },
    );

    it('replays and reads large UTF-8 and UTF-16 bodies in full through content ranges', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      await fixture.port.open({ target });
      const largeUtf8 = 'large🙂-é'.repeat(18_000);
      const largeUtf16 = `${'wide-text-'.repeat(14_000)}\uD800${'😀'.repeat(100)}`;
      const utf8Row = textRow('large-utf8', largeUtf8, 0, { final: true });
      const utf16Row = textRow('large-utf16', largeUtf16, 0, { final: true });
      const first = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'large-write',
          changes: [{ row: utf8Row }, { row: utf16Row }],
        }),
      );
      const replay = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'large-replay',
          changes: [
            { row: textRow('large-utf8', largeUtf8, 0, { final: true }) },
            { row: textRow('large-utf16', largeUtf16, 0, { final: true }) },
          ],
        }),
      );
      expect(first.streamRevision).toBe(1);
      expect(replay).toMatchObject({ replayed: true, streamRevision: 1 });

      const readAll = async (
        messageId: string,
      ): Promise<{
        readonly text: string;
        readonly byteLength: number;
        readonly encoding: 'utf8' | 'utf16le';
      }> => {
        let offset = 0;
        let text = '';
        let byteLength = 0;
        let encoding: 'utf8' | 'utf16le' = 'utf8';
        while (true) {
          const range = successValue(
            await fixture.port.contentRange({
              target,
              streamRevision: first.streamRevision,
              messageId,
              blockOrdinal: 0,
              field: 'text',
              offset,
              limit: 65_536,
            }),
          );
          text += range.text;
          byteLength = range.byteLength;
          encoding = range.encoding;
          if (range.nextOffset === undefined) break;
          if (range.nextOffset <= offset)
            throw new Error('A body range did not advance its cursor.');
          offset = range.nextOffset;
        }
        return { text, byteLength, encoding };
      };

      expect(await readAll('large-utf8')).toEqual({
        text: largeUtf8,
        byteLength: Buffer.byteLength(largeUtf8, 'utf8'),
        encoding: 'utf8',
      });
      expect(await readAll('large-utf16')).toEqual({
        text: largeUtf16,
        byteLength: Buffer.byteLength(largeUtf16, 'utf16le'),
        encoding: 'utf16le',
      });
    });

    it('flushes through current revisions and rejects a future high-water mark', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      const opened = successValue(await fixture.port.open({ target }));
      expect(
        successValue(await fixture.port.flush({ target, streamRevision: 0 })),
      ).toEqual(opened);
      expect(
        errorValue(await fixture.port.flush({ target, streamRevision: 1 }))
          .code,
      ).toBe('stale_identity');
      successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'current',
          changes: [{ row: textRow('row', 'current') }],
        }),
      );
      expect(
        successValue(await fixture.port.flush({ target, streamRevision: 0 }))
          .streamRevision,
      ).toBe(1);
      expect(
        successValue(await fixture.port.flush({ target, streamRevision: 1 }))
          .streamRevision,
      ).toBe(1);
      expect(
        errorValue(await fixture.port.flush({ target, streamRevision: 2 }))
          .code,
      ).toBe('stale_identity');
    });

    it('pins page, message, and content reads, distinguishes missing from empty, and pages with opaque cursors', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      const opened = successValue(await fixture.port.open({ target }));
      const emptyPage = successValue(
        await fixture.port.page({
          target,
          streamRevision: opened.streamRevision,
        }),
      );
      expect(emptyPage.rows).toEqual([]);
      expect(emptyPage.cursor).toBeUndefined();
      expect(
        errorValue(
          await fixture.port.message({
            target,
            streamRevision: 0,
            messageId: 'missing',
          }),
        ).code,
      ).toBe('not_found');

      const rows = [
        textRow('row-0', 'zero', 0, { sequence: 0 }),
        textRow('row-1', 'one', 0, { sequence: 1 }),
        textRow('row-2', 'two', 0, { sequence: 2 }),
        textRow('empty', '', 0, { sequence: 3 }),
      ];
      const admitted = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'page-rows',
          changes: rows.map((row) => ({ row })),
        }),
      );
      const firstPage = successValue(
        await fixture.port.page({
          target,
          streamRevision: admitted.streamRevision,
          limit: 2,
        }),
      );
      expect(firstPage.rows.map(({ id }) => id)).toEqual(['row-2', 'empty']);
      expect(firstPage.cursor).toBeDefined();
      expect(firstPage.cursor).not.toContain(target.chatId);
      const cursor = firstPage.cursor;
      if (cursor === undefined)
        throw new Error('Expected an opaque cursor for the older rows.');

      const secondPage = successValue(
        await fixture.port.page({
          target,
          streamRevision: admitted.streamRevision,
          cursor,
          limit: 2,
        }),
      );
      expect(secondPage.rows.map(({ id }) => id)).toEqual(['row-0', 'row-1']);
      expect(secondPage.cursor).toBeUndefined();

      const otherTarget = fixture.ownedTarget('chat-a', 'other-child', 1);
      const otherStream = successValue(
        await fixture.port.open({ target: otherTarget }),
      );
      expect(
        errorValue(
          await fixture.port.page({
            target: otherTarget,
            streamRevision: otherStream.streamRevision,
            cursor,
            limit: 2,
          }),
        ).code,
      ).toBe('invalid_request');

      const emptyContent = successValue(
        await fixture.port.contentRange({
          target,
          streamRevision: admitted.streamRevision,
          messageId: 'empty',
          blockOrdinal: 0,
          field: 'text',
          offset: 0,
          limit: 4,
        }),
      );
      expect(emptyContent).toMatchObject({
        text: '',
        byteLength: 0,
        encoding: 'utf8',
      });
      expect(emptyContent.nextOffset).toBeUndefined();

      const moved = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'move-stream',
          changes: [{ row: textRow('newer', 'moves pinned reads') }],
        }),
      );
      expect(
        errorValue(
          await fixture.port.page({
            target,
            streamRevision: moved.streamRevision,
            cursor,
            limit: 2,
          }),
        ).code,
      ).toBe('invalid_request');
      expect(
        errorValue(
          await fixture.port.page({
            target,
            streamRevision: admitted.streamRevision,
            cursor,
            limit: 2,
          }),
        ).code,
      ).toBe('stale_identity');
      expect(
        errorValue(
          await fixture.port.message({
            target,
            streamRevision: admitted.streamRevision,
            messageId: 'row-0',
          }),
        ).code,
      ).toBe('stale_identity');
      expect(
        errorValue(
          await fixture.port.contentRange({
            target,
            streamRevision: admitted.streamRevision,
            messageId: 'empty',
            blockOrdinal: 0,
            field: 'text',
            offset: 0,
            limit: 4,
          }),
        ).code,
      ).toBe('stale_identity');
    });

    it('serves text, tool input, and tool output with UTF-8 boundaries and range limits', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      await fixture.port.open({ target });
      const text = 'A🙂B';
      const row: DelegationChildRow = {
        ...toolRow('ranges'),
        blocks: [
          { type: 'text', text },
          {
            type: 'tool_use',
            toolUseId: 'call',
            toolName: 'tool',
            input: 'input🙂',
          },
          {
            type: 'tool_result',
            toolUseId: 'call',
            toolName: 'tool',
            output: 'outputé',
            isError: false,
          },
        ],
      };
      const admitted = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'ranges',
          changes: [{ row }],
        }),
      );
      const read = async (
        blockOrdinal: number,
        field: 'text' | 'input' | 'output',
        offset: number,
        limit = 65_536,
      ): Promise<
        DelegationTranscriptPortResult<DelegationTranscriptContentRange>
      > =>
        fixture.port.contentRange({
          target,
          streamRevision: admitted.streamRevision,
          messageId: 'ranges',
          blockOrdinal,
          field,
          offset,
          limit,
        });

      expect(successValue(await read(0, 'text', 0))).toMatchObject({
        text,
        byteLength: 6,
        encoding: 'utf8',
      });
      expect(successValue(await read(1, 'input', 0)).text).toBe('input🙂');
      expect(successValue(await read(2, 'output', 0)).text).toBe('outputé');
      expect(successValue(await read(0, 'text', 0, 4))).toMatchObject({
        text: 'A',
        nextOffset: 1,
      });
      expect(successValue(await read(0, 'text', 1, 4))).toMatchObject({
        text: '🙂',
        nextOffset: 5,
      });
      expect(successValue(await read(0, 'text', 5, 4))).toMatchObject({
        text: 'B',
        byteLength: 6,
      });
      expect(successValue(await read(0, 'text', 6)).text).toBe('');
      expect(successValue(await read(0, 'text', 6)).nextOffset).toBeUndefined();
      expect(errorValue(await read(0, 'text', 2)).code).toBe('invalid_request');
      expect(errorValue(await read(0, 'text', 7)).code).toBe('invalid_request');
      expect(errorValue(await read(0, 'text', 0, 3)).code).toBe(
        'invalid_request',
      );
      expect(errorValue(await read(0, 'text', 0, 65_537)).code).toBe(
        'invalid_request',
      );
    });

    it('preserves lone surrogates in UTF-16LE and rejects odd or surrogate-splitting offsets', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      await fixture.port.open({ target });
      const text = 'A😀B\uD800';
      const row = textRow('utf16', text);
      const admitted = successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'utf16',
          changes: [{ row }],
        }),
      );
      const read = (
        offset: number,
        limit = 65_536,
      ): Promise<
        DelegationTranscriptPortResult<DelegationTranscriptContentRange>
      > =>
        fixture.port.contentRange({
          target,
          streamRevision: admitted.streamRevision,
          messageId: 'utf16',
          blockOrdinal: 0,
          field: 'text',
          offset,
          limit,
        });

      expect(successValue(await read(0))).toMatchObject({
        text,
        byteLength: 10,
        encoding: 'utf16le',
      });
      expect(successValue(await read(0, 4))).toMatchObject({
        text: 'A',
        nextOffset: 2,
      });
      expect(successValue(await read(2, 4))).toMatchObject({
        text: '😀',
        nextOffset: 6,
      });
      expect(successValue(await read(6, 4))).toMatchObject({
        text: 'B\uD800',
        byteLength: 10,
      });
      expect(successValue(await read(8, 4))).toMatchObject({
        text: '\uD800',
        byteLength: 10,
      });
      expect(successValue(await read(10))).toMatchObject({
        text: '',
        byteLength: 10,
      });
      expect(successValue(await read(10)).nextOffset).toBeUndefined();
      expect(errorValue(await read(3)).code).toBe('invalid_request');
      expect(errorValue(await read(4)).code).toBe('invalid_request');
      expect(errorValue(await read(11)).code).toBe('invalid_request');
    });

    it('keeps appends atomic with reads racing on an observed revision', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      await fixture.port.open({ target });
      successValue(
        await fixture.port.appendChanges({
          target,
          mutationKey: 'race-old',
          changes: [{ row: textRow('row', 'old') }],
        }),
      );
      const observedRevision = 1;
      const [appendResult, readResult] = await Promise.all([
        fixture.port.appendChanges({
          target,
          mutationKey: 'race-new',
          changes: [{ row: textRow('row', 'new', 1) }],
        }),
        fixture.port.message({
          target,
          streamRevision: observedRevision,
          messageId: 'row',
        }),
      ]);
      expect(successValue(appendResult).streamRevision).toBe(2);
      if (readResult.ok) {
        expect(readResult.value.blocks).toEqual([
          { type: 'text', text: 'old' },
        ]);
      } else {
        expect(readResult.error.code).toBe('stale_identity');
      }
      expect(
        successValue(
          await fixture.port.message({
            target,
            streamRevision: 2,
            messageId: 'row',
          }),
        ).blocks,
      ).toEqual([{ type: 'text', text: 'new' }]);
    });

    it('rejects foreign targets and leaves registry-dependent operations explicitly unsupported', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      const opened = successValue(await fixture.port.open({ target }));
      const foreign = fixture.foreignTarget;
      expect(
        errorValue(await fixture.port.open({ target: foreign })).code,
      ).toBe('unauthorized');
      expect(
        errorValue(
          await fixture.port.appendChanges({
            target: foreign,
            mutationKey: 'foreign',
            changes: [{ row: textRow('foreign', 'blocked') }],
          }),
        ).code,
      ).toBe('unauthorized');
      expect(
        errorValue(
          await fixture.port.flush({ target: foreign, streamRevision: 0 }),
        ).code,
      ).toBe('unauthorized');
      expect(
        errorValue(
          await fixture.port.page({ target: foreign, streamRevision: 0 }),
        ).code,
      ).toBe('unauthorized');
      expect(
        errorValue(
          await fixture.port.message({
            target: foreign,
            streamRevision: 0,
            messageId: 'foreign',
          }),
        ).code,
      ).toBe('unauthorized');
      expect(
        errorValue(
          await fixture.port.contentRange({
            target: foreign,
            streamRevision: 0,
            messageId: 'foreign',
            blockOrdinal: 0,
            field: 'text',
            offset: 0,
            limit: 4,
          }),
        ).code,
      ).toBe('unauthorized');
      expect(
        errorValue(
          await fixture.port.settle({
            target: foreign,
            resultIndex: 1,
            outcome: { status: 'completed', finishedAt: 456 },
            answer: null,
            settlementKey: 'foreign',
            finalChanges: [],
          }),
        ).code,
      ).toBe('unauthorized');
      expect(
        errorValue(
          await fixture.port.resultsPage({
            chatId: foreign.chatId,
            delegationId: foreign.delegationId,
            limit: 10,
          }),
        ).code,
      ).toBe('unauthorized');
      if (!options.registry) {
        const request = settlementRequest(target);
        for (const entry of receiptVariants(target)) {
          expect(errorValue(await fixture.port.appendReceipt(entry)).code).toBe(
            'unsupported_format',
          );
          expect(errorValue(await fixture.port.receipt(entry)).code).toBe(
            'unsupported_format',
          );
        }
        expect(
          errorValue(
            await fixture.port.resultBySettlementKey({
              ...target,
              settlementKey: request.settlementKey,
            }),
          ).code,
        ).toBe('unsupported_format');
        expect(
          errorValue(await fixture.port.resultByGeneration(target)).code,
        ).toBe('unsupported_format');
        expect(
          errorValue(
            await fixture.port.settle({
              ...request,
              answer: {
                role: 'final',
                lost: { sha256: 'a'.repeat(64), length: 7 },
              },
            }),
          ).code,
        ).toBe('unsupported_format');
        expect(
          errorValue(
            await fixture.port.settle({
              ...request,
              openRows: 'finalize',
            }),
          ).code,
        ).toBe('unsupported_format');
        expect(errorValue(await fixture.port.settle(request)).code).toBe(
          'unsupported_format',
        );
        expect(
          errorValue(await fixture.port.resultsPage({ ...target, limit: 10 }))
            .code,
        ).toBe('unsupported_format');
        expect(
          errorValue(
            await fixture.port.registerGeneration(
              generationRegistration(target),
            ),
          ).code,
        ).toBe('unsupported_format');
        expect(
          errorValue(await fixture.port.result({ ...target, resultIndex: 1 }))
            .code,
        ).toBe('unsupported_format');
        expect(errorValue(await fixture.port.generation(target)).code).toBe(
          'unsupported_format',
        );
        expect(
          errorValue(
            await fixture.port.generationsPage({ ...target, limit: 10 }),
          ).code,
        ).toBe('unsupported_format');
        expect(
          errorValue(
            await fixture.port.resultAnswerRange({
              ...target,
              resultIndex: 1,
              offset: 0,
              limit: 4,
            }),
          ).code,
        ).toBe('unsupported_format');
      }
      expect(opened.streamRevision).toBe(0);
    });

    if (options.features?.receipts) {
      describe('registry receipts', () => {
        const operationId = 'abcdef12-3456-7890-abcd-1234567890ab';
        function draft(
          chatId = 'chat-a',
          delegationId = 'child',
        ): DelegationReceiptDraft {
          return {
            chatId,
            delegationId,
            receiptKind: 'command',
            key: 'a'.repeat(64),
            requestHash: 'b'.repeat(64),
            operationId,
            runGeneration: 1,
            operation: 'follow_up',
            admittedAt: 123,
          };
        }
        function fitted(
          result: DelegationReceiptFitResult,
        ): DelegationTranscriptReceiptEntry {
          if (!result.ok)
            throw new Error(`Receipt fixture failed: ${result.reason}`);
          return result.entry;
        }
        function command(
          value = draft(),
          failed = false,
        ): DelegationTranscriptReceiptEntry {
          return fitted(
            fitDelegationReceiptAck(
              value,
              failed
                ? {
                    ok: false,
                    error: {
                      code: 'runtime_error',
                      message: 'admission failed',
                      retryable: false,
                    },
                  }
                : {
                    ok: true,
                    outcome: 'accepted',
                    snapshot: {
                      delegationId: value.delegationId,
                      status: 'running',
                      outputTruncated: false,
                    },
                  },
            ),
          );
        }

        it('appends, reads, replays, conflicts and isolates returned receipt objects', async () => {
          const fixture = await createFixture();
          fixture.ownedTarget('chat-a', 'child', 1);
          const entry = command();
          const before = JSON.stringify(entry);
          const admitted = successValue(
            await fixture.port.appendReceipt(entry),
          );
          expect(admitted).toEqual({ entry, replayed: false });
          expect(successValue(await fixture.port.receipt(entry))).toEqual(
            entry,
          );
          expect(successValue(await fixture.port.appendReceipt(entry))).toEqual(
            { entry, replayed: true },
          );
          expect(
            errorValue(
              await fixture.port.appendReceipt(
                command({ ...draft(), admittedAt: 124 }),
              ),
            ).code,
          ).toBe('conflict');
          // The caller may mutate its own returned JSON; it must not change storage.
          Object.defineProperty(admitted.entry, 'admittedAt', { value: 999 });
          expect(
            JSON.stringify(successValue(await fixture.port.receipt(entry))),
          ).toBe(before);
          expect(JSON.stringify(entry)).toBe(before);
        });

        it('uses one command namespace for accepted and failed acknowledgements and retains durable failures', async () => {
          const fixture = await createFixture();
          fixture.ownedTarget('chat-a', 'child', 1);
          const accepted = command();
          const failed = command(draft(), true);
          successValue(await fixture.port.appendReceipt(accepted));
          expect(
            errorValue(await fixture.port.appendReceipt(failed)).code,
          ).toBe('conflict');
          const failure = command({ ...draft(), key: 'c'.repeat(64) }, true);
          successValue(await fixture.port.appendReceipt(failure));
          expect(
            errorValue(
              await fixture.port.appendReceipt(
                command({ ...draft(), key: failure.key }),
              ),
            ).code,
          ).toBe('conflict');
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            expect(successValue(await port.receipt(failure))).toEqual(failure);
            expect(successValue(await port.appendReceipt(failure))).toEqual({
              entry: failure,
              replayed: true,
            });
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
        });

        it('resolves two stop aliases through their shared operation outcome', async () => {
          const fixture = await createFixture();
          fixture.ownedTarget('chat-a', 'child', 1);
          const stop: DelegationReceiptDraft = {
            ...draft(),
            receiptKind: 'stop',
            operation: 'stop',
          };
          const aliases = [
            fitted(fitDelegationStopReceipt(stop, 'accepted')),
            fitted(
              fitDelegationStopReceipt(
                { ...stop, key: 'c'.repeat(64) },
                'accepted',
              ),
            ),
          ];
          const outcome = fitted(
            fitDelegationStopOutcomeReceipt(
              {
                ...stop,
                receiptKind: 'stop_outcome',
                key: operationId,
                requestHash: null,
              },
              { status: 'completed', finishedAt: 456 },
            ),
          );
          for (const entry of [...aliases, outcome])
            successValue(await fixture.port.appendReceipt(entry));
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            for (const alias of aliases) {
              const read = successValue(await port.receipt(alias));
              expect(read.operationId).toBe(operationId);
              expect(
                successValue(
                  await port.receipt({
                    chatId: read.chatId,
                    receiptKind: 'stop_outcome',
                    key: read.operationId,
                  }),
                ),
              ).toEqual(outcome);
            }
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
        });

        it('scopes keys to chats rather than delegations', async () => {
          const fixture = await createFixture();
          fixture.ownedTarget('chat-a', 'first', 1);
          fixture.ownedTarget('chat-a', 'second', 1);
          fixture.ownedTarget('chat-b', 'first', 1);
          const first = command(draft('chat-a', 'first'));
          const sibling = command(draft('chat-a', 'second'));
          const other = command(draft('chat-b', 'first'));
          successValue(await fixture.port.appendReceipt(first));
          expect(
            errorValue(await fixture.port.appendReceipt(sibling)).code,
          ).toBe('conflict');
          successValue(await fixture.port.appendReceipt(other));
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            expect(successValue(await port.receipt(first))).toEqual(first);
            expect(successValue(await port.receipt(other))).toEqual(other);
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
        });

        it('reports missing receipts and rejects foreign chat reads and writes', async () => {
          const fixture = await createFixture();
          fixture.ownedTarget('chat-a', 'child', 1);
          expect(errorValue(await fixture.port.receipt(command())).code).toBe(
            'not_found',
          );
          const foreign = command(draft(fixture.foreignTarget.chatId));
          expect(errorValue(await fixture.port.receipt(foreign)).code).toBe(
            'unauthorized',
          );
          expect(
            errorValue(await fixture.port.appendReceipt(foreign)).code,
          ).toBe('unauthorized');
        });

        const missingOwnershipIt =
          options.durability === 'memory' ? it : it.skip;
        missingOwnershipIt(
          'denies every receipt operation when ownsChat is missing',
          async () => {
            const fixture = await createFixture();
            const target = fixture.ownedTarget('chat-a', 'child', 1);
            if (!fixture.portWithoutChatOwnership)
              throw new Error(
                'Registry receipts require portWithoutChatOwnership',
              );
            const port = await fixture.portWithoutChatOwnership();
            for (const entry of receiptVariants(target)) {
              expect(errorValue(await port.appendReceipt(entry)).code).toBe(
                'unauthorized',
              );
              expect(errorValue(await port.receipt(entry)).code).toBe(
                'unauthorized',
              );
            }
          },
        );

        it.each(['bad hash', 'uppercase UUID', 'kind mismatch'])(
          'rejects malformed receipt: %s',
          async (malformation) => {
            const fixture = await createFixture();
            fixture.ownedTarget('chat-a', 'child', 1);
            const entry = command();
            const malformed =
              malformation === 'bad hash'
                ? { ...entry, requestHash: 'g'.repeat(64) }
                : malformation === 'uppercase UUID'
                  ? { ...entry, operationId: operationId.toUpperCase() }
                  : { ...entry, receiptKind: 'stop' as const };
            expect(
              errorValue(await fixture.port.appendReceipt(malformed)).code,
            ).toBe('invalid_request');
          },
        );

        it('rejects an entry whose effect exceeds 16 KiB', async () => {
          const fixture = await createFixture();
          fixture.ownedTarget('chat-a', 'child', 1);
          const entry = command(draft(), true);
          if (entry.reply.kind !== 'command' || entry.reply.ack.ok)
            throw new Error('Expected failure ack');
          const oversized = {
            ...entry,
            reply: {
              ...entry.reply,
              ack: {
                ...entry.reply.ack,
                error: {
                  ...entry.reply.ack.error,
                  message: '\u0001'.repeat(20_000),
                },
              },
            },
          };
          expect(
            errorValue(await fixture.port.appendReceipt(oversized)).code,
          ).toBe('invalid_request');
        });

        it('retains receipts through durability views without creating absent-chat data', async () => {
          const fixture = await createFixture();
          fixture.ownedTarget('chat-a', 'child', 1);
          const entry = command();
          successValue(await fixture.port.appendReceipt(entry));
          const absent = { ...entry, chatId: 'absent-receipt-chat' };
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            expect(successValue(await port.receipt(entry))).toEqual(entry);
            expect(successValue(await port.appendReceipt(entry))).toEqual({
              entry,
              replayed: true,
            });
            expect(errorValue(await port.receipt(absent)).code).toBe(
              'not_found',
            );
            expect(
              errorValue(
                await port.resultByGeneration({ ...absent, runGeneration: 1 }),
              ).code,
            ).toBe('not_found');
            expect(
              errorValue(
                await port.resultBySettlementKey({
                  ...absent,
                  settlementKey: 'absent',
                }),
              ).code,
            ).toBe('not_found');
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
          // Includes the original port after the no-journal read: no new receipt appeared.
          expect(errorValue(await fixture.port.receipt(absent)).code).toBe(
            'not_found',
          );
          if (options.durability === 'repository') {
            if (!fixture.assertNoStorageCreated)
              throw new Error(
                'Registry receipts require assertNoStorageCreated',
              );
            await fixture.assertNoStorageCreated(entry.chatId);
            await fixture.assertNoStorageCreated(absent.chatId);
          }
        });

        it('removes chat receipts and recreates the chat with an empty namespace', async () => {
          const fixture = await createFixture();
          fixture.ownedTarget('chat-a', 'child', 1);
          const entry = command();
          successValue(await fixture.port.appendReceipt(entry));
          if (!fixture.removeChat)
            throw new Error('Registry receipts require removeChat');
          await fixture.removeChat(entry.chatId);
          expect(errorValue(await fixture.port.receipt(entry)).code).toBe(
            'not_found',
          );
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          expect(errorValue(await fixture.port.receipt(entry)).code).toBe(
            'not_found',
          );
          await visitDurabilityViews(fixture, async (port): Promise<void> => {
            expect(errorValue(await port.receipt(entry)).code).toBe(
              'not_found',
            );
          });
          const replacement = command({ ...draft(), admittedAt: 999 });
          expect(
            successValue(await fixture.port.appendReceipt(replacement)),
          ).toEqual({ entry: replacement, replayed: false });
        });

        const receiptFaultIt =
          options.durability === 'repository' ? it : it.skip;
        receiptFaultIt(
          'retries a receipt-effect failure without a partial entry',
          async () => {
            const fixture = await createFixture();
            fixture.ownedTarget('chat-a', 'child', 1);
            if (!fixture.injectRegistryFault)
              throw new Error('Registry receipts require injectRegistryFault');
            const entry = command();
            await fixture.injectRegistryFault('receipt-effect');
            expect(
              errorValue(await fixture.port.appendReceipt(entry)).code,
            ).toBe('storage_failure');
            const verify = async (
              port: DelegationTranscriptPort,
            ): Promise<void> => {
              const read = await port.receipt(entry);
              if (read.ok) expect(read.value).toEqual(entry);
              else expect(read.error.code).toBe('not_found');
            };
            await verify(fixture.port);
            await visitDurabilityViews(fixture, verify);
            expect(
              successValue(await fixture.port.appendReceipt(entry)).entry,
            ).toEqual(entry);
            expect(successValue(await fixture.port.receipt(entry))).toEqual(
              entry,
            );
          },
        );
      });
    }

    if (options.features?.repair) {
      describe('registry repair', () => {
        it('stores lost answer identity, replays, conflicts and preserves consecutive result indices', async () => {
          const fixture = await createFixture();
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          const request: DelegationTranscriptSettleRequest = {
            ...settlementRequest(target),
            answer: {
              role: 'final',
              lost: { sha256: 'a'.repeat(64), length: 7 },
            },
          };
          const settled = successValue(await fixture.port.settle(request));
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            expect(
              successValue(await port.result({ ...target, resultIndex: 1 })),
            ).toEqual(settled.result);
            expect(settled.result.answer).toEqual({
              kind: 'lost',
              role: 'final',
              sha256: 'a'.repeat(64),
              length: 7,
            });
            expect(
              errorValue(
                await port.resultAnswerRange({
                  ...target,
                  resultIndex: 1,
                  offset: 0,
                  limit: 100,
                }),
              ).code,
            ).toBe('answer_unavailable');
            expect(successValue(await port.settle(request))).toEqual({
              ...settled,
              settlement: { ...settled.settlement, replayed: true },
            });
            expect(
              errorValue(
                await port.settle({
                  ...request,
                  answer: {
                    role: 'final',
                    lost: { sha256: 'b'.repeat(64), length: 7 },
                  },
                }),
              ).code,
            ).toBe('conflict');
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
          const next = fixture.ownedTarget('chat-a', 'child', 2);
          successValue(await fixture.port.open({ target: next }));
          expect(
            successValue(await fixture.port.settle(settlementRequest(next, 2)))
              .result.resultIndex,
          ).toBe(settled.result.resultIndex + 1);
        });

        it('rejects a zero-length lost answer without consuming its index', async () => {
          const fixture = await createFixture();
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          const request: DelegationTranscriptSettleRequest = {
            ...settlementRequest(target),
            answer: {
              role: 'partial',
              lost: { sha256: 'a'.repeat(64), length: 0 },
            },
          };
          expect(errorValue(await fixture.port.settle(request)).code).toBe(
            'invalid_request',
          );
          expect(
            errorValue(await fixture.port.result({ ...target, resultIndex: 1 }))
              .code,
          ).toBe('not_found');
          expect(
            successValue(
              await fixture.port.settle({
                ...request,
                answer: { role: 'partial', text: '' },
              }),
            ).result.answer,
          ).toEqual({ kind: 'empty', role: 'partial' });
        });

        it('rejects open rows by default and finalizes them at their next revision with unchanged content', async () => {
          const fixture = await createFixture();
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          const initial = [textRow('text', 'same text'), toolRow('tool')];
          successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'open',
              changes: initial.map((row) => ({ row })),
            }),
          );
          const request = settlementRequest(target);
          expect(errorValue(await fixture.port.settle(request)).code).toBe(
            'conflict',
          );
          expect(
            errorValue(
              await fixture.port.settle({ ...request, openRows: 'reject' }),
            ).code,
          ).toBe('conflict');
          const finalRequest: DelegationTranscriptSettleRequest = {
            ...request,
            openRows: 'finalize',
          };
          const settled = successValue(await fixture.port.settle(finalRequest));
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            for (const row of initial) {
              expect(
                successValue(
                  await port.message({
                    target,
                    streamRevision: settled.settlement.contentRevision,
                    messageId: row.id,
                  }),
                ),
              ).toEqual({
                ...row,
                itemRevision: row.itemRevision + 1,
                final: true,
              });
            }
            expect(settled.settlement.finalItemCount).toBe(2);
            expect(settled.result.settlement.finalItemCount).toBe(2);
            expect(
              successValue(
                await port.page({
                  target,
                  streamRevision: settled.settlement.contentRevision,
                }),
              ).rows,
            ).toHaveLength(2);
            expect(settled.result.settlementDigest).toBe(
              delegationTranscriptSettlementDigest(finalRequest),
            );
            expect(successValue(await port.settle(finalRequest))).toEqual({
              ...settled,
              settlement: { ...settled.settlement, replayed: true },
            });
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
        });

        it('combines explicit final changes and generated finals in one settlement', async () => {
          const fixture = await createFixture();
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          const automatic = textRow('automatic', 'retained', 0, {
            sequence: 1,
          });
          successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'mixed',
              changes: [
                { row: textRow('explicit', 'before') },
                { row: automatic },
              ],
            }),
          );
          const explicit = textRow('explicit', 'after', 1, { final: true });
          const request: DelegationTranscriptSettleRequest = {
            ...settlementRequest(target),
            openRows: 'finalize',
            finalChanges: [{ row: explicit }],
          };
          const settled = successValue(await fixture.port.settle(request));
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            expect(
              successValue(
                await port.message({
                  target,
                  streamRevision: settled.settlement.contentRevision,
                  messageId: explicit.id,
                }),
              ),
            ).toEqual(explicit);
            expect(
              successValue(
                await port.message({
                  target,
                  streamRevision: settled.settlement.contentRevision,
                  messageId: automatic.id,
                }),
              ),
            ).toEqual({ ...automatic, itemRevision: 1, final: true });
            expect(settled.result.settlement.finalItemCount).toBe(2);
            expect(settled.settlement.finalItemCount).toBe(2);
            expect(settled.result.settlementDigest).toBe(
              delegationTranscriptSettlementDigest(request),
            );
            expect(
              successValue(await port.settle(request)).settlement.replayed,
            ).toBe(true);
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
        });

        it('replays original, explicit and synthesized finals with their raw admitting receipts', async () => {
          const fixture = await createFixture();
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          const original = textRow('original', 'already final', 0, {
            final: true,
          });
          const originalKey = 'original/raw:key | retained';
          const admitted = successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: originalKey,
              changes: [{ row: original }],
            }),
          );
          const automaticRows = [
            textRow('automatic-a', 'retained a', 0, { sequence: 2 }),
            textRow('automatic-b', 'retained b', 0, { sequence: 3 }),
          ];
          successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'open-for-synthesis',
              changes: [
                { row: textRow('explicit', 'before', 0, { sequence: 1 }) },
                ...automaticRows.map((row) => ({ row })),
              ],
            }),
          );
          const explicit = textRow('explicit', 'after', 1, {
            final: true,
            sequence: 1,
          });
          const synthesized = automaticRows.map((row) => ({
            ...row,
            itemRevision: 1,
            final: true,
          }));
          const request: DelegationTranscriptSettleRequest = {
            ...settlementRequest(target),
            settlementKey: 'settle/raw:key | synthesized',
            openRows: 'finalize',
            finalChanges: [{ row: original }, { row: explicit }],
          };
          const settled = successValue(await fixture.port.settle(request));
          const newFinals = [explicit, ...synthesized];
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            for (const rows of [
              [original],
              ...newFinals.map((row) => [row]),
              synthesized,
              newFinals,
              [original, explicit],
              [...synthesized, original, explicit],
            ]) {
              const onlyOriginal = rows.every((row) => row.id === original.id);
              const onlyNew = rows.every((row) => row.id !== original.id);
              expect(
                successValue(
                  await port.appendChanges({
                    target,
                    mutationKey: 'different/raw:retry | recombination',
                    changes: rows.map((row) => ({ row })),
                  }),
                ),
              ).toEqual({
                target,
                mutationKey: onlyOriginal
                  ? originalKey
                  : onlyNew
                    ? request.settlementKey
                    : 'different/raw:retry | recombination',
                streamRevision: onlyOriginal
                  ? admitted.streamRevision
                  : settled.settlement.contentRevision,
                items: rows.map((row) => ({
                  id: row.id,
                  itemRevision: row.itemRevision,
                  final: true,
                })),
                replayed: true,
              });
            }
            expect(successValue(await port.settle(request))).toEqual({
              ...settled,
              settlement: { ...settled.settlement, replayed: true },
            });
            expect(settled.settlement.finalItemCount).toBe(4);
            const absent = { ...target, chatId: 'absent-repair-chat' };
            expect(
              errorValue(
                await port.resultBySettlementKey({
                  ...absent,
                  settlementKey: 'absent',
                }),
              ).code,
            ).toBe('not_found');
            expect(errorValue(await port.resultByGeneration(absent)).code).toBe(
              'not_found',
            );
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
          if (options.durability === 'repository') {
            if (!fixture.assertNoStorageCreated)
              throw new Error(
                'Registry repair requires assertNoStorageCreated',
              );
            await fixture.assertNoStorageCreated(target.chatId);
            await fixture.assertNoStorageCreated('absent-repair-chat');
          }
        });

        it('retains an already externalized large tool output through automatic finalization', async () => {
          const fixture = await createFixture();
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          const output = 'tool output \ud83d\ude80\n'.repeat(8_000);
          expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(65_536);
          const row: DelegationChildRow = {
            ...toolRow('large-output'),
            blocks: [
              {
                type: 'tool_result',
                toolUseId: 'large-output-call',
                toolName: 'tool',
                output,
                isError: false,
              },
            ],
          };
          const admitted = successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'externalize-open-output',
              changes: [{ row }],
            }),
          );
          const before = successValue(
            await fixture.port.message({
              target,
              streamRevision: admitted.streamRevision,
              messageId: row.id,
            }),
          );
          const beforeBlock = before.blocks[0];
          if (beforeBlock?.type !== 'tool_result')
            throw new Error('Expected tool result');
          expect(beforeBlock.output).toBe(output);
          const publicReference = beforeBlock.fullOutputRef;
          let storedReference: PersistedToolOutputReference | undefined;
          if (options.durability === 'repository') {
            if (!fixture.readStoredToolOutputReference)
              throw new Error(
                'Registry repair requires readStoredToolOutputReference',
              );
            storedReference = await fixture.readStoredToolOutputReference(
              target,
              row.id,
              0,
            );
            expect(storedReference).toBeDefined();
          }
          const request: DelegationTranscriptSettleRequest = {
            ...settlementRequest(target),
            openRows: 'finalize',
          };
          const settled = successValue(await fixture.port.settle(request));
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            const after = successValue(
              await port.message({
                target,
                streamRevision: settled.settlement.contentRevision,
                messageId: row.id,
              }),
            );
            expect(after).toMatchObject({
              id: row.id,
              final: true,
              itemRevision: 1,
            });
            const afterBlock = after.blocks[0];
            if (afterBlock?.type !== 'tool_result')
              throw new Error('Expected finalized tool result');
            expect(afterBlock.output).toBe(output);
            expect(afterBlock.fullOutputRef).toEqual(publicReference);
            if (options.durability === 'repository') {
              if (!fixture.readStoredToolOutputReference)
                throw new Error(
                  'Registry repair requires readStoredToolOutputReference',
                );
              expect(
                await fixture.readStoredToolOutputReference(target, row.id, 0),
              ).toEqual(storedReference);
            }
            let offset = 0;
            let full = '';
            for (;;) {
              const range = successValue(
                await port.contentRange({
                  target,
                  streamRevision: settled.settlement.contentRevision,
                  messageId: row.id,
                  blockOrdinal: 0,
                  field: 'output',
                  offset,
                  limit: 65_536,
                }),
              );
              full += range.text;
              if (range.nextOffset === undefined) break;
              expect(range.nextOffset).toBeGreaterThan(offset);
              offset = range.nextOffset;
            }
            expect(full).toBe(output);
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
        });

        it('finalizes large open text and tool input without losing any content', async () => {
          const fixture = await createFixture();
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          const text = 'x'.repeat(70_000);
          const tool: DelegationChildRow = {
            ...toolRow('large-tool'),
            delegationSequence: 1,
            blocks: [
              {
                type: 'tool_use',
                toolUseId: 'large-call',
                toolName: 'tool',
                input: text,
              },
            ],
          };
          successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'large-open',
              changes: [{ row: textRow('large-text', text) }, { row: tool }],
            }),
          );
          const request: DelegationTranscriptSettleRequest = {
            ...settlementRequest(target),
            openRows: 'finalize',
          };
          const settled = successValue(await fixture.port.settle(request));
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            for (const [messageId, field] of [
              ['large-text', 'text'],
              ['large-tool', 'input'],
            ] as const) {
              const row = successValue(
                await port.message({
                  target,
                  streamRevision: settled.settlement.contentRevision,
                  messageId,
                }),
              );
              expect(row).toMatchObject({ final: true, itemRevision: 1 });
              let offset = 0;
              let full = '';
              for (;;) {
                const range = successValue(
                  await port.contentRange({
                    target,
                    streamRevision: settled.settlement.contentRevision,
                    messageId,
                    blockOrdinal: 0,
                    field,
                    offset,
                    limit: 65_536,
                  }),
                );
                full += range.text;
                if (range.nextOffset === undefined) break;
                expect(range.nextOffset).toBeGreaterThan(offset);
                offset = range.nextOffset;
              }
              expect(full).toBe(text);
            }
            expect(settled.result.settlement.finalItemCount).toBe(2);
            expect(
              successValue(await port.settle(request)).settlement.replayed,
            ).toBe(true);
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
        });

        it('looks up by settlement key and generation without registration, with scoped absence and authorization', async () => {
          const fixture = await createFixture();
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          const request: DelegationTranscriptSettleRequest = {
            ...settlementRequest(target),
            openRows: 'finalize',
          };
          const settled = successValue(await fixture.port.settle(request));
          const verify = async (
            port: DelegationTranscriptPort,
          ): Promise<void> => {
            expect(
              successValue(
                await port.resultBySettlementKey({
                  ...target,
                  settlementKey: request.settlementKey,
                }),
              ),
            ).toEqual(settled.result);
            expect(successValue(await port.resultByGeneration(target))).toEqual(
              settled.result,
            );
            expect(
              errorValue(
                await port.resultBySettlementKey({
                  ...target,
                  settlementKey: 'absent',
                }),
              ).code,
            ).toBe('not_found');
            expect(
              errorValue(
                await port.resultByGeneration({ ...target, runGeneration: 2 }),
              ).code,
            ).toBe('not_found');
            expect(
              errorValue(
                await port.resultBySettlementKey({
                  ...fixture.foreignTarget,
                  settlementKey: request.settlementKey,
                }),
              ).code,
            ).toBe('unauthorized');
            expect(
              errorValue(await port.resultByGeneration(fixture.foreignTarget))
                .code,
            ).toBe('unauthorized');
          };
          await verify(fixture.port);
          await visitDurabilityViews(fixture, verify);
        });

        const repairFaultIt =
          options.durability === 'repository' ? it : it.skip;
        repairFaultIt(
          'preserves durable finalize publication after checkpoint materialization fails',
          async () => {
            const fixture = await createFixture();
            requireRepositoryDurability(fixture, factory);
            const target = fixture.ownedTarget('chat-a', 'child', 1);
            successValue(await fixture.port.open({ target }));
            const rows = [
              textRow('checkpoint-text', 'retained'),
              { ...toolRow('checkpoint-tool'), delegationSequence: 1 },
            ];
            successValue(
              await fixture.port.appendChanges({
                target,
                mutationKey: 'before-checkpoint',
                changes: rows.map((row) => ({ row })),
              }),
            );
            const request: DelegationTranscriptSettleRequest = {
              ...settlementRequest(target),
              openRows: 'finalize',
            };
            const settled = successValue(await fixture.port.settle(request));
            if (!fixture.injectRegistryFault)
              throw new Error('Registry repair requires injectRegistryFault');
            await fixture.injectRegistryFault('finalize-checkpoint');
            await expect(fixture.checkpoint()).rejects.toThrow();
            const reopened = (await fixture.reopen()) ?? fixture.port;
            const verify = async (
              port: DelegationTranscriptPort,
            ): Promise<void> => {
              expect(successValue(await port.open({ target }))).toMatchObject({
                status: 'settled',
                streamRevision: settled.settlement.streamRevision,
              });
              expect(
                successValue(
                  await port.page({
                    target,
                    streamRevision: settled.settlement.contentRevision,
                  }),
                ),
              ).toMatchObject({
                rows: rows.map((row) => ({
                  ...row,
                  itemRevision: 1,
                  final: true,
                })),
                streamRevision: settled.settlement.contentRevision,
              });
              for (const row of rows)
                expect(
                  successValue(
                    await port.message({
                      target,
                      streamRevision: settled.settlement.contentRevision,
                      messageId: row.id,
                    }),
                  ),
                ).toEqual({ ...row, itemRevision: 1, final: true });
              expect(settled.settlement.finalItemCount).toBe(rows.length);
              expect(settled.result.settlement.finalItemCount).toBe(
                rows.length,
              );
              expect(
                successValue(await port.result({ ...target, resultIndex: 1 })),
              ).toEqual(settled.result);
              expect(
                successValue(
                  await port.resultBySettlementKey({
                    ...target,
                    settlementKey: request.settlementKey,
                  }),
                ),
              ).toEqual(settled.result);
              expect(
                successValue(await port.resultByGeneration(target)),
              ).toEqual(settled.result);
              expect(
                successValue(await port.resultsPage({ ...target, limit: 10 })),
              ).toEqual({ results: [settled.result] });
              expect(
                errorValue(await port.result({ ...target, resultIndex: 2 }))
                  .code,
              ).toBe('not_found');
            };
            // Check the committed state before retrying materialization or settle.
            await verify(reopened);
            await fixture.checkpoint();
            await verify(reopened);
            expect(successValue(await reopened.settle(request))).toEqual({
              ...settled,
              settlement: { ...settled.settlement, replayed: true },
            });
            await visitDurabilityViews(fixture, verify);
          },
        );

        repairFaultIt.each(['finalize-artifact', 'finalize-journal'] as const)(
          'rolls back %s with rows open and no result, then retries atomically',
          async (boundary) => {
            const fixture = await createFixture();
            const target = fixture.ownedTarget('chat-a', 'child', 1);
            successValue(await fixture.port.open({ target }));
            const rows = [
              textRow('open', 'x'.repeat(70_000)),
              { ...toolRow('tool'), delegationSequence: 1 },
            ];
            const admitted = successValue(
              await fixture.port.appendChanges({
                target,
                mutationKey: 'before-fault',
                changes: rows.map((row) => ({ row })),
              }),
            );
            if (!fixture.injectRegistryFault)
              throw new Error('Registry repair requires injectRegistryFault');
            await fixture.injectRegistryFault(boundary);
            const request: DelegationTranscriptSettleRequest = {
              ...settlementRequest(target),
              openRows: 'finalize',
            };
            expect(errorValue(await fixture.port.settle(request)).code).toBe(
              'storage_failure',
            );
            const verifyUnchanged = async (
              port: DelegationTranscriptPort,
            ): Promise<void> => {
              expect(successValue(await port.open({ target }))).toMatchObject({
                status: 'open',
                streamRevision: admitted.streamRevision,
              });
              for (const row of rows) {
                expect(
                  successValue(
                    await port.message({
                      target,
                      streamRevision: admitted.streamRevision,
                      messageId: row.id,
                    }),
                  ),
                ).toMatchObject({ id: row.id, itemRevision: 0, final: false });
              }
              expect(
                errorValue(await port.result({ ...target, resultIndex: 1 }))
                  .code,
              ).toBe('not_found');
              expect(
                errorValue(
                  await port.resultBySettlementKey({
                    ...target,
                    settlementKey: request.settlementKey,
                  }),
                ).code,
              ).toBe('not_found');
              expect(
                errorValue(await port.resultByGeneration(target)).code,
              ).toBe('not_found');
            };
            await verifyUnchanged(fixture.port);
            await visitDurabilityViews(fixture, verifyUnchanged);
            const settled = successValue(await fixture.port.settle(request));
            const verifyComplete = async (
              port: DelegationTranscriptPort,
            ): Promise<void> => {
              expect(
                successValue(await port.result({ ...target, resultIndex: 1 })),
              ).toEqual(settled.result);
              for (const row of rows)
                expect(
                  successValue(
                    await port.message({
                      target,
                      streamRevision: settled.settlement.contentRevision,
                      messageId: row.id,
                    }),
                  ),
                ).toMatchObject({ final: true, itemRevision: 1 });
              expect(settled.settlement.finalItemCount).toBe(rows.length);
              expect(
                successValue(await port.settle(request)).settlement.replayed,
              ).toBe(true);
            };
            await verifyComplete(fixture.port);
            await visitDurabilityViews(fixture, verifyComplete);
          },
        );
      });
    }

    if (options.registry) {
      it('registers before open, replays identical generation metadata and rejects changed metadata', async () => {
        const fixture = await createFixture();
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        const registration = generationRegistration(target);
        const entry = successValue(
          await fixture.port.registerGeneration(registration),
        );
        expect(entry).toEqual({
          ...registration,
          kind: 'generation',
          version: 1,
        });
        expect(
          successValue(await fixture.port.registerGeneration(registration)),
        ).toEqual(entry);
        expect(successValue(await fixture.port.generation(target))).toEqual({
          entry,
          stream: null,
          result: null,
        });
        expect(
          errorValue(
            await fixture.port.registerGeneration({
              ...registration,
              createdAt: 101,
            }),
          ).code,
        ).toBe('conflict');
        expect(
          successValue(
            await fixture.port.generationsPage({ ...target, limit: 1 }),
          ).generations,
        ).toEqual([{ entry, stream: null, result: null }]);
      });

      it('reads each answer with its own encoding when two answers share bytes', async () => {
        const fixture = await createFixture();
        const first = fixture.ownedTarget('chat-a', 'child', 1);
        const second = { ...first, runGeneration: 2 };
        // UTF-8 of the first and UTF-16LE of the second are both 41 D8 A0 00.
        const texts = ['Aؠ\u0000', '\ud841 '];
        const targets = [first, second];
        for (let index = 0; index < targets.length; index += 1) {
          const target = targets[index];
          successValue(await fixture.port.open({ target }));
          successValue(
            await fixture.port.settle({
              ...settlementRequest(target, index + 1),
              answer: { role: 'final', text: texts[index] },
            }),
          );
        }
        const readsOwnText = async (
          port: DelegationTranscriptPort,
        ): Promise<void> => {
          for (let index = 0; index < texts.length; index += 1)
            expect(
              successValue(
                await port.resultAnswerRange({
                  ...first,
                  resultIndex: index + 1,
                  offset: 0,
                  limit: 4,
                }),
              ).text,
            ).toBe(texts[index]);
        };
        await readsOwnText(fixture.port);
        await visitDurabilityViews(fixture, readsOwnText);
      });

      it('fences generation-page results at the cursor while stream fields stay current', async () => {
        const fixture = await createFixture();
        const first = fixture.ownedTarget('chat-a', 'child', 1);
        const second = { ...first, runGeneration: 2 };
        successValue(
          await fixture.port.registerGeneration(generationRegistration(first)),
        );
        successValue(
          await fixture.port.registerGeneration(generationRegistration(second)),
        );
        const page = successValue(
          await fixture.port.generationsPage({ ...first, limit: 1 }),
        );
        expect(page.cursor).toBeDefined();
        successValue(await fixture.port.open({ target: second }));
        const settled = successValue(
          await fixture.port.settle(settlementRequest(second, 1)),
        );
        const rest = successValue(
          await fixture.port.generationsPage({
            ...first,
            limit: 1,
            cursor: page.cursor,
          }),
        );
        expect(rest.generations).toHaveLength(1);
        expect(rest.generations[0]?.result).toBeNull();
        expect(rest.generations[0]?.stream).toMatchObject({
          status: 'settled',
          contentRevision: settled.settlement.contentRevision,
        });
        expect(successValue(await fixture.port.generation(second))).toEqual(
          expect.objectContaining({ result: settled.result }),
        );
      });

      it('rejects run generation 0 in registry operations: generations start at 1', async () => {
        const fixture = await createFixture();
        const target = fixture.ownedTarget('chat-a', 'child', 0);
        expect(
          errorValue(
            await fixture.port.registerGeneration(
              generationRegistration(target),
            ),
          ).code,
        ).toBe('invalid_request');
        expect(errorValue(await fixture.port.generation(target)).code).toBe(
          'invalid_request',
        );
        expect(
          errorValue(await fixture.port.settle(settlementRequest(target))).code,
        ).toBe('invalid_request');
      });

      it('atomically settles final rows, returns bounded receipts and replays before mutable state checks', async () => {
        const fixture = await createFixture();
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        successValue(
          await fixture.port.registerGeneration(generationRegistration(target)),
        );
        successValue(await fixture.port.open({ target }));
        const request = {
          ...settlementRequest(target),
          finalChanges: [
            { row: textRow('z', 'last', 0, { final: true }) },
            { row: textRow('a', 'first', 0, { final: true }) },
          ],
        };
        const settled = successValue(await fixture.port.settle(request));
        expect(settled.result.settlementDigest).toBe(
          delegationTranscriptSettlementDigest(request),
        );
        expect(successValue(await fixture.port.open({ target }))).toMatchObject(
          {
            status: 'settled',
            streamRevision: settled.settlement.streamRevision,
          },
        );
        for (const { row } of request.finalChanges) {
          expect(
            successValue(
              await fixture.port.message({
                target,
                streamRevision: settled.settlement.contentRevision,
                messageId: row.id,
              }),
            ),
          ).toEqual(row);
        }
        expect(
          successValue(
            await fixture.port.page({
              target,
              streamRevision: settled.settlement.contentRevision,
            }),
          )
            .rows.map((row) => row.id)
            .sort(),
        ).toEqual(['a', 'z']);

        expect(settled.settlement).toMatchObject({
          target,
          settlementKey: request.settlementKey,
          replayed: false,
          finalItemCount: 2,
        });
        expect(settled.settlement).not.toHaveProperty('items');
        expect(settled.result).toMatchObject({
          version: 1,
          kind: 'result',
          resultIndex: 1,
          runGeneration: 1,
          outcome: request.outcome,
          answer: { kind: 'none' },
        });
        expect(settled.result.settlement.contentRevision).toBe(
          settled.settlement.contentRevision,
        );
        const replay = successValue(
          await fixture.port.settle({
            ...request,
            finalChanges: [...request.finalChanges].reverse(),
          }),
        );
        expect(replay).toEqual({
          ...settled,
          settlement: { ...settled.settlement, replayed: true },
        });
        expect(
          successValue(
            await fixture.port.result({ ...target, resultIndex: 1 }),
          ),
        ).toEqual(settled.result);
        expect(
          successValue(await fixture.port.generation(target)).result,
        ).toEqual(settled.result);
        expect(
          errorValue(
            await fixture.port.resultAnswerRange({
              ...target,
              resultIndex: 1,
              offset: 0,
              limit: 4,
            }),
          ).code,
        ).toBe('not_found');
        for (const changed of [
          { ...request, resultIndex: 2 },
          { ...request, outcome: { ...request.outcome, finishedAt: 457 } },
          { ...request, answer: { role: 'final', text: '' } },
        ] satisfies readonly DelegationTranscriptSettleRequest[]) {
          expect(errorValue(await fixture.port.settle(changed)).code).toBe(
            'conflict',
          );
        }
        expect(
          errorValue(
            await fixture.port.settle({
              ...request,
              settlementKey: 'other-key',
            }),
          ).code,
        ).toBe('conflict');
      });

      it('asserts consecutive indices across generations and failed admissions consume no index', async () => {
        const fixture = await createFixture();
        const first = fixture.ownedTarget('chat-a', 'child', 1);
        const second = fixture.ownedTarget('chat-a', 'child', 2);
        for (const target of [first, second]) {
          successValue(
            await fixture.port.registerGeneration(
              generationRegistration(target),
            ),
          );
          successValue(await fixture.port.open({ target }));
        }
        const seed = successValue(
          await fixture.port.settle(settlementRequest(first, 7)),
        );
        expect(seed.result.resultIndex).toBe(7);
        const conflict = errorValue(
          await fixture.port.settle(settlementRequest(second, 9)),
        );
        expect(conflict).toMatchObject({
          code: 'conflict',
          storedLastResultIndex: 7,
        });
        expect(
          errorValue(
            await fixture.port.settle(
              settlementRequest(second, Number.MAX_SAFE_INTEGER + 1),
            ),
          ).code,
        ).toBe('invalid_request');
        const request = settlementRequest(second, 8);
        expect(
          errorValue(
            await fixture.port.settle({
              ...request,
              finalChanges: [
                {
                  row: textRow('would-be-partial', 'valid', 0, { final: true }),
                },
                { row: textRow('bad', 'gap', 3) },
              ],
            }),
          ).code,
        ).toBe('stale_identity');
        expect(
          successValue(await fixture.port.open({ target: second })),
        ).toMatchObject({ status: 'open', streamRevision: 0 });
        expect(
          errorValue(await fixture.port.result({ ...second, resultIndex: 8 }))
            .code,
        ).toBe('not_found');
        expect(
          successValue(await fixture.port.generation(second)).result,
        ).toBeNull();
        expect(
          successValue(
            await fixture.port.page({ target: second, streamRevision: 0 }),
          ).rows,
        ).toEqual([]);
        for (const messageId of ['would-be-partial', 'bad'])
          expect(
            errorValue(
              await fixture.port.message({
                target: second,
                streamRevision: 0,
                messageId,
              }),
            ).code,
          ).toBe('not_found');
        expect(
          successValue(await fixture.port.settle(request)).result.resultIndex,
        ).toBe(8);
      });

      if (options.durability === 'repository') {
        it('serializes two generations through independent port instances without double allocation', async () => {
          const fixture = await createFixture();
          if (!fixture.freshInstance)
            throw new Error(
              'Registry fixtures require a fresh-instance hook for two-port exclusion',
            );
          const other = await fixture.freshInstance();
          const first = fixture.ownedTarget('chat-a', 'child', 1);
          const second = fixture.ownedTarget('chat-a', 'child', 2);
          successValue(await fixture.port.open({ target: first }));
          successValue(await other.open({ target: second }));
          const attempts = await Promise.all([
            fixture.port.settle(settlementRequest(first)),
            other.settle(settlementRequest(second)),
          ]);
          expect(attempts.filter((result) => result.ok)).toHaveLength(1);
          const failed = attempts.find((result) => !result.ok);
          if (!failed) throw new Error('Expected a conflicting asserted index');
          expect(errorValue(failed)).toMatchObject({
            code: 'conflict',
            storedLastResultIndex: 1,
          });
          const losingTarget = attempts[0]?.ok ? second : first;
          expect(
            successValue(await other.settle(settlementRequest(losingTarget, 2)))
              .result.resultIndex,
          ).toBe(2);
        });
      } else {
        it.skip('two independent repository port instances (memory-only profile)', (): void => {});
      }

      it('refuses to invent receipts for metadata-less format-4 fixture rows', async () => {
        const fixture = await createFixture();
        if (!fixture.seedMetadataLessRows)
          throw new Error(
            'Registry fixtures require metadata-less-row seeding',
          );
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        successValue(await fixture.port.open({ target }));
        const row = textRow('old-test-row', 'no admission metadata');
        await fixture.seedMetadataLessRows(target, [row]);
        expect(
          errorValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'must-not-invent',
              changes: [{ row }],
            }),
          ).code,
        ).toBe('unsupported_format');
      });

      it('pages immutable result/generation entries at a high-water and rejects foreign or malformed cursors', async () => {
        const fixture = await createFixture();
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        for (let generation = 1; generation <= 3; generation += 1) {
          const next = { ...target, runGeneration: generation };
          successValue(
            await fixture.port.registerGeneration(generationRegistration(next)),
          );
          successValue(await fixture.port.open({ target: next }));
          successValue(
            await fixture.port.settle(settlementRequest(next, generation)),
          );
        }
        const page = successValue(
          await fixture.port.resultsPage({ ...target, limit: 1 }),
        );
        expect(page.results.map((entry) => entry.resultIndex)).toEqual([1]);
        expect(page.cursor).toBeDefined();
        const later = { ...target, runGeneration: 4 };
        successValue(
          await fixture.port.registerGeneration(generationRegistration(later)),
        );
        successValue(await fixture.port.open({ target: later }));
        successValue(await fixture.port.settle(settlementRequest(later, 4)));
        const rest = successValue(
          await fixture.port.resultsPage({
            ...target,
            limit: 100,
            cursor: page.cursor,
          }),
        );
        expect(rest.results.map((entry) => entry.resultIndex)).toEqual([2, 3]);
        expect(rest.cursor).toBeUndefined();
        expect(
          successValue(
            await fixture.port.resultsPage({ ...target, limit: 100 }),
          ).results,
        ).toHaveLength(4);
        for (const input of [
          { ...target, cursor: 'malformed' },
          { ...target, delegationId: 'other', cursor: page.cursor },
          { ...target, cursor: 'x'.repeat(2049) },
        ]) {
          expect(
            errorValue(await fixture.port.resultsPage({ ...input, limit: 1 }))
              .code,
          ).toBe('invalid_request');
        }
        expect(
          errorValue(
            await fixture.port.generationsPage({
              ...target,
              limit: 1,
              cursor: page.cursor,
            }),
          ).code,
        ).toBe('invalid_request');
      });

      it('preserves original receipt revisions/keys in request order for subsets and recombinations past 4096 ids', async () => {
        const fixture = await createFixture();
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        successValue(await fixture.port.open({ target }));
        const a = textRow('a', 'one');
        const b = textRow('b', 'two');
        const c = textRow('c', 'three');
        const original = successValue(
          await fixture.port.appendChanges({
            target,
            mutationKey: 'original',
            changes: [{ row: a }, { row: b }],
          }),
        );
        const next = successValue(
          await fixture.port.appendChanges({
            target,
            mutationKey: 'second',
            changes: [{ row: c }],
          }),
        );
        for (let i = 0; i < 4097; i += 1) {
          successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: `later-${i}`,
              changes: [{ row: textRow(`later-${i}`, 'later') }],
            }),
          );
        }
        const replay = successValue(
          await fixture.port.appendChanges({
            target,
            mutationKey: 'new-retry-key',
            changes: [{ row: b }, { row: a }],
          }),
        );
        expect(replay).toEqual({
          ...original,
          replayed: true,
          items: [...original.items].reverse(),
        });
        expect(
          successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'subset',
              changes: [{ row: a }],
            }),
          ),
        ).toMatchObject({
          mutationKey: 'original',
          streamRevision: original.streamRevision,
          replayed: true,
        });
        expect(
          successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'combined',
              changes: [{ row: a }, { row: c }],
            }),
          ),
        ).toMatchObject({
          mutationKey: 'combined',
          streamRevision: next.streamRevision,
          replayed: true,
        });
        await visitDurabilityViews(fixture, async (port): Promise<void> => {
          expect(
            successValue(
              await port.appendChanges({
                target,
                mutationKey: 'after-boundary',
                changes: [{ row: a }, { row: b }],
              }),
            ),
          ).toEqual({ ...original, replayed: true });
        });
      });

      it('advances latestRowTimestamp monotonically on admission only and records openedAt', async () => {
        const fixture = await createFixture();
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        successValue(
          await fixture.port.registerGeneration(generationRegistration(target)),
        );
        const opened = successValue(await fixture.port.open({ target }));
        expect(typeof opened.openedAt).toBe('number');
        expect(opened.latestRowTimestamp).toBeNull();
        const row = { ...textRow('recent', 'recent'), timestamp: 500 };
        successValue(
          await fixture.port.appendChanges({
            target,
            mutationKey: 'recent',
            changes: [{ row }],
          }),
        );
        successValue(
          await fixture.port.appendChanges({
            target,
            mutationKey: 'older',
            changes: [
              { row: { ...textRow('older', 'older'), timestamp: 200 } },
            ],
          }),
        );
        successValue(
          await fixture.port.appendChanges({
            target,
            mutationKey: 'replay',
            changes: [{ row }],
          }),
        );
        expect(successValue(await fixture.port.open({ target }))).toMatchObject(
          { openedAt: opened.openedAt, latestRowTimestamp: 500 },
        );
        const other = { ...target, runGeneration: 2 };
        successValue(await fixture.port.open({ target: other }));
        expect(
          successValue(await fixture.port.open({ target })).latestRowTimestamp,
        ).toBe(500);
        await visitDurabilityViews(fixture, async (port): Promise<void> => {
          expect(
            successValue(await port.generation(target)).stream,
          ).toMatchObject({
            openedAt: opened.openedAt,
            latestRowTimestamp: 500,
          });
        });
      });

      it.each(['utf8', 'utf16le'])(
        'ranges a 40 MiB %s answer (repository profile verifies all durability views)',
        async (encoding) => {
          const fixture = await createFixture();
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(await fixture.port.open({ target }));
          const text =
            encoding === 'utf8'
              ? 'a'.repeat(40 * 1024 * 1024)
              : '\ud800'.repeat(20 * 1024 * 1024);
          const request: DelegationTranscriptSettleRequest = {
            ...settlementRequest(target),
            answer: { role: 'partial', text },
          };
          const settled = successValue(await fixture.port.settle(request));
          expect(settled.result.answer).toMatchObject({
            kind: 'body',
            role: 'partial',
            encoding,
            byteLength: 40 * 1024 * 1024,
          });
          const first = successValue(
            await fixture.port.resultAnswerRange({
              ...target,
              resultIndex: 1,
              offset: 0,
              limit: 65536,
            }),
          );
          expect(first).toMatchObject({
            text: text.slice(0, encoding === 'utf8' ? 65536 : 32768),
            nextOffset: 65536,
            byteLength: 40 * 1024 * 1024,
            encoding,
          });
          const newer = { ...target, runGeneration: 2 };
          successValue(await fixture.port.open({ target: newer }));
          successValue(await fixture.port.settle(settlementRequest(newer, 2)));
          await visitDurabilityViews(fixture, async (port): Promise<void> => {
            expect(
              successValue(await port.result({ ...target, resultIndex: 1 })),
            ).toEqual(settled.result);
            const tail = successValue(
              await port.resultAnswerRange({
                ...target,
                resultIndex: 1,
                offset: 40 * 1024 * 1024 - 4,
                limit: 4,
              }),
            );
            expect(tail.text).toBe(text.slice(encoding === 'utf8' ? -4 : -2));
            expect(tail.nextOffset).toBeUndefined();
          });
        },
      );

      it('distinguishes absent/empty answers and validates answer character boundaries', async () => {
        const fixture = await createFixture();
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        successValue(await fixture.port.open({ target }));
        const request: DelegationTranscriptSettleRequest = {
          ...settlementRequest(target),
          answer: { role: 'final', text: '' },
        };
        const settled = successValue(await fixture.port.settle(request));
        expect(settled.result.answer).toEqual({ kind: 'empty', role: 'final' });
        expect(
          successValue(
            await fixture.port.resultAnswerRange({
              ...target,
              resultIndex: 1,
              offset: 0,
              limit: 4,
            }),
          ),
        ).toMatchObject({ text: '', byteLength: 0 });
        // Same byte rules as contentRange, over zero bytes.
        await visitDurabilityViews(fixture, async (port): Promise<void> => {
          for (const range of [
            { offset: 1, limit: 4 },
            { offset: 0, limit: 3 },
            { offset: 0, limit: 65_537 },
          ])
            expect(
              errorValue(
                await port.resultAnswerRange({
                  ...target,
                  resultIndex: 1,
                  ...range,
                }),
              ).code,
            ).toBe('invalid_request');
        });
        const other = { ...target, runGeneration: 2 };
        successValue(await fixture.port.open({ target: other }));
        successValue(
          await fixture.port.settle({
            ...settlementRequest(other, 2),
            answer: { role: 'final', text: '😀é' },
          }),
        );
        expect(
          errorValue(
            await fixture.port.resultAnswerRange({
              ...target,
              resultIndex: 2,
              offset: 1,
              limit: 4,
            }),
          ).code,
        ).toBe('invalid_request');
      });

      it('normalizes settled pins after card changes but rejects pre-settlement and future pins', async () => {
        const fixture = await createFixture();
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        successValue(await fixture.port.open({ target }));
        const request = {
          ...settlementRequest(target),
          finalChanges: [
            { row: textRow('a', 'one', 0, { final: true, sequence: 0 }) },
            { row: textRow('b', 'two', 0, { final: true, sequence: 1 }) },
          ],
        };
        const settled = successValue(await fixture.port.settle(request));
        const pin = settled.settlement.contentRevision;
        const first = successValue(
          await fixture.port.page({ target, streamRevision: pin, limit: 1 }),
        );
        if (!fixture.updateCardState)
          throw new Error('Registry fixtures require a card-state update hook');
        await fixture.updateCardState(target);
        const state = successValue(await fixture.port.open({ target }));
        expect(first.rows).toEqual([request.finalChanges[1].row]);
        expect(first.cursor).toBeDefined();
        expect(first.streamRevision).toBe(pin);
        expect(state.status).toBe('settled');
        expect(state.streamRevision).toBeGreaterThan(pin);
        async function verifyPins(
          port: DelegationTranscriptPort,
        ): Promise<void> {
          for (const streamRevision of [pin, state.streamRevision]) {
            const second = successValue(
              await port.page({
                target,
                streamRevision,
                cursor: first.cursor,
                limit: 1,
              }),
            );
            expect(second.rows).toEqual([request.finalChanges[0].row]);
            expect(second.cursor).toBeUndefined();
            expect(second.streamRevision).toBe(pin);
            expect(
              [...first.rows, ...second.rows].map((row) => row.id),
            ).toEqual(['b', 'a']);
            for (const { row } of request.finalChanges) {
              expect(
                successValue(
                  await port.message({
                    target,
                    streamRevision,
                    messageId: row.id,
                  }),
                ),
              ).toEqual(row);
              expect(
                successValue(
                  await port.contentRange({
                    target,
                    streamRevision,
                    messageId: row.id,
                    blockOrdinal: 0,
                    field: 'text',
                    offset: 0,
                    limit: 4,
                  }),
                ),
              ).toMatchObject({
                text: row.id === 'a' ? 'one' : 'two',
                byteLength: 3,
              });
            }
          }
        }
        await verifyPins(fixture.port);
        expect(
          errorValue(
            await fixture.port.page({
              target,
              streamRevision: state.streamRevision + 1,
            }),
          ).code,
        ).toBe('stale_identity');
        expect(
          errorValue(
            await fixture.port.message({
              target,
              streamRevision: pin - 1,
              messageId: 'a',
            }),
          ).code,
        ).toBe('stale_identity');
        expect(successValue(await fixture.port.settle(request)).result).toEqual(
          settled.result,
        );
        await visitDurabilityViews(fixture, verifyPins);
      });

      if (options.durability === 'repository') {
        it('preserves settlement replay, original receipts and P9 state after every required durability boundary', async () => {
          const fixture = await createFixture();
          requireRepositoryDurability(fixture, factory);
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          successValue(
            await fixture.port.registerGeneration(
              generationRegistration(target),
            ),
          );
          const opened = successValue(await fixture.port.open({ target }));
          const row = {
            ...textRow('original-final', 'stable', 0, { final: true }),
            timestamp: 500,
          };
          const original = successValue(
            await fixture.port.appendChanges({
              target,
              mutationKey: 'original-admission',
              changes: [{ row }],
            }),
          );
          const request = {
            ...settlementRequest(target),
            finalChanges: [{ row }],
          };
          const settled = successValue(await fixture.port.settle(request));
          await visitDurabilityViews(fixture, async (port): Promise<void> => {
            expect(successValue(await port.settle(request))).toEqual({
              ...settled,
              settlement: { ...settled.settlement, replayed: true },
            });
            expect(
              successValue(
                await port.appendChanges({
                  target,
                  mutationKey: 'different-retry-key',
                  changes: [{ row }],
                }),
              ),
            ).toEqual({ ...original, replayed: true });
            expect(successValue(await port.open({ target }))).toMatchObject({
              status: 'settled',
              openedAt: opened.openedAt,
              latestRowTimestamp: 500,
            });
            expect(
              successValue(await port.generation(target)).stream,
            ).toMatchObject({
              openedAt: opened.openedAt,
              latestRowTimestamp: 500,
            });
          });
        });

        it.each([
          'before-write',
          'after-write',
        ] satisfies readonly DelegationTranscriptPortFailurePhase[])(
          'settlement survives %s without consuming another index',
          async (phase) => {
            const fixture = await createFixture();
            requireRepositoryDurability(fixture, factory);
            const target = fixture.ownedTarget('chat-a', 'child', 1);
            successValue(
              await fixture.port.registerGeneration(
                generationRegistration(target),
              ),
            );
            const opened = successValue(await fixture.port.open({ target }));
            const row = {
              ...textRow('before-fault', 'retained', 0, { final: true }),
              timestamp: 600,
            };
            const original = successValue(
              await fixture.port.appendChanges({
                target,
                mutationKey: 'before-fault',
                changes: [{ row }],
              }),
            );
            await fixture.injectStorageFailure(phase);
            const request = settlementRequest(target);
            expect(errorValue(await fixture.port.settle(request)).code).toBe(
              'storage_failure',
            );
            const port = (await fixture.reopen()) ?? fixture.port;
            if (phase === 'before-write') {
              expect(
                errorValue(await port.result({ ...target, resultIndex: 1 }))
                  .code,
              ).toBe('not_found');
              expect(successValue(await port.open({ target }))).toMatchObject({
                status: 'open',
                streamRevision: original.streamRevision,
              });
            }
            const settled = successValue(await port.settle(request));
            expect(settled.result.resultIndex).toBe(1);
            expect(successValue(await port.settle(request))).toEqual({
              ...settled,
              settlement: { ...settled.settlement, replayed: true },
            });
            expect(
              successValue(await port.resultsPage({ ...target, limit: 100 }))
                .results,
            ).toEqual([settled.result]);
            expect(
              successValue(
                await port.appendChanges({
                  target,
                  mutationKey: 'after-fault',
                  changes: [{ row }],
                }),
              ),
            ).toEqual({ ...original, replayed: true });
            expect(successValue(await port.open({ target }))).toMatchObject({
              status: 'settled',
              openedAt: opened.openedAt,
              latestRowTimestamp: 600,
            });
            expect(
              successValue(await port.generation(target)).stream,
            ).toMatchObject({
              openedAt: opened.openedAt,
              latestRowTimestamp: 600,
            });
          },
        );
      } else {
        it.skip('repository reopen/checkpoint/fresh-instance/no-journal replay and P9 boundaries (memory-only profile)', (): void => {});
        it.skip('repository before-write/after-write fault recovery (memory-only profile)', (): void => {});
      }
    }

    it('honors an already-aborted signal without opening or mutating the stream', async () => {
      const fixture = await createFixture();
      const target = fixture.ownedTarget('chat-a', 'child', 1);
      const controller = new AbortController();
      controller.abort();
      expect(
        errorValue(await fixture.port.open({ target }, controller.signal)).code,
      ).toBe('storage_failure');
      successValue(await fixture.port.open({ target }));
      expect(
        errorValue(
          await fixture.port.appendChanges(
            {
              target,
              mutationKey: 'aborted',
              changes: [{ row: textRow('aborted', 'not stored') }],
            },
            controller.signal,
          ),
        ).code,
      ).toBe('storage_failure');
      expect(
        errorValue(
          await fixture.port.message({
            target,
            streamRevision: 0,
            messageId: 'aborted',
          }),
        ).code,
      ).toBe('not_found');
    });

    if (factory.capabilities?.reopen !== false) {
      it('survives fixture reopen', async () => {
        const fixture = await createFixture();
        if (fixture.reopen === undefined) {
          if (factory.capabilities?.reopen === true) {
            throw new Error(
              'The factory advertised reopen without a reopen hook.',
            );
          }
          return;
        }
        const target = fixture.ownedTarget('chat-a', 'child', 1);
        await fixture.port.open({ target });
        successValue(
          await fixture.port.appendChanges({
            target,
            mutationKey: 'reopen',
            changes: [{ row: textRow('persisted', 'still here') }],
          }),
        );
        const reopenedPort = await fixture.reopen();
        const port = reopenedPort ?? fixture.port;
        expect(successValue(await port.open({ target })).streamRevision).toBe(
          1,
        );
        expect(
          successValue(
            await port.message({
              target,
              streamRevision: 1,
              messageId: 'persisted',
            }),
          ).blocks,
        ).toEqual([{ type: 'text', text: 'still here' }]);
      });
    } else {
      it.skip('survives fixture reopen (not supported by this factory)', (): void => {});
    }

    if (factory.capabilities?.storageFailure !== false) {
      it.each(['before-write', 'after-write'] as const)(
        'maps a %s failure to storage_failure without partial writes and retries safely',
        async (phase) => {
          const fixture = await createFixture();
          if (fixture.injectStorageFailure === undefined) {
            if (factory.capabilities?.storageFailure === true) {
              throw new Error(
                'The factory advertised storage failure injection without a hook.',
              );
            }
            return;
          }
          const target = fixture.ownedTarget('chat-a', 'child', 1);
          await fixture.port.open({ target });
          const row = textRow('failure-row', 'durable');
          await fixture.injectStorageFailure(phase);
          expect(
            errorValue(
              await fixture.port.appendChanges({
                target,
                mutationKey: `failure-${phase}`,
                changes: [{ row }],
              }),
            ).code,
          ).toBe('storage_failure');

          if (phase === 'before-write') {
            expect(
              errorValue(
                await fixture.port.message({
                  target,
                  streamRevision: 0,
                  messageId: 'failure-row',
                }),
              ).code,
            ).toBe('not_found');
            expect(
              successValue(
                await fixture.port.appendChanges({
                  target,
                  mutationKey: `retry-${phase}`,
                  changes: [{ row }],
                }),
              ),
            ).toMatchObject({ replayed: false, streamRevision: 1 });
          } else {
            expect(
              successValue(
                await fixture.port.message({
                  target,
                  streamRevision: 1,
                  messageId: 'failure-row',
                }),
              ).blocks,
            ).toEqual([{ type: 'text', text: 'durable' }]);
            expect(
              successValue(
                await fixture.port.appendChanges({
                  target,
                  mutationKey: `retry-${phase}`,
                  changes: [{ row }],
                }),
              ),
            ).toMatchObject({ replayed: true, streamRevision: 1 });
          }
        },
      );
    } else {
      it.skip('maps injected storage failures (not supported by this factory)', (): void => {});
    }
  });
}
