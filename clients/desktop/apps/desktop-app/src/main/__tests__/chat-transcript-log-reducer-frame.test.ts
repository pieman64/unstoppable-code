import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as transcriptValidation from '../lib/persisted-chat-message-validation';
import { delegationTranscriptMessages } from '@canopy/agent-transcript';
import {
  applyClaudeTranscriptEvent,
  createEmptyTranscriptReducerState,
} from '@canopy/agent-transcript/lib/transcript-parser';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { TRANSCRIPT_PAGE_SIZE } from '@canopy/agent-transcript/transcript-storage';
import type { AgentDelegationTranscript } from '@canopy/protocol/delegation';
import { ChatTranscriptLog } from '../lib/chat-transcript-log';
import { isRecord } from '../lib/type-guards';

interface FrameReference {
  id: string;
  ordinal: number;
  offset: number;
}

interface ToolUseFrame {
  row: FrameReference;
  toolUseIds: string[];
  resultWitnesses: Array<{ toolUseId: string; row: FrameReference }>;
}

interface FrameShape {
  version: number;
  boundary?: FrameReference;
  timers: FrameReference[];
  cards: Array<{ row: FrameReference; carriesToolUses: boolean }>;
  toolUses: ToolUseFrame[];
  pendingResults: Array<{ toolUseId: string; row: FrameReference }>;
}

function message(
  id: string,
  role: PersistedChatMessage['role'] = 'assistant',
  blocks: PersistedChatMessage['blocks'] = [
    { type: 'text', text: `message ${id}` },
  ],
): PersistedChatMessage {
  return { id, role, timestamp: 1, blocks };
}

function userBoundary(id: string): PersistedChatMessage {
  return message(id, 'user');
}

function watcherPrompt(id: string): PersistedChatMessage {
  return message(id, 'user', [
    {
      type: 'text',
      text: 'watcher prompt',
      asyncQuestionAnswer: {
        requestId: 'watcher-question',
        startsTurn: false,
        answers: [],
      },
    },
  ]);
}

function timer(id: string): PersistedChatMessage {
  return message(id, 'system', [
    { type: 'turn_timer', startedAt: 1, completedAt: null },
  ]);
}

function codexCard(id: string): PersistedChatMessage {
  return message(id, 'assistant', [
    {
      type: 'codex_agent_call',
      agentBlockId: `codex-agent-${id}`,
      callId: id,
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: 'root-thread',
      receiverThreadIds: ['child-thread'],
      prompt: 'test task',
      agentsStates: { 'child-thread': { status: 'running' } },
    },
  ]);
}

function delegatedCard(id: string): PersistedChatMessage {
  const event: AgentDelegationTranscript = {
    delegationId: id,
    runGeneration: 1,
    sequence: 1,
    parentHarnessId: 'parent-harness',
    parentTurnId: 'parent-turn',
    parentToolCallId: 'parent-tool-call',
    createdAt: 1,
    task: {
      description: 'test delegation',
      prompt: 'test delegation prompt',
      executionMode: 'background',
    },
    snapshot: {
      delegationId: id,
      status: 'running',
      outputTruncated: false,
      routeSnapshot: {
        selectedModelId: 'model',
        runtimeModelId: 'model',
        harnessId: 'claude',
        runtimeKind: 'sdk',
        runnerRegistrationId: 'claude-runner',
        runtimeVersion: '1',
        adapterVersion: '1',
        modelSource: 'agent',
        providerType: 'anthropic',
        assignmentRevision: '1',
        billingAuthority: 'local',
        aiCreditsRouted: false,
        capabilities: [],
        supportedThinkingLevels: [],
        capabilitySnapshotHash: 'hash',
        capabilityGeneration: 1,
        policyRevision: '1',
      },
    },
    transcript: [],
  };
  const card = delegationTranscriptMessages(event)[0];
  if (!card) throw new Error('Expected a delegated agent card');
  return card;
}

function toolUse(
  id: string,
  toolUseIds: readonly string[],
  toolName = 'Bash',
): PersistedChatMessage {
  return message(
    id,
    'assistant',
    toolUseIds.map((toolUseId) => ({
      type: 'tool_use' as const,
      toolUseId,
      toolName,
      input: '{}',
    })),
  );
}

