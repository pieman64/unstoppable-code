import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentDelegationTranscript,
  AgentDelegationTranscriptItem,
} from '@canopy/protocol/delegation';
import {
  applyDelegationTranscriptEvent,
  delegationTranscriptMessages,
  type TranscriptReducerState,
} from '@canopy/agent-transcript';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import {
  activeSidecarMessageRecordBytes,
  checkActiveSidecarMessageRecordBudget,
  decodeActiveRowAnchors,
  delegationCardInsertionPredecessor,
  deriveActiveRowAnchor,
  effectiveActiveRowPredecessor,
  encodeActiveRowAnchors,
  parseActiveRowAnchor,
  rankLogicalPlacement,
  retargetActiveRowAnchorsAfterRemoval,
  resolveLogicalPlacement,
  validateActiveRowAnchors,
  type ActiveRowAnchor,
  type ActiveSidecarMessageRecord,
  type LogicalPlacement,
  type LogicalPositionRow,
} from '../lib/chat-transcript-live-positions';
import { MAX_TRANSCRIPT_ROW_BYTES } from '../lib/chat-transcript-prefix-replace';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import type { ChatMigrationEntry } from '../lib/chat-storage-v2';
import { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';

const CHAT = 'active-anchor-golden';
const GOLDEN_DIRECTORY = join(__dirname, 'fixtures', 'active-anchor-golden');
const FIXED_CLOCK = '2026-10-08T12:34:56.789Z';

function message(
  id: string,
  text = id,
  role: PersistedChatMessage['role'] = 'assistant',
): PersistedChatMessage {
  return {
    id,
    role,
    timestamp: 1,
    blocks: [{ type: 'text', text }],
  };
}

function anchor(
  runId: string,
  after: string | null,
  tie: number,
): ActiveRowAnchor {
  return { version: 1, runId, after, tie };
}

function logicalRow(messageValue: PersistedChatMessage): LogicalPositionRow {
  const delegation = messageValue.blocks.find(
    (block) => block.type === 'delegated_agent_call',
  );
  return {
    id: messageValue.id,
    ...(messageValue.parentBlockId !== undefined
      ? { parentBlockId: messageValue.parentBlockId }
      : {}),
    ...(delegation?.type === 'delegated_agent_call'
      ? {
          run: {
            delegationId: delegation.delegationId,
            generation: delegation.runGeneration,
          },
        }
      : {}),
  };
}

function logicalRows(
  messages: readonly PersistedChatMessage[],
): LogicalPositionRow[] {
  return messages.map(logicalRow);
}

function deriveAndStoreReferenceAnchor(
  before: readonly PersistedChatMessage[],
  row: PersistedChatMessage,
  anchors: Map<string, ActiveRowAnchor>,
  afterMessageId?: string | null,
): ActiveRowAnchor {
  const rowAnchor = deriveActiveRowAnchor({
    messageId: row.id,
    runId: row.parentBlockId ?? row.id,
    logicalRows: logicalRows(before),
    anchors,
    afterMessageId,
  });
  anchors.set(row.id, rowAnchor);
  return rowAnchor;
}

function expectBackendOrderMatchesReference(
  messages: readonly PersistedChatMessage[],
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
): void {
  expect(resolveAnchoredRowIds(logicalRows(messages), anchors)).toEqual(
    messages.map((row) => row.id),
  );
}

/** Test-only projection oracle: unanchored rows form the spine; anchors recurse. */
function resolveAnchoredRowIds(
  rows: readonly LogicalPositionRow[],
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
): string[] {
  const rowsById = new Map<string, LogicalPositionRow>(
    rows.map((row) => [row.id, row]),
  );
  const children = new Map<string | null, Array<[string, ActiveRowAnchor]>>();
  anchors.forEach((rowAnchor: ActiveRowAnchor, id: string) => {
    if (!rowsById.has(id))
      throw new Error(`Anchored row is missing from logical order: ${id}`);
    if (rowAnchor.after !== null && !rowsById.has(rowAnchor.after))
      throw new Error(
        `Anchor predecessor is missing from logical order: ${rowAnchor.after}`,
      );
    const siblings: Array<[string, ActiveRowAnchor]> =
      children.get(rowAnchor.after) ?? [];
    siblings.push([id, rowAnchor]);
    children.set(rowAnchor.after, siblings);
  });
  children.forEach((siblings: Array<[string, ActiveRowAnchor]>) =>
    siblings.sort((left, right) => left[1].tie - right[1].tie),
  );

  const ordered: string[] = [];
  const emitted = new Set<string>();
  const emitChildren = (predecessor: string | null): void => {
    for (const [id] of children.get(predecessor) ?? []) {
      if (emitted.has(id))
        throw new Error(`Anchor cycle or duplicate row: ${id}`);
      emitted.add(id);
      ordered.push(id);
      emitChildren(id);
    }
  };

  emitChildren(null);
  for (const row of rows) {
    if (anchors.has(row.id)) continue;
    if (emitted.has(row.id))
      throw new Error(`Duplicate logical row: ${row.id}`);
    emitted.add(row.id);
    ordered.push(row.id);
    emitChildren(row.id);
  }
  if (ordered.length !== rows.length)
    throw new Error(
      'Anchor resolution lost rows or found an unreachable cycle',
    );
  return ordered;
}

function reducerState(
  messages: PersistedChatMessage[] = [message('turn-1', 'prompt', 'user')],
): TranscriptReducerState {
  return {
    messages,
    status: 'idle',
    error: null,
    planMode: false,
  };
}

function delegationEvent(
  delegationId: string,
  generation: number,
  eventSequence: number,
  transcript: readonly AgentDelegationTranscriptItem[],
  parentTurnId = 'turn-1',
): AgentDelegationTranscript {
  return {
    delegationId,
    runGeneration: generation,
    sequence: eventSequence,
    parentHarnessId: 'parent-harness',
    parentTurnId,
    parentToolCallId: 'parent-tool-call-1',
    createdAt: 100,
    task: {
      description: `Delegate ${delegationId}`,
      prompt: 'Produce a deterministic test result.',
      executionMode: 'background',
    },
    snapshot: {
      delegationId,
      runGeneration: generation,
      requestedModelId: 'test-model',
      status: 'pending',
      outputTruncated: false,
    },
    transcript,
  };
}

function transcriptText(
  id: string,
  sequence: number,
  text: string,
): AgentDelegationTranscriptItem {
  return { id, sequence, occurredAt: sequence + 100, type: 'text', text };
}

function anchorRowsForReducerEvent(
  state: TranscriptReducerState,
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
  event: AgentDelegationTranscript,
  parentMessageId: string | null,
): Map<string, ActiveRowAnchor> {
  const projected = delegationTranscriptMessages(event);
  const card = projected.find((row) =>
    row.blocks.some((block) => block.type === 'delegated_agent_call'),
  );
  if (!card) throw new Error('Delegation event did not produce a card');
  const run = {
    cardId: card.id,
    delegationId: event.delegationId,
    generation: event.runGeneration,
  };
  const cardAlreadyExists = state.messages.some((row) => row.id === card.id);
  const cardPredecessor = cardAlreadyExists
    ? undefined
    : delegationCardInsertionPredecessor(
        logicalRows(state.messages),
        run,
        parentMessageId,
      );
  const nextAnchors = new Map(anchors);
  const workingRows = logicalRows(state.messages);
  const existingChildren = state.messages
    .filter((row) => row.parentBlockId === card.id)
    .sort(
      (left, right) =>
        (left.delegationSequence ?? 0) - (right.delegationSequence ?? 0),
    );
  let childPredecessor = existingChildren.at(-1)?.id ?? card.id;

  for (const row of projected) {
    const isCard = row.id === card.id;
    const afterMessageId = isCard ? cardPredecessor : childPredecessor;
    const rowAnchor = deriveActiveRowAnchor({
      messageId: row.id,
      runId: card.id,
      logicalRows: workingRows,
      anchors: nextAnchors,
      ...(isCard && cardPredecessor !== undefined
        ? { logicalPredecessor: cardPredecessor }
        : { afterMessageId }),
    });
    nextAnchors.set(row.id, rowAnchor);
    if (!workingRows.some((candidate) => candidate.id === row.id))
      workingRows.push(logicalRow(row));
    if (!isCard) childPredecessor = row.id;
  }
  return nextAnchors;
}

function applyReducerEventAndComparePositions(
  state: TranscriptReducerState,
  anchors: ReadonlyMap<string, ActiveRowAnchor>,
  event: AgentDelegationTranscript,
  parentMessageId: string | null = event.parentTurnId,
): { state: TranscriptReducerState; anchors: Map<string, ActiveRowAnchor> } {
  const nextAnchors = anchorRowsForReducerEvent(
    state,
    anchors,
    event,
    parentMessageId,
  );
  const nextState = applyDelegationTranscriptEvent(state, {
    delegation: event,
  });
  expect(
    resolveAnchoredRowIds(logicalRows(nextState.messages), nextAnchors),
  ).toEqual(nextState.messages.map((row) => row.id));
  return { state: nextState, anchors: nextAnchors };
}

function validationContext(
  options: {
    committed?: ReadonlySet<string>;
    active?: ReadonlySet<string>;
    owners?: ReadonlyMap<string, string>;
    runCards?: ReadonlySet<string>;
  } = {},
): Parameters<typeof validateActiveRowAnchors>[1] {
  const committed =
    options.committed ?? new Set(['committed-parent', 'run-card']);
  const active = options.active ?? new Set(['child']);
  const owners = options.owners ?? new Map([['child', 'run-card']]);
  const runCards = options.runCards ?? new Set(['run-card']);
  return {
    isCommittedMessage: (id) => committed.has(id),
    activeIds: active,
    runIdForMessage: (id) => owners.get(id),
    knownRunCardIds: runCards,
  };
}

function activeRecord(
  text: string,
  id = 'row-🌲"\\',
): ActiveSidecarMessageRecord {
  return {
    version: 2,
    kind: 'message',
    message: message(id, text),
    anchor: anchor(id.length <= 508 ? `run-${id}` : id, null, 0),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function createBackend(
  workspaceRoot: string,
  committedRows: readonly PersistedChatMessage[],
): Promise<ChatStateV2Backend> {
  const storage = new ChatStorageV2(workspaceRoot, 'scope');
  await storage.migrate(() =>
    Promise.resolve({
      revision: 0,
      index: { activeTabId: 'chat', runtimeByChatId: {} },
      recovery: {
        receipts: [],
        mutationIds: [],
        removedTabIds: [],
        removedArchiveEntryIds: [],
        removedMessageIds: [],
      },
      chats: (async function* (): AsyncGenerator<ChatMigrationEntry> {
        await Promise.resolve();
        yield {
          metadata: {
            id: 'chat',
            title: 'chat',
            createdAt: '2026-10-08T00:00:00.000Z',
          },
          messages: (async function* (): AsyncGenerator<PersistedChatMessage> {
            await Promise.resolve();
            for (const row of committedRows) yield row;
          })(),
        };
      })(),
    }),
  );
  const backend = new ChatStateV2Backend(storage);
  await backend.load();
  return backend;
}

describe('live transcript row positions', () => {
  describe('predecessor and anchor derivation', () => {
    const rows: LogicalPositionRow[] = [
      { id: 'turn' },
      { id: 'card' },
      { id: 'child-1', parentBlockId: 'card' },
      { id: 'child-2', parentBlockId: 'card' },
      { id: 'tail' },
    ];

    it('distinguishes explicit start, implicit tail, and a hinted direct-child group', () => {
      expect(effectiveActiveRowPredecessor(rows, 'new-tail')).toBe('tail');
      expect(effectiveActiveRowPredecessor(rows, 'new-start', null)).toBeNull();
      expect(
        effectiveActiveRowPredecessor(rows, 'new-after-card', 'card'),
      ).toBe('child-2');
      expect(effectiveActiveRowPredecessor(rows, 'tail')).toBe('child-2');

      expect(
        deriveActiveRowAnchor({
          messageId: 'implicit-tail',
          runId: 'run-1',
          logicalRows: rows,
          anchors: new Map(),
        }),
      ).toEqual(anchor('run-1', 'tail', 0));
      expect(
        deriveActiveRowAnchor({
          messageId: 'explicit-start',
          runId: 'run-1',
          logicalRows: rows,
          anchors: new Map(),
          afterMessageId: null,
        }),
      ).toEqual(anchor('run-1', null, 0));
      expect(
        deriveActiveRowAnchor({
          messageId: 'after-card',
          runId: 'run-1',
          logicalRows: rows,
          anchors: new Map(),
          afterMessageId: 'card',
        }),
      ).toEqual(anchor('run-1', 'child-2', 0));

      const afterChildGroup = new Map([
        ['older-run-row', anchor('run-older', 'child-2', 6)],
        ['other-generation-row', anchor('run-newer', 'child-2', -4)],
      ]);
      expect(
        deriveActiveRowAnchor({
          messageId: 'after-child-group',
          runId: 'run-third',
          logicalRows: rows,
          anchors: afterChildGroup,
          afterMessageId: 'card',
        }),
      ).toEqual(anchor('run-third', 'child-2', -5));

      expect(() =>
        effectiveActiveRowPredecessor(rows, 'new-row', 'new-row'),
      ).toThrow(/cannot be positioned after itself/);
      expect(() =>
        effectiveActiveRowPredecessor(rows, 'new-row', 'missing'),
      ).toThrow(/Unknown afterMessageId/);
      expect(() =>
        effectiveActiveRowPredecessor([...rows, { id: 'turn' }], 'new-row'),
      ).toThrow(/Duplicate logical row ID/);

      const exactGapInput = {
        messageId: 'new-row',
        runId: 'run-1',
        logicalRows: rows,
        anchors: new Map<string, ActiveRowAnchor>(),
      };
      expect(() =>
        deriveActiveRowAnchor({
          ...exactGapInput,
          logicalPredecessor: 'missing',
        }),
      ).toThrow(/Unknown logical predecessor/);
      expect(() =>
        deriveActiveRowAnchor({
          ...exactGapInput,
          logicalPredecessor: 'new-row',
          logicalRows: [...rows, { id: 'new-row' }],
        }),
      ).toThrow(/cannot be positioned after itself/);
      expect(() =>
        deriveActiveRowAnchor({
          ...exactGapInput,
          logicalPredecessor: 'card',
          afterMessageId: 'card',
        }),
      ).toThrow(/cannot be combined/);
    });

    it('freezes a same-owner row anchor across content updates and rejects ownership changes', () => {
      const saved = anchor('run-1', 'card', -4);
      const anchors = new Map([['child-1', saved]]);
      expect(
        deriveActiveRowAnchor({
          messageId: 'child-1',
          runId: 'run-1',
          logicalRows: rows,
          anchors,
          afterMessageId: null,
        }),
      ).toEqual(saved);
      expect(() =>
        deriveActiveRowAnchor({
          messageId: 'child-1',
          runId: 'another-run',
          logicalRows: rows,
          anchors,
        }),
      ).toThrow(/Run ID changed/);
    });

    it('uses the global minimum sibling tie across runs and generations', () => {
      const anchors = new Map([
        ['older-run-row', anchor('run-older', 'card', 7)],
        ['other-generation-row', anchor('run-newer', 'card', -3)],
      ]);
      expect(
        deriveActiveRowAnchor({
          messageId: 'new-row',
          runId: 'run-third',
          logicalRows: rows,
          anchors,
          afterMessageId: 'card',
        }),
      ).toEqual(anchor('run-third', 'child-2', 0));
      const sameGap = new Map([
        ['older-run-row', anchor('run-older', 'turn', 7)],
        ['other-generation-row', anchor('run-newer', 'turn', -3)],
      ]);
      expect(
        deriveActiveRowAnchor({
          messageId: 'new-row',
          runId: 'run-third',
          logicalRows: rows,
          anchors: sameGap,
          afterMessageId: 'turn',
        }),
      ).toEqual(anchor('run-third', 'turn', -4));

      const exhaustedTie = new Map([
        ['oldest-row', anchor('old-run', 'turn', Number.MIN_SAFE_INTEGER)],
      ]);
      expect(() =>
        deriveActiveRowAnchor({
          messageId: 'new-row',
          runId: 'run-third',
          logicalRows: rows,
          anchors: exhaustedTie,
          afterMessageId: 'turn',
        }),
      ).toThrow(/exhausted safe integers/);
    });
  });

  describe('delegation reducer differential', () => {
    it('matches the actual reducer when the first delegation begins at chat start', () => {
      const result = applyReducerEventAndComparePositions(
        reducerState([]),
        new Map(),
        delegationEvent('start-run', 1, 1, [
          transcriptText('first-child', 1, 'first'),
        ]),
        null,
      );
      expect(result.state.messages.map((row) => row.id)).toEqual([
        'delegated-agent-start-run',
        'delegated-agent-start-run:first-child',
      ]);
      expect(result.anchors.get('delegated-agent-start-run')).toEqual(
        anchor('delegated-agent-start-run', null, 0),
      );
    });

    it('keeps a new delegation card immediately after its parent before that parent’s direct children', () => {
      const result = applyReducerEventAndComparePositions(
        reducerState([
          message('turn-1', 'prompt', 'user'),
          { ...message('existing-parent-child'), parentBlockId: 'turn-1' },
          message('ordinary-tail'),
        ]),
        new Map(),
        delegationEvent('parent-child-order', 1, 1, [
          transcriptText('delegation-child', 1, 'delegated result'),
        ]),
        'turn-1',
      );
      expect(result.state.messages.map((row) => row.id)).toEqual([
        'turn-1',
        'delegated-agent-parent-child-order',
        'delegated-agent-parent-child-order:delegation-child',
        'existing-parent-child',
        'ordinary-tail',
      ]);
      expect(result.anchors.get('delegated-agent-parent-child-order')).toEqual(
        anchor('delegated-agent-parent-child-order', 'turn-1', 0),
      );
    });

    it('matches two runs arriving into one gap with global sibling ties', () => {
      let state = reducerState();
      let anchors: ReadonlyMap<string, ActiveRowAnchor> = new Map();
      for (const delegationId of ['run-a', 'run-b']) {
        const result = applyReducerEventAndComparePositions(
          state,
          anchors,
          delegationEvent(delegationId, 1, 1, [
            transcriptText(`${delegationId}-child`, 1, delegationId),
          ]),
        );
        state = result.state;
        anchors = result.anchors;
      }
      expect(
        resolveAnchoredRowIds(logicalRows(state.messages), anchors),
      ).toEqual(state.messages.map((row) => row.id));
      expect(anchors.get('delegated-agent-run-b')).toEqual(
        anchor('delegated-agent-run-b', 'turn-1', -1),
      );
    });

    it.each([
      ['low generation first', [1, 2]],
      ['high generation first', [2, 1]],
    ] as const)(
      'matches reducer generation order in both arrival orders (%s)',
      (_description, generations) => {
        let state = reducerState();
        let anchors: ReadonlyMap<string, ActiveRowAnchor> = new Map();
        for (const generation of generations) {
          const result = applyReducerEventAndComparePositions(
            state,
            anchors,
            delegationEvent('same-run', generation, 1, [
              transcriptText(
                `generation-${generation}`,
                1,
                `gen ${generation}`,
              ),
            ]),
          );
          state = result.state;
          anchors = result.anchors;
        }
        expect(state.messages.map((row) => row.id)).toEqual([
          'turn-1',
          'delegated-agent-same-run',
          'delegated-agent-same-run:generation-1',
          'delegated-agent-same-run-run-2',
          'delegated-agent-same-run-run-2:generation-2',
        ]);
      },
    );

    it('matches reducer recovery when the selected parent is later than an existing higher-generation card', () => {
      const higherGeneration = delegationEvent(
        'recovered-run',
        2,
        1,
        [transcriptText('high-child', 1, 'high generation')],
        'earlier-turn',
      );
      const seeded = applyReducerEventAndComparePositions(
        reducerState([
          message('earlier-turn', 'prompt', 'user'),
          message('ordinary-before-later-parent'),
          message('later-turn', 'later prompt', 'user'),
          message('ordinary-tail'),
        ]),
        new Map(),
        higherGeneration,
        'earlier-turn',
      );
      const recovered = applyReducerEventAndComparePositions(
        seeded.state,
        seeded.anchors,
        delegationEvent(
          'recovered-run',
          1,
          1,
          [transcriptText('low-child', 1, 'lower generation')],
          'later-turn',
        ),
        'later-turn',
      );
      expect(recovered.state.messages.map((row) => row.id)).toEqual([
        'earlier-turn',
        'delegated-agent-recovered-run',
        'delegated-agent-recovered-run:low-child',
        'delegated-agent-recovered-run-run-2',
        'delegated-agent-recovered-run-run-2:high-child',
        'ordinary-before-later-parent',
        'later-turn',
        'ordinary-tail',
      ]);
    });

    it('adds late children after the existing child group and does not move content updates', () => {
      const first = applyReducerEventAndComparePositions(
        reducerState(),
        new Map(),
        delegationEvent('late-child-run', 1, 1, [
          transcriptText('child-1', 1, 'first content'),
        ]),
      );
      const withLateChild = applyReducerEventAndComparePositions(
        first.state,
        first.anchors,
        delegationEvent('late-child-run', 1, 2, [
          transcriptText('child-1', 1, 'first content'),
          transcriptText('child-2', 2, 'late content'),
        ]),
      );
      expect(withLateChild.state.messages.map((row) => row.id)).toEqual([
        'turn-1',
        'delegated-agent-late-child-run',
        'delegated-agent-late-child-run:child-1',
        'delegated-agent-late-child-run:child-2',
      ]);
      const childAnchor = withLateChild.anchors.get(
        'delegated-agent-late-child-run:child-1',
      );
      const contentUpdate = applyReducerEventAndComparePositions(
        withLateChild.state,
        withLateChild.anchors,
        delegationEvent('late-child-run', 1, 3, [
          transcriptText('child-1', 1, 'updated content'),
          transcriptText('child-2', 2, 'late content'),
        ]),
      );
      expect(
        contentUpdate.anchors.get('delegated-agent-late-child-run:child-1'),
      ).toEqual(childAnchor);
      expect(contentUpdate.state.messages.map((row) => row.id)).toEqual(
        withLateChild.state.messages.map((row) => row.id),
      );
    });

    it('retargets surviving reducer rows after predecessor removal and rejects incomplete logical orders', () => {
      const initial = applyReducerEventAndComparePositions(
        reducerState(),
        new Map(),
        delegationEvent('remove-child-run', 1, 1, [
          transcriptText('child-1', 1, 'remove me'),
          transcriptText('child-2', 2, 'keep me'),
        ]),
      );
      const nextState = applyDelegationTranscriptEvent(initial.state, {
        delegation: delegationEvent('remove-child-run', 1, 2, [
          transcriptText('child-2', 2, 'keep me'),
        ]),
      });
      const removedIds = new Set(
        initial.state.messages
          .map((row) => row.id)
          .filter((id) => !nextState.messages.some((row) => row.id === id)),
      );
      const retargeted = retargetActiveRowAnchorsAfterRemoval(
        logicalRows(nextState.messages),
        initial.anchors,
        removedIds,
      );
      expect(
        resolveAnchoredRowIds(logicalRows(nextState.messages), retargeted),
      ).toEqual(nextState.messages.map((row) => row.id));
      expect(retargeted.has('delegated-agent-remove-child-run:child-1')).toBe(
        false,
      );
      expect(() =>
        retargetActiveRowAnchorsAfterRemoval(
          logicalRows(nextState.messages).filter(
            (row) => row.id !== 'delegated-agent-remove-child-run:child-2',
          ),
          initial.anchors,
          new Set(),
        ),
      ).toThrow(/Incomplete logical order/);
    });
  });

  describe('strict persistence parsing and validation', () => {
    it('distinguishes an absent anchor from explicit null/undefined and accepts only exact anchor fields', () => {
      expect(parseActiveRowAnchor({ version: 2, kind: 'message' })).toEqual({
        status: 'absent',
      });
      expect(
        parseActiveRowAnchor({
          version: 2,
          kind: 'message',
          anchor: anchor('run-card', 'prior', -1),
        }),
      ).toEqual({
        status: 'valid',
        anchor: anchor('run-card', 'prior', -1),
      });
      for (const invalidRecord of [
        { anchor: undefined },
        { anchor: null },
        { anchor: { version: 1, runId: 'run-card', after: null, tie: '0' } },
        {
          anchor: {
            version: 1,
            runId: 'run-card',
            after: null,
            tie: 0,
            unexpected: true,
          },
        },
        { anchor: { version: 1, runId: 'run-card', after: null } },
      ]) {
        const parsed = parseActiveRowAnchor(invalidRecord);
        expect(parsed.status).toBe('invalid');
        if (parsed.status === 'invalid')
          expect(parsed.reason.length).toBeGreaterThan(0);
      }
    });

    it('encodes Maps as strict JSON-safe tuples and rejects malformed or duplicate tuples', () => {
      const anchors = new Map([
        ['row-a', anchor('run-a', null, 0)],
        ['row-b', anchor('run-b', 'row-a', -1)],
      ]);
      const encoded = encodeActiveRowAnchors(anchors);
      expect(encoded).toEqual([
        ['row-a', anchor('run-a', null, 0)],
        ['row-b', anchor('run-b', 'row-a', -1)],
      ]);
      const decoded = decodeActiveRowAnchors(
        JSON.parse(JSON.stringify(encoded)),
      );
      expect(decoded).toEqual({ status: 'valid', anchors });

      const serializedMap = JSON.stringify(anchors);
      expect(serializedMap).toBe('{}');
      expect(decodeActiveRowAnchors(JSON.parse(serializedMap)).status).toBe(
        'invalid',
      );
      for (const invalid of [
        null,
        {},
        [['row-a']],
        [['row-a', anchor('run-a', null, 0), 'extra']],
        [Object.assign(['row-a', anchor('run-a', null, 0)], { extra: true })],
        [
          ['row-a', anchor('run-a', null, 0)],
          ['row-a', anchor('run-b', null, 0)],
        ],
        [['', anchor('run-a', null, 0)]],
        [['row-a', { version: 1, runId: 'run-a', after: null, tie: 1.5 }]],
      ]) {
        expect(decodeActiveRowAnchors(invalid).status).toBe('invalid');
      }
    });

    it('validates active ownership, known cards, committed/active predecessors, cycles, IDs, and global ties', () => {
      const good = new Map([
        ['child', anchor('run-card', 'committed-parent', 0)],
      ]);
      expect(validateActiveRowAnchors(good, validationContext())).toEqual({
        valid: true,
      });

      const cases: Array<
        [
          string,
          ReadonlyMap<string, ActiveRowAnchor>,
          Parameters<typeof validateActiveRowAnchors>[1],
        ]
      > = [
        [
          'inactive message',
          new Map([['child', anchor('run-card', null, 0)]]),
          validationContext({ active: new Set() }),
        ],
        [
          'wrong owner',
          new Map([['child', anchor('other-card', null, 0)]]),
          validationContext(),
        ],
        [
          'unknown card',
          new Map([['child', anchor('missing-card', null, 0)]]),
          validationContext({ owners: new Map([['child', 'missing-card']]) }),
        ],
        [
          'unavailable card',
          new Map([['child', anchor('run-card', null, 0)]]),
          validationContext({
            committed: new Set(),
            active: new Set(['child']),
            owners: new Map([['child', 'run-card']]),
            runCards: new Set(['run-card']),
          }),
        ],
        [
          'dangling predecessor',
          new Map([['child', anchor('run-card', 'missing', 0)]]),
          validationContext(),
        ],
        [
          'self predecessor',
          new Map([['child', anchor('run-card', 'child', 0)]]),
          validationContext(),
        ],
        [
          'cycle',
          new Map([
            ['child', anchor('run-card', 'other', 0)],
            ['other', anchor('run-card', 'child', -1)],
          ]),
          validationContext({
            active: new Set(['child', 'other']),
            owners: new Map([
              ['child', 'run-card'],
              ['other', 'run-card'],
            ]),
          }),
        ],
        [
          'duplicate global sibling tie across runs',
          new Map([
            ['child', anchor('run-card', 'committed-parent', 0)],
            ['other', anchor('other-card', 'committed-parent', 0)],
          ]),
          validationContext({
            active: new Set(['child', 'other']),
            owners: new Map([
              ['child', 'run-card'],
              ['other', 'other-card'],
            ]),
            runCards: new Set(['run-card', 'other-card']),
          }),
        ],
      ];
      for (const [description, anchors, context] of cases) {
        const result = validateActiveRowAnchors(anchors, context);
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.reason.length).toBeGreaterThan(0);
        else
          throw new Error(`Expected invalid anchor validation: ${description}`);
      }
    });

    it('returns validation errors instead of throwing for malformed and oversized IDs', () => {
      const oversizedId = 'm'.repeat(513);
      const malformedAnchor = {
        version: 1 as const,
        runId: 'run-card',
        after: null,
        tie: 0,
        unexpected: true,
      };
      const malformed = new Map<string, ActiveRowAnchor>([
        ['child', malformedAnchor],
      ]);
      const oversized = new Map([[oversizedId, anchor('run-card', null, 0)]]);
      expect(() =>
        validateActiveRowAnchors(malformed, validationContext()),
      ).not.toThrow();
      expect(
        validateActiveRowAnchors(malformed, validationContext()).valid,
      ).toBe(false);
      expect(() =>
        validateActiveRowAnchors(oversized, validationContext()),
      ).not.toThrow();
      expect(
        validateActiveRowAnchors(oversized, validationContext()).valid,
      ).toBe(false);
    });

    it('accepts the 512-UTF-16-code-unit ID limit', () => {
      const id = '😀'.repeat(256);
      const runId = 'r'.repeat(512);
      const context = validationContext({
        committed: new Set(['c'.repeat(512), runId]),
        active: new Set([id]),
        owners: new Map([[id, runId]]),
        runCards: new Set([runId]),
      });
      expect(
        validateActiveRowAnchors(
          new Map([[id, anchor(runId, 'c'.repeat(512), 0)]]),
          context,
        ),
      ).toEqual({ valid: true });
    });
  });

  describe('complete active-row byte budget', () => {
    it('measures complete UTF-8 JSON records and admits the exact 16 MiB plus padding ceiling', () => {
      const ceiling = MAX_TRANSCRIPT_ROW_BYTES + 1024;
      const prefix = '🌲"\\';
      const prefixRecord = activeRecord(prefix);
      const fillerLength =
        ceiling - activeSidecarMessageRecordBytes(prefixRecord);
      const exactRecord = activeRecord(`${prefix}${'x'.repeat(fillerLength)}`);
      const overRecord = activeRecord(
        `${prefix}${'x'.repeat(fillerLength + 1)}`,
      );
      expect(activeSidecarMessageRecordBytes(exactRecord)).toBe(ceiling);
      expect(checkActiveSidecarMessageRecordBudget(exactRecord)).toEqual({
        bytes: ceiling,
        ceiling,
        withinLimit: true,
      });
      expect(checkActiveSidecarMessageRecordBudget(overRecord)).toEqual({
        bytes: ceiling + 1,
        ceiling,
        withinLimit: false,
      });
      expect(activeSidecarMessageRecordBytes(prefixRecord)).toBe(
        Buffer.byteLength(JSON.stringify(prefixRecord), 'utf8'),
      );
    });

    it('includes finalizing metadata and escaped multibyte IDs at exact parameter ceilings', () => {
      const id = 'row-🌲"\\';
      const record: ActiveSidecarMessageRecord = {
        ...activeRecord('🌲 payload', id),
        anchor: anchor(`run-${id}`, `after-${id}`, -1),
        finalizing: true,
      };
      const bytes = activeSidecarMessageRecordBytes(record);
      expect(bytes).toBe(Buffer.byteLength(JSON.stringify(record), 'utf8'));
      expect(checkActiveSidecarMessageRecordBudget(record, bytes)).toEqual({
        bytes,
        ceiling: bytes,
        withinLimit: true,
      });
      expect(checkActiveSidecarMessageRecordBudget(record, bytes + 1)).toEqual({
        bytes,
        ceiling: bytes + 1,
        withinLimit: true,
      });
      expect(checkActiveSidecarMessageRecordBudget(record, bytes - 1)).toEqual({
        bytes,
        ceiling: bytes - 1,
        withinLimit: false,
      });
    });

    it('rejects a complete row whose individually bounded escaped IDs exceed reader padding', () => {
      const id = `${'😀'.repeat(253)}${'"\\'.repeat(3)}`;
      expect(id.length).toBe(512);
      const row = activeRecord('x'.repeat(MAX_TRANSCRIPT_ROW_BYTES - 1024), id);
      const result = checkActiveSidecarMessageRecordBudget(row);
      expect(result.bytes).toBeGreaterThan(MAX_TRANSCRIPT_ROW_BYTES + 1024);
      expect(result.withinLimit).toBe(false);
    });
  });

  describe('active sidecar golden replay', () => {
    it('reads numeric record anchors and documents the legacy anchor-dropping projection', async () => {
      const input = await readFile(
        join(GOLDEN_DIRECTORY, 'active-sidecar.input.jsonl'),
        'utf8',
      );
      const expectedOutput = await readFile(
        join(GOLDEN_DIRECTORY, 'active-sidecar.output.jsonl'),
        'utf8',
      );
      const parsedInputRows = input
        .split('\n')
        .filter((line) => line.length > 0)
        .slice(1)
        .map((line) => {
          const record: unknown = JSON.parse(line);
          if (!isRecord(record))
            throw new Error('Invalid golden sidecar record');
          return parseActiveRowAnchor(record);
        });
      expect(parsedInputRows).toEqual([
        {
          status: 'valid',
          anchor: anchor(
            'delegated-agent-anchor-golden',
            'parent-tool-call-1',
            0,
          ),
        },
        {
          status: 'valid',
          anchor: anchor(
            'delegated-agent-anchor-golden',
            'delegated-agent-anchor-golden',
            0,
          ),
        },
      ]);

      const root = await mkdtemp(join(tmpdir(), 'active-anchor-golden-'));
      const log = new ChatTranscriptLog(root);
      try {
        await log.initialize(CHAT);
        const sidecarPath = join(root, `${CHAT}.active.json`);
        await writeFile(sidecarPath, input);
        const acceptedRows = await log.activeMessages(CHAT);
        expect(acceptedRows.map((row) => row.id)).toEqual([
          'delegated-agent-anchor-golden',
          'delegated-agent-anchor-golden:child-answer',
        ]);
        expect(await log.activeRowAnchors(CHAT)).toEqual(
          new Map([
            [
              'delegated-agent-anchor-golden',
              anchor('delegated-agent-anchor-golden', 'parent-tool-call-1', 0),
            ],
            [
              'delegated-agent-anchor-golden:child-answer',
              anchor(
                'delegated-agent-anchor-golden',
                'delegated-agent-anchor-golden',
                0,
              ),
            ],
          ]),
        );
        // Before record-level anchors, writeActive serialized only the header
        // and message projection. Keep that historical golden as documentation
        // without asking the new anchor-preserving writer to drop metadata.
        const legacyProjection = [
          JSON.stringify({
            version: 2,
            transcriptRevision: 1,
            updatedAt: FIXED_CLOCK,
          }),
          ...acceptedRows.map((message) =>
            JSON.stringify({ version: 2, kind: 'message', message }),
          ),
          '',
        ].join('\n');
        expect(legacyProjection).toBe(expectedOutput);
        expect(await readFile(sidecarPath, 'utf8')).toBe(input);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('ChatStateV2Backend insertion and frozen-row seam', () => {
    // Six durable backend transactions; fsync-bound under host load.
    it('uses backend committed/active group insertion while updates keep existing rows in place', async () => {
      const root = await mkdtemp(join(tmpdir(), 'chat-live-position-backend-'));
      let backend: ChatStateV2Backend | undefined;
      const referenceAnchors = new Map<string, ActiveRowAnchor>();
      try {
        backend = await createBackend(root, [
          message('turn', 'prompt', 'user'),
          message('committed-anchor'),
          {
            ...message('committed-child'),
            parentBlockId: 'committed-anchor',
          },
          message('committed-tail'),
        ]);
        const beforeCommittedInsert = (await backend.page('chat')).messages;
        const committedInsert = message('committed-insert');
        deriveAndStoreReferenceAnchor(
          beforeCommittedInsert,
          committedInsert,
          referenceAnchors,
          'committed-anchor',
        );
        await backend.transact(
          () => [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: committedInsert,
              afterMessageId: 'committed-anchor',
            },
          ],
          { source: 'automation' },
        );
        const afterCommittedInsert = (await backend.page('chat')).messages;
        expectBackendOrderMatchesReference(
          afterCommittedInsert,
          referenceAnchors,
        );
        expect(afterCommittedInsert.map((row) => row.id)).toEqual([
          'turn',
          'committed-anchor',
          'committed-child',
          'committed-insert',
          'committed-tail',
        ]);

        await backend.transact(
          () => [
            {
              type: 'runtime.patched',
              chatId: 'chat',
              runtime: { status: 'streaming', queuedMessageIds: [] },
            },
          ],
          { source: 'automation' },
        );

        const beforeActiveOwner = (await backend.page('chat')).messages;
        const activeOwner = message('active-owner');
        deriveAndStoreReferenceAnchor(
          beforeActiveOwner,
          activeOwner,
          referenceAnchors,
        );
        await backend.transact(
          () => [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: activeOwner,
            },
          ],
          { source: 'automation' },
        );
        const afterActiveOwner = (await backend.page('chat')).messages;
        expectBackendOrderMatchesReference(afterActiveOwner, referenceAnchors);

        const activeChild: PersistedChatMessage = {
          ...message('active-child'),
          parentBlockId: 'active-owner',
        };
        deriveAndStoreReferenceAnchor(
          afterActiveOwner,
          activeChild,
          referenceAnchors,
          'active-owner',
        );
        await backend.transact(
          () => [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: activeChild,
              afterMessageId: 'active-owner',
            },
          ],
          { source: 'automation' },
        );
        const afterActiveChild = (await backend.page('chat')).messages;
        expectBackendOrderMatchesReference(afterActiveChild, referenceAnchors);

        const activeAfterGroup = message('active-after-group');
        deriveAndStoreReferenceAnchor(
          afterActiveChild,
          activeAfterGroup,
          referenceAnchors,
          'active-owner',
        );
        await backend.transact(
          () => [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: activeAfterGroup,
              afterMessageId: 'active-owner',
            },
          ],
          { source: 'automation' },
        );
        const afterActiveGroup = (await backend.page('chat')).messages;
        expectBackendOrderMatchesReference(afterActiveGroup, referenceAnchors);

        const updatedOwner = message('active-owner', 'updated in place');
        const frozenOwnerAnchor = referenceAnchors.get('active-owner');
        if (!frozenOwnerAnchor)
          throw new Error('Expected a reference anchor for the active owner');
        expect(
          deriveAndStoreReferenceAnchor(
            afterActiveGroup,
            updatedOwner,
            referenceAnchors,
            'turn',
          ),
        ).toEqual(frozenOwnerAnchor);
        await backend.transact(
          () => [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: updatedOwner,
              afterMessageId: 'turn',
            },
          ],
          { source: 'automation' },
        );

        const activeResult = await backend.page('chat');
        expectBackendOrderMatchesReference(
          activeResult.messages,
          referenceAnchors,
        );
        expect(activeResult.messages.map((row) => row.id)).toEqual([
          'turn',
          'committed-anchor',
          'committed-child',
          'committed-insert',
          'committed-tail',
          'active-owner',
          'active-child',
          'active-after-group',
        ]);
        expect(
          activeResult.messages.find((row) => row.id === 'active-owner'),
        ).toEqual(updatedOwner);
      } finally {
        if (backend) await backend.disposeArtifactMaintenance();
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);

    it('keeps late out-of-order active children frozen while the reducer reorders them by sequence', async () => {
      const firstEvent = delegationEvent('out-of-order-run', 1, 1, [
        transcriptText('child-2', 2, 'second by sequence'),
      ]);
      const lateEvent = delegationEvent('out-of-order-run', 1, 2, [
        transcriptText('child-1', 1, 'first by sequence'),
        transcriptText('child-2', 2, 'second by sequence'),
      ]);
      const firstProjection = delegationTranscriptMessages(firstEvent);
      const card = firstProjection.find((row) =>
        row.blocks.some((block) => block.type === 'delegated_agent_call'),
      );
      if (!card) throw new Error('Expected a projected delegation card');
      const secondChild = firstProjection.find(
        (row) => row.parentBlockId === card.id,
      );
      if (!secondChild)
        throw new Error('Expected the first projected delegation child');
      const lateProjection = delegationTranscriptMessages(lateEvent);
      const firstChild = lateProjection.find(
        (row) => row.parentBlockId === card.id && row.delegationSequence === 1,
      );
      const updatedSecondChild = lateProjection.find(
        (row) => row.parentBlockId === card.id && row.delegationSequence === 2,
      );
      if (!firstChild || !updatedSecondChild)
        throw new Error('Expected both projected delegation children');

      const reducerAfterFirst = applyDelegationTranscriptEvent(reducerState(), {
        delegation: firstEvent,
      });
      const reducerAfterLateChild = applyDelegationTranscriptEvent(
        reducerAfterFirst,
        { delegation: lateEvent },
      );
      expect(
        reducerAfterLateChild.messages
          .filter((row) => row.parentBlockId === card.id)
          .map((row) => row.id),
      ).toEqual([firstChild.id, secondChild.id]);

      // Sequence-sorted reducer insertion uses an exact gap, not a group hint.
      const reducerAnchors = anchorRowsForReducerEvent(
        reducerState(),
        new Map(),
        firstEvent,
        firstEvent.parentTurnId,
      );
      const frozenSecondChild = reducerAnchors.get(secondChild.id);
      reducerAnchors.set(
        firstChild.id,
        deriveActiveRowAnchor({
          messageId: firstChild.id,
          runId: card.id,
          logicalRows: logicalRows(reducerAfterFirst.messages),
          anchors: reducerAnchors,
          logicalPredecessor: card.id,
        }),
      );
      expect(reducerAnchors.get(secondChild.id)).toEqual(frozenSecondChild);
      expectBackendOrderMatchesReference(
        reducerAfterLateChild.messages,
        reducerAnchors,
      );

      const root = await mkdtemp(
        join(tmpdir(), 'chat-live-position-late-child-'),
      );
      let backend: ChatStateV2Backend | undefined;
      const referenceAnchors = new Map<string, ActiveRowAnchor>();
      try {
        backend = await createBackend(root, [
          message('turn-1', 'prompt', 'user'),
        ]);
        await backend.transact(
          () => [
            {
              type: 'runtime.patched',
              chatId: 'chat',
              runtime: { status: 'streaming', queuedMessageIds: [] },
            },
          ],
          { source: 'automation' },
        );

        const beforeCard = (await backend.page('chat')).messages;
        deriveAndStoreReferenceAnchor(beforeCard, card, referenceAnchors);
        await backend.transact(
          () => [{ type: 'message.upserted', chatId: 'chat', message: card }],
          { source: 'automation' },
        );
        const afterCard = (await backend.page('chat')).messages;
        expectBackendOrderMatchesReference(afterCard, referenceAnchors);

        deriveAndStoreReferenceAnchor(
          afterCard,
          secondChild,
          referenceAnchors,
          card.id,
        );
        await backend.transact(
          () => [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: secondChild,
              afterMessageId: card.id,
            },
          ],
          { source: 'automation' },
        );
        const afterSecondChild = (await backend.page('chat')).messages;
        expectBackendOrderMatchesReference(afterSecondChild, referenceAnchors);

        deriveAndStoreReferenceAnchor(
          afterSecondChild,
          firstChild,
          referenceAnchors,
          card.id,
        );
        await backend.transact(
          () => [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: firstChild,
              afterMessageId: card.id,
            },
          ],
          { source: 'automation' },
        );
        const afterLateChild = (await backend.page('chat')).messages;
        expectBackendOrderMatchesReference(afterLateChild, referenceAnchors);
        expect(afterLateChild.map((row) => row.id)).toEqual([
          'turn-1',
          card.id,
          secondChild.id,
          firstChild.id,
        ]);

        const updatedChild: PersistedChatMessage = {
          ...updatedSecondChild,
          blocks: [{ type: 'text', text: 'updated content; still second' }],
        };
        const frozenChildAnchor = referenceAnchors.get(secondChild.id);
        if (!frozenChildAnchor)
          throw new Error('Expected a reference anchor for the second child');
        expect(
          deriveAndStoreReferenceAnchor(
            afterLateChild,
            updatedChild,
            referenceAnchors,
            'turn-1',
          ),
        ).toEqual(frozenChildAnchor);
        await backend.transact(
          () => [
            {
              type: 'message.upserted',
              chatId: 'chat',
              message: updatedChild,
              afterMessageId: 'turn-1',
            },
          ],
          { source: 'automation' },
        );

        const afterContentUpdate = (await backend.page('chat')).messages;
        expectBackendOrderMatchesReference(
          afterContentUpdate,
          referenceAnchors,
        );
        expect(afterContentUpdate.map((row) => row.id)).toEqual([
          'turn-1',
          card.id,
          secondChild.id,
          firstChild.id,
        ]);
        expect(
          afterContentUpdate.find((row) => row.id === secondChild.id),
        ).toEqual(updatedChild);
      } finally {
        if (backend) await backend.disposeArtifactMaintenance();
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000); // Real backend/storage integration can exceed the default test timeout.
  });
});

describe('logical transcript placement', () => {
  it('places start followers before committed roots, committed followers by DFS, and ordinary active rows at the tail', () => {
    const activeRows = [
      { id: 'duplicate-committed-row' },
      { id: 'start-later' },
      { id: 'start-later-child' },
      { id: 'tail-ordinary' },
      { id: 'committed-later' },
      { id: 'committed-first-child' },
      { id: 'start-first' },
      { id: 'start-first-child' },
      { id: 'committed-first' },
      { id: 'tail-follower' },
      { id: 'duplicate-follower' },
      { id: 'tail-next' },
    ];
    const committedIds = new Set([
      'committed-root',
      'duplicate-committed-row',
      'run-start',
      'run-committed',
      'run-tail',
      'run-duplicate',
    ]);
    const runOwners = new Map<string, string>([
      ['start-later', 'run-start'],
      ['start-later-child', 'run-start'],
      ['start-first', 'run-start'],
      ['start-first-child', 'run-start'],
      ['committed-later', 'run-committed'],
      ['committed-first', 'run-committed'],
      ['committed-first-child', 'run-committed'],
      ['tail-follower', 'run-tail'],
      ['duplicate-committed-row', 'run-duplicate'],
      ['duplicate-follower', 'run-duplicate'],
    ]);
    const anchors = new Map<string, ActiveRowAnchor>([
      ['start-later', anchor('run-start', null, 2)],
      ['start-later-child', anchor('run-start', 'start-later', 0)],
      ['tail-follower', anchor('run-tail', 'tail-ordinary', 0)],
      ['committed-later', anchor('run-committed', 'committed-root', 5)],
      ['committed-first-child', anchor('run-committed', 'committed-first', 0)],
      ['start-first', anchor('run-start', null, -1)],
      ['committed-first', anchor('run-committed', 'committed-root', -1)],
      ['duplicate-committed-row', anchor('run-duplicate', null, 99)],
      [
        'duplicate-follower',
        anchor('run-duplicate', 'duplicate-committed-row', 0),
      ],
      ['start-first-child', anchor('run-start', 'start-first', 0)],
    ]);

    const placement = resolveLogicalPlacement({
      activeRows,
      anchors,
      isCommittedMessage: (id) => committedIds.has(id),
      knownRunCardIds: new Set([
        'run-start',
        'run-committed',
        'run-tail',
        'run-duplicate',
      ]),
      runIdForMessage: (id) => runOwners.get(id),
    });

    expect(placement.start.map((row) => row.id)).toEqual([
      'start-first',
      'start-first-child',
      'start-later',
      'start-later-child',
    ]);
    expect(
      placement.afterCommitted.get('committed-root')?.map((row) => row.id),
    ).toEqual(['committed-first', 'committed-first-child', 'committed-later']);
    expect(
      placement.afterCommitted
        .get('duplicate-committed-row')
        ?.map((row) => row.id),
    ).toEqual(['duplicate-follower']);
    expect(placement.tail.map((row) => row.id)).toEqual([
      'tail-ordinary',
      'tail-follower',
      'tail-next',
    ]);
    expect([
      ...placement.start,
      ...Array.from(placement.afterCommitted.values()).flat(),
      ...placement.tail,
    ]).not.toContain(activeRows[0]);
  });

  it('throws the anchor validator reason for an unreachable cycle', () => {
    const anchors = new Map<string, ActiveRowAnchor>([
      ['first', anchor('run-card', 'second', 0)],
      ['second', anchor('run-card', 'first', 0)],
    ]);

    expect(() =>
      resolveLogicalPlacement({
        activeRows: [{ id: 'first' }, { id: 'second' }],
        anchors,
        isCommittedMessage: (id) => id === 'run-card',
        knownRunCardIds: new Set(['run-card']),
        runIdForMessage: (id) =>
          id === 'first' || id === 'second' ? 'run-card' : undefined,
      }),
    ).toThrow('Active row anchor cycle includes');
  });

  it('computes sparse committed and active ranks without allocating the committed transcript', () => {
    const committedCount = 1_000_000_000;
    const lastCommittedOrdinal = committedCount - 1;
    const placement: LogicalPlacement<{ id: string }> = {
      start: [{ id: 'start' }],
      afterCommitted: new Map([
        ['committed-0', [{ id: 'after-0-first' }, { id: 'after-0-second' }]],
        ['committed-100', [{ id: 'after-100' }]],
        ['committed-last', [{ id: 'after-last' }]],
      ]),
      tail: [{ id: 'tail' }],
    };
    const committedOrdinalById = new Map([
      ['committed-0', 0],
      ['committed-100', 100],
      ['committed-last', lastCommittedOrdinal],
    ]);

    const ranks = rankLogicalPlacement(
      placement,
      committedCount,
      committedOrdinalById,
    );

    expect(ranks.bodyCount).toBe(1_000_000_005);
    expect(ranks.activeRankById).toEqual(
      new Map([
        ['start', 0],
        ['after-0-first', 2],
        ['after-0-second', 3],
        ['after-100', 104],
        ['after-last', 1_000_000_004],
        ['tail', 1_000_000_005],
      ]),
    );
    expect(ranks.activeRankById.get('tail')).toBe(ranks.bodyCount);
    expect(ranks.committedRankByOrdinal(0)).toBe(1);
    expect(ranks.committedRankByOrdinal(1)).toBe(4);
    expect(ranks.committedRankByOrdinal(100)).toBe(103);
    expect(ranks.committedRankByOrdinal(101)).toBe(105);
    expect(ranks.committedRankByOrdinal(lastCommittedOrdinal)).toBe(
      1_000_000_003,
    );
    expect(ranks.committedOrdinalByBodyRank(0)).toBeUndefined();
    expect(ranks.committedOrdinalByBodyRank(1)).toBe(0);
    expect(ranks.committedOrdinalByBodyRank(2)).toBeUndefined();
    expect(ranks.committedOrdinalByBodyRank(4)).toBe(1);
    expect(ranks.committedOrdinalByBodyRank(103)).toBe(100);
    expect(ranks.committedOrdinalByBodyRank(104)).toBeUndefined();
    expect(ranks.committedOrdinalByBodyRank(105)).toBe(101);
    expect(ranks.committedOrdinalByBodyRank(1_000_000_003)).toBe(
      lastCommittedOrdinal,
    );
    expect(
      ranks.committedOrdinalByBodyRank(ranks.bodyCount - 1),
    ).toBeUndefined();
    expect(ranks.committedOrdinalByBodyRank(ranks.bodyCount)).toBeUndefined();
    expect(ranks.bodyRankRangeByCommittedOrdinal(0)).toEqual({
      start: 1,
      endExclusive: 4,
    });
    expect(ranks.bodyRankRangeByCommittedOrdinal(100)).toEqual({
      start: 103,
      endExclusive: 105,
    });
    expect(ranks.bodyRankRangeByCommittedOrdinal(lastCommittedOrdinal)).toEqual(
      {
        start: 1_000_000_003,
        endExclusive: 1_000_000_005,
      },
    );
    expect(() => ranks.committedRankByOrdinal(-1)).toThrow(
      'Committed ordinal is out of range: -1',
    );
  });
});