function toolResult(
  id: string,
  toolUseIds: readonly string[],
): PersistedChatMessage {
  return message(
    id,
    'system',
    toolUseIds.map((toolUseId) => ({
      type: 'tool_result' as const,
      toolUseId,
      toolName: 'Bash',
      output: 'done',
      isError: false,
    })),
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${label} to be an object`);
  return value;
}

function frameFromIndex(value: unknown): FrameShape {
  const index = record(value, 'sparse index');
  const frame = record(index.reducerFrame, 'reducer frame');
  if (
    typeof frame.version !== 'number' ||
    !Array.isArray(frame.timers) ||
    !Array.isArray(frame.cards) ||
    !Array.isArray(frame.toolUses) ||
    !Array.isArray(frame.pendingResults)
  )
    throw new Error('Invalid test reducer frame shape');
  return frame as unknown as FrameShape;
}

async function readIndex(root: string, chatId = 'chat-1'): Promise<unknown> {
  return JSON.parse(await readFile(join(root, `${chatId}.index.json`), 'utf8'));
}

async function readFrame(root: string, chatId = 'chat-1'): Promise<FrameShape> {
  return frameFromIndex(await readIndex(root, chatId));
}

async function pageWithReducerFrame(
  log: ChatTranscriptLog,
  chatId = 'chat-1',
): Promise<{ messages: PersistedChatMessage[]; result: unknown }> {
  const method: unknown = Reflect.get(log, 'pageWithActiveMessages');
  if (typeof method !== 'function')
    throw new Error('Missing pageWithActiveMessages');
  const result: unknown = await Reflect.apply(method, log, [
    chatId,
    undefined,
    { reducerFrame: true },
  ]);
  const page = record(record(result, 'page result').page, 'transcript page');
  if (!Array.isArray(page.messages))
    throw new Error('Invalid transcript page messages');
  return {
    messages: page.messages as PersistedChatMessage[],
    result,
  };
}

function refsInFrame(frame: FrameShape): FrameReference[] {
  const refs = new Map<number, FrameReference>();
  const add = (value: unknown): void => {
    const reference = record(value, 'frame reference');
    if (
      typeof reference.id !== 'string' ||
      typeof reference.ordinal !== 'number' ||
      typeof reference.offset !== 'number'
    )
      throw new Error('Invalid frame reference');
    refs.set(reference.ordinal, {
      id: reference.id,
      ordinal: reference.ordinal,
      offset: reference.offset,
    });
  };
  if (frame.boundary) add(frame.boundary);
  frame.timers.forEach(add);
  for (const card of frame.cards) add(card.row);
  for (const tool of frame.toolUses) {
    add(tool.row);
    tool.resultWitnesses.forEach((witness) => add(witness.row));
  }
  frame.pendingResults.forEach((witness) => add(witness.row));
  return Array.from(refs.values());
}

async function rewriteIndex(
  root: string,
  edit: (index: Record<string, unknown>) => void,
): Promise<void> {
  const index = record(await readIndex(root), 'sparse index');
  delete index.checksum;
  edit(index);
  index.checksum = createHash('sha256')
    .update(JSON.stringify(index))
    .digest('hex');
  await writeFile(join(root, 'chat-1.index.json'), JSON.stringify(index));
}

describe('sparse transcript reducer frame', () => {
  let root: string;
  let log: ChatTranscriptLog;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'chat-reducer-frame-'));
    log = new ChatTranscriptLog(root);
    await log.initialize('chat-1');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('folds only the current user-boundary frame and keeps settled tool-result witnesses', async () => {
    const rows = [
      userBoundary('old-boundary'),
      timer('old-timer'),
      codexCard('old-card'),
      toolUse('old-task-use', ['old-task-use-id'], 'Task'),
      toolResult('old-task-result', ['old-task-use-id']),
      watcherPrompt('watcher-not-a-boundary'),
      userBoundary('current-boundary'),
      timer('current-timer'),
      codexCard('current-card'),
      toolUse('current-agent-use', ['current-agent-use-id'], 'Agent'),
      toolResult('current-agent-result', ['current-agent-use-id']),
    ];
    await log.append('chat-1', rows);

    const frame = await readFrame(root);
    expect(frame.version).toBe(1);
    expect(frame.boundary).toMatchObject({
      id: 'current-boundary',
      ordinal: 6,
    });
    // The latest timer before the boundary rides along for wake timers.
    expect(frame.timers.map((reference) => reference.id)).toEqual([
      'old-timer',
      'current-timer',
    ]);
    expect(frame.cards.map(({ row }) => row.id)).toEqual([
      'current-card',
      'current-agent-use',
    ]);
    expect(frame.toolUses).toMatchObject([
      {
        row: { id: 'current-agent-use' },
        toolUseIds: ['current-agent-use-id'],
        resultWitnesses: [
          {
            toolUseId: 'current-agent-use-id',
            row: { id: 'current-agent-result' },
          },
        ],
      },
    ]);
    const descriptor = await log.descriptor('chat-1');
    expect(descriptor).not.toHaveProperty('reducerFrame');

    // A restarted reader trusts the index, carried timer included.
    const validation = jest.spyOn(
      transcriptValidation,
      'isPersistedChatMessage',
    );
    expect(await new ChatTranscriptLog(root).descriptor('chat-1')).toEqual(
      descriptor,
    );
    expect(validation).not.toHaveBeenCalled();
  });

  it.each(['valid', 'missing', 'stale', 'malformed'])(
    'writes byte-identical active indexes after loading a %s frame',
    async (condition) => {
      const rows = [userBoundary('boundary'), timer('timer')];
      await log.append('chat-1', rows);
      await log.initialize('chat-2');
      await log.append('chat-2', rows);
      const locators = join(root, 'message-index', 'chat-1');
      const before = await stat(locators);
      await rewriteIndex(root, (index) => {
        const frame = index.reducerFrame;
        delete index.reducerFrame;
        // An earlier build moved even valid frames behind the metadata.
        if (condition === 'valid') index.reducerFrame = frame;
        else if (condition === 'stale')
          index.reducerFrame = { ...record(frame, 'frame'), messageCount: 0 };
        else if (condition === 'malformed') index.reducerFrame = null;
      });
      const active = [message('active')];
      await log.writeActive('chat-2', active);
      await new ChatTranscriptLog(root).writeActive('chat-1', active);

      const actual = record(await readIndex(root), 'sparse index');
      expect(actual).toEqual(await readIndex(root, 'chat-2'));
      const keys = Object.keys(actual);
      expect(keys.indexOf('reducerFrame')).toBe(keys.indexOf('offsets') + 1);
      expect(await readFile(join(root, 'chat-1.index.json'), 'utf8')).toBe(
        await readFile(join(root, 'chat-2.index.json'), 'utf8'),
      );
      expect((await stat(locators)).ino).toBe(before.ino);
    },
  );

  it('rebuilds a missing or malformed optional frame once and validates reference ranges', async () => {
    const rows = [
      userBoundary('boundary'),
      timer('timer'),
      codexCard('card'),
      toolUse('use', ['tool-use-id']),
      toolResult('result', ['tool-use-id']),
    ];
    await log.append('chat-1', rows);
    const expected = await readFrame(root);
    const before = await log.descriptor('chat-1');

    await rewriteIndex(root, (index) => {
      delete index.reducerFrame;
    });
    const missingFieldLog = new ChatTranscriptLog(root);
    const validation = jest.spyOn(
      transcriptValidation,
      'isPersistedChatMessage',
    );
    // An index from before the frame keeps its revision; only the frame is
    // folded, not the whole index and its locators.
    expect(await missingFieldLog.descriptor('chat-1')).toEqual(before);
    expect(validation).toHaveBeenCalledTimes(rows.length);
    expect(await readFrame(root)).toEqual(expected);
    validation.mockClear();
    await missingFieldLog.append('chat-1', [message('after-frame-rebuild')]);
    // The newly appended row is validated; no historical rows are revisited.
    expect(validation).toHaveBeenCalledTimes(1);
    validation.mockRestore();

    const beforeMalformed = await missingFieldLog.descriptor('chat-1');
    await rewriteIndex(root, (index) => {
      const frame = record(index.reducerFrame, 'reducer frame');
      const boundary = record(frame.boundary, 'boundary');
      boundary.ordinal = 99_999;
    });
    const malformedFieldLog = new ChatTranscriptLog(root);
    // A malformed frame is folded again; the index keeps its revision.
    expect(await malformedFieldLog.descriptor('chat-1')).toEqual(
      beforeMalformed,
    );
    expect(await readFrame(root)).toEqual({
      ...expected,
      messageCount: rows.length + 1,
    });
  });

  it('rebuilds a frame that an earlier build left behind on append', async () => {
    await log.append('chat-1', [userBoundary('old-boundary'), timer('old')]);
    const stale = record(await readIndex(root), 'sparse index').reducerFrame;
    await log.append('chat-1', [userBoundary('new-boundary'), timer('new')]);
    const before = await log.descriptor('chat-1');
    // An earlier build appends rows without folding them into the frame.
    await rewriteIndex(root, (index) => {
      index.reducerFrame = stale;
    });

    // Only the frame is folded again; the index keeps its revision.
    expect(await new ChatTranscriptLog(root).descriptor('chat-1')).toEqual(
      before,
    );
    const frame = await readFrame(root);
    expect(frame.boundary?.id).toBe('new-boundary');
    expect(frame.timers.map((reference) => reference.id)).toEqual([
      'old',
      'new',
    ]);
  });

  it('folds replacements and a later JSONL rebuild identically', async () => {
    const prefix = [userBoundary('prefix-boundary'), timer('prefix-timer')];
    await log.replace(
      'chat-1',
      [...prefix, codexCard('prefix-card'), message('old-suffix')],
      1,
    );
    const replacement = [
      ...prefix,
      userBoundary('replacement-boundary'),
      toolUse('replacement-agent', ['replacement-id'], 'Agent'),
      toolResult('replacement-result', ['replacement-id']),
    ];
    await log.replace('chat-1', replacement, 2);
    const afterReplacement = await readFrame(root);
    expect(afterReplacement.boundary?.id).toBe('replacement-boundary');
    expect(afterReplacement.timers.map((reference) => reference.id)).toEqual([
      'prefix-timer',
    ]);

    await rm(join(root, 'chat-1.index.json'), { force: true });
    await new ChatTranscriptLog(root).descriptor('chat-1');
    expect(await readFrame(root)).toEqual(afterReplacement);
  });

  // Hundreds of real locator writes plus cold frame reads exceed Jest's 5 s
  // default on shared hosts; this is correctness coverage, not a timing budget.
  it('keeps tool-result witnesses for every tool in a retained multi-use row', async () => {
    const rows = [
      userBoundary('boundary'),
      ...Array.from({ length: 70 }, (_, index) => [
        toolUse(`settled-use-${index}`, [`settled-${index}`]),
        toolResult(`settled-result-${index}`, [`settled-${index}`]),
      ]).flat(),
      toolUse('question-row', ['question-a', 'question-b'], 'Task'),
      toolResult('question-result-a', ['question-a']),
      toolResult('question-result-b', ['question-b']),
      ...Array.from({ length: TRANSCRIPT_PAGE_SIZE * 2 }, (_, index) =>
        message(`tail-${index}`),
      ),
    ];
    await log.append('chat-1', rows);

    const firstRead = await pageWithReducerFrame(log);
    const ids = new Set(firstRead.messages.map((entry) => entry.id));
    expect(ids).toContain('question-row');
    expect(ids).toContain('question-result-a');
    expect(ids).toContain('question-result-b');
    expect(ids).toContain('boundary');
    expect(ids).toContain('question-row');

    for (const result of [
      firstRead,
      await pageWithReducerFrame(new ChatTranscriptLog(root)),
    ]) {
      const repaired = applyClaudeTranscriptEvent(
        {
          ...createEmptyTranscriptReducerState(),
          messages: result.messages,
          status: 'streaming',
        },
        { type: 'result' },
        {
          now: 999_999,
          createMessageId: () => 'repair-result',
          childToolLiveness: { kind: 'unknown' },
        },
      );
      const cancelledResults = repaired.messages.flatMap((entry) =>
        entry.blocks.filter(
          (block) =>
            block.type === 'tool_result' && block.output === 'Cancelled',
        ),
      );
      expect(cancelledResults).toEqual([]);
    }
  }, 30_000);

  it('retains newest context at each explicit frame cap', async () => {
    const rows: PersistedChatMessage[] = [userBoundary('cap-boundary')];
    for (let index = 0; index < 20; index += 1)
      rows.push(timer(`cap-timer-${index}`));
    for (let index = 0; index < 40; index += 1)
      rows.push(codexCard(`cap-card-${index}`));
    for (let index = 0; index < 70; index += 1) {
      rows.push(toolUse(`cap-use-${index}`, [`cap-tool-${index}`]));
      rows.push(toolResult(`cap-use-result-${index}`, [`cap-tool-${index}`]));
    }
    for (let index = 0; index < 530; index += 1)
      rows.push(toolResult(`cap-pending-result-${index}`, [`orphan-${index}`]));
    await log.append('chat-1', rows);

    const frame = await readFrame(root);
    expect(frame.timers).toHaveLength(16);
    expect(frame.timers[0]?.id).toBe('cap-timer-4');
    expect(frame.timers.at(-1)?.id).toBe('cap-timer-19');
    expect(frame.cards).toHaveLength(32);
    expect(frame.cards[0]?.row.id).toBe('cap-card-8');
    expect(frame.cards.at(-1)?.row.id).toBe('cap-card-39');
    expect(frame.toolUses).toHaveLength(64);
    expect(frame.toolUses[0]?.row.id).toBe('cap-use-6');
    expect(frame.toolUses.at(-1)?.row.id).toBe('cap-use-69');
    expect(
      frame.toolUses.reduce((count, row) => count + row.toolUseIds.length, 0),
    ).toBeLessThanOrEqual(512);
    expect(
      frame.toolUses.every((row) =>
        row.toolUseIds.every((toolUseId) =>
          row.resultWitnesses.some(
            (witness) => witness.toolUseId === toolUseId,
          ),
        ),
      ),
    ).toBe(true);
    expect(frame.pendingResults).toHaveLength(512);
    expect(frame.pendingResults[0]?.toolUseId).toBe('orphan-18');
    expect(frame.pendingResults.at(-1)?.toolUseId).toBe('orphan-529');
  });

  it('bounds parsed rows by the page, frame cap and fixed sparse seek overhead after rebuild', async () => {
    const scenarios = [
      { historyTurns: 2, questionCount: 4, currentRows: 80 },
      { historyTurns: 90, questionCount: 180, currentRows: 520 },
    ];
    const parsedCounts: number[] = [];

    for (
      let scenarioIndex = 0;
      scenarioIndex < scenarios.length;
      scenarioIndex += 1
    ) {
      const scenario = scenarios[scenarioIndex];
      const scenarioRoot = await mkdtemp(join(tmpdir(), 'chat-frame-read-'));
      try {
        const scenarioLog = new ChatTranscriptLog(scenarioRoot);
        await scenarioLog.initialize('chat-1');
        const rows: PersistedChatMessage[] = [];
        for (let turn = 0; turn < scenario.historyTurns; turn += 1) {
          rows.push(userBoundary(`history-user-${turn}`));
          rows.push(message(`history-assistant-${turn}`));
        }
        rows.push(userBoundary('read-boundary'));
        rows.push(timer('read-timer'));
        rows.push(codexCard('read-card'));
        for (
          let question = 0;
          question < scenario.questionCount;
          question += 1
        ) {
          const id = `read-question-${question}`;
          rows.push(toolUse(`read-use-row-${question}`, [id], 'Task'));
          rows.push(toolResult(`read-result-row-${question}`, [id]));
        }
        for (let index = 0; index < scenario.currentRows; index += 1)
          rows.push(message(`current-noise-${index}`));
        await scenarioLog.append('chat-1', rows);

        // Simulate an old V3 index, then make its one required load-time rebuild.
        await rewriteIndex(scenarioRoot, (index) => {
          delete index.reducerFrame;
        });
        await new ChatTranscriptLog(scenarioRoot).descriptor('chat-1');
        const frame = await readFrame(scenarioRoot);
        const frameReferenceCount = refsInFrame(frame).length;

        const validation = jest.spyOn(
          transcriptValidation,
          'isPersistedChatMessage',
        );
        const actualValidation = validation.getMockImplementation();
        if (actualValidation === undefined)
          throw new Error('Missing transcript validation implementation');
        validation.mockImplementation((value: unknown) =>
          actualValidation(value),
        );
        const measuredLog = new ChatTranscriptLog(scenarioRoot);
        try {
          const measured = await pageWithReducerFrame(measuredLog);
          expect(measured.messages).toEqual(
            expect.arrayContaining([rows[scenario.historyTurns * 2]]),
          );
          parsedCounts.push(validation.mock.calls.length);
          expect(validation.mock.calls.length).toBeLessThanOrEqual(
            TRANSCRIPT_PAGE_SIZE +
              TRANSCRIPT_PAGE_SIZE +
              frameReferenceCount +
              2,
          );
          expect(validation.mock.calls.length).toBeGreaterThan(0);
          validation.mockClear();
          await measuredLog.append('chat-1', [message('after-bounded-read')]);
          expect(validation).toHaveBeenCalledTimes(1);
        } finally {
          validation.mockRestore();
        }
      } finally {
        await rm(scenarioRoot, { recursive: true, force: true });
      }
      if (scenarioIndex > 0)
        expect(parsedCounts[scenarioIndex]).toBeLessThanOrEqual(
          TRANSCRIPT_PAGE_SIZE * 2 + 160 + 2,
        );
    }
  }, 60_000);

  it('includes active frame rows displaced by anchored children in logical order', async () => {
    const committed = [
      userBoundary('committed-boundary'),
      ...Array.from({ length: TRANSCRIPT_PAGE_SIZE + 12 }, (_, index) =>
        message(`committed-${index}`),
      ),
    ];
    await log.append('chat-1', committed);
    const card = delegatedCard('active-card');
    const activeRows = [
      { ...timer('active-timer'), parentBlockId: card.id },
      card,
      { ...message('active-child'), parentBlockId: card.id },
      ...Array.from({ length: TRANSCRIPT_PAGE_SIZE + 10 }, (_, index) => ({
        ...message(`active-tail-${index}`),
        parentBlockId: card.id,
      })),
    ];
    const anchors = new Map(
      activeRows.map((entry, index) => [
        entry.id,
        {
          version: 1 as const,
          runId: card.id,
          after: entry.id === card.id ? 'committed-boundary' : card.id,
          tie: index,
        },
      ]),
    );
    await log.writeActive('chat-1', activeRows, anchors);

    const { messages } = await pageWithReducerFrame(log);
    const ids = messages.map((entry) => entry.id);
    expect(ids).toContain('active-timer');
    expect(ids).toContain(card.id);
    expect(ids).toContain('committed-boundary');
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.indexOf('active-timer')).toBeLessThan(
      ids.indexOf('committed-12'),
    );
    expect(ids.indexOf(card.id)).toBeLessThan(ids.indexOf('committed-12'));
  });

  it('lets a later active boundary reset committed and displaced active frame rows', async () => {
    await log.append('chat-1', [
      userBoundary('old-boundary'),
      timer('old-timer'),
      codexCard('old-card'),
      ...Array.from({ length: TRANSCRIPT_PAGE_SIZE + 12 }, (_, index) =>
        message(`committed-${index}`),
      ),
    ]);
    const card = delegatedCard('prior-active-card');
    const activeBoundary = userBoundary('active-boundary');
    const activeRows = [
      card,
      { ...timer('prior-active-timer'), parentBlockId: card.id },
      { ...message('active-child'), parentBlockId: card.id },
      ...Array.from({ length: TRANSCRIPT_PAGE_SIZE + 10 }, (_, index) => ({
        ...message(`active-tail-${index}`),
        parentBlockId: card.id,
      })),
      activeBoundary,
    ];
    const anchors = new Map(
      activeRows
        .filter((entry) => entry.id !== activeBoundary.id)
        .map((entry, index) => [
          entry.id,
          {
            version: 1 as const,
            runId: card.id,
            after: entry.id === card.id ? 'old-boundary' : card.id,
            tie: index,
          },
        ]),
    );
    await log.writeActive('chat-1', activeRows, anchors);

    const { messages } = await pageWithReducerFrame(log);
    const ids = messages.map((entry) => entry.id);
    expect(ids).toContain('active-boundary');
    expect(ids).not.toContain('old-boundary');
    // Only the latest earlier timer crosses the active boundary, as in a
    // full read; the committed frame's other rows do not.
    expect(ids).toContain('old-timer');
    expect(ids).not.toContain('old-card');
    expect(ids).not.toContain(card.id);
    expect(ids).not.toContain('prior-active-timer');
  });
});
