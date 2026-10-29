import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import {
  BACKFILL_WINDOW_MS,
  extractChatTurns,
  runBackfill,
  type BackfillChatRef,
  type BackfillDeps,
} from '../backfill';
import { FingerprintStore, type TurnFingerprint } from '../fingerprint-store';
import type { SkillSuggestionPartition } from '../partition';
import { SkillSuggestionsRegistry } from '../registry';
import { TimeSlicer } from '../time-slicer';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));
jest.mock('../../agents/work-owner', () => ({
  peekSessionWorkOwner: jest.fn(),
  resolveBackgroundWorkOwner: jest.fn(),
}));
jest.mock('../../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: jest.fn(),
}));

const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 24 * 60 * 60 * 1000;
const PROMPT = 'Summarize the weekly release notes for the mobile app';

function user(
  id: string,
  text: string,
  overrides: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: NOW - DAY,
    ...overrides,
  };
}
function assistantTools(
  names: Array<[string, string]>,
  overrides: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  return {
    id: `a-${Math.random()}`,
    role: 'assistant',
    blocks: names.map(([toolName, input], i) => ({
      type: 'tool_use',
      toolUseId: `t${i}`,
      toolName,
      input,
    })),
    timestamp: NOW - DAY,
    ...overrides,
  };
}
async function* rows(
  messages: PersistedChatMessage[],
): AsyncIterable<PersistedChatMessage> {
  for (const message of messages) {
    await Promise.resolve();
    yield message;
  }
}
function slicer(): TimeSlicer {
  return new TimeSlicer({ yieldToEventLoop: () => Promise.resolve() });
}

/**
 * Mirrors the chat state transcript preview: a consumer that stops before
 * the last row fails the read once it returns.
 */
function strictRead(
  messages: (chatId: string) => PersistedChatMessage[],
): BackfillDeps['readTranscript'] {
  return async <T>(
    ref: { chatId: string },
    consume: (rows: AsyncIterable<PersistedChatMessage>) => Promise<T>,
  ): Promise<T> => {
    let complete = false;
    async function* iterate(): AsyncGenerator<PersistedChatMessage> {
      for (const message of messages(ref.chatId)) {
        await Promise.resolve();
        yield message;
      }
      complete = true;
    }
    const value = await consume(iterate());
    if (!complete) throw new Error('Transcript preview did not complete');
    return value;
  };
}

describe('backfill transcript extraction', () => {
  it('splits human turns and keeps the transcript row id as the turn id', async () => {
    const result = await extractChatTurns(
      rows([
        user('msg-1', `/review ${PROMPT}`),
        assistantTools([
          ['Read', '{}'],
          ['Skill', '{"skill":"push-branch"}'],
        ]),
        assistantTools([['Bash', '{}']], { parentToolUseId: 'sub' }),
        user('steer', 'also check the tests', {
          blocks: [
            { type: 'text', text: 'also', steering: { startsTurn: false } },
          ],
        }),
        user('hidden', 'hidden context', { hidden: true }),
        user('watcher', 'watcher fired', {
          watcherFired: { watcherId: 'w', name: 'w' } as never,
        }),
        user('msg-2', PROMPT),
      ]),
      { cutoff: NOW - BACKFILL_WINDOW_MS, slicer: slicer() },
    );
    expect(result?.automation).toBe(false);
    expect(result?.turns.map((turn) => turn.userMessageId)).toEqual([
      'msg-1',
      'msg-2',
    ]);
    expect(result?.turns[0]?.tools).toEqual([
      'skill:review',
      'Read',
      'skill:push-branch',
    ]);
  });

  it('skips rows older than the window and flags automation chats', async () => {
    const old = await extractChatTurns(
      rows([
        user('old', PROMPT, { timestamp: NOW - 31 * DAY }),
        user('new', PROMPT),
      ]),
      { cutoff: NOW - BACKFILL_WINDOW_MS, slicer: slicer() },
    );
    expect(old?.turns.map((turn) => turn.userMessageId)).toEqual(['new']);
    const automation = await extractChatTurns(
      rows([
        user('a', PROMPT),
        {
          id: 'auto',
          role: 'system',
          blocks: [{ type: 'automation_info', timestamp: NOW }],
          timestamp: NOW - DAY,
        },
      ]),
      { cutoff: NOW - BACKFILL_WINDOW_MS, slicer: slicer() },
    );
    expect(automation).toEqual({ turns: [], automation: true });
  });

  it('stops a chat after the turn cap', async () => {
    const many = Array.from({ length: 205 }, (_, i) => user(`m${i}`, PROMPT));
    const result = await extractChatTurns(rows(many), {
      cutoff: 0,
      slicer: slicer(),
      maxTurns: 200,
    });
    expect(result?.turns).toHaveLength(200);
  });

  it('yields inside a large transcript within its slice budget', async () => {
    let clock = 0;
    const timed = new TimeSlicer({
      budgetMs: 8,
      now: (): number => clock,
      yieldToEventLoop: (): Promise<void> => Promise.resolve(),
    });
    async function* slow(): AsyncIterable<PersistedChatMessage> {
      for (let i = 0; i < 500; i += 1) {
        clock += 1;
        await Promise.resolve();
        yield user(`m${i}`, PROMPT);
      }
    }
    await extractChatTurns(slow(), {
      cutoff: 0,
      slicer: timed,
      maxTurns: 1000,
    });
    expect(timed.yields).toBeGreaterThan(10);
    expect(timed.longestSliceMs).toBeLessThanOrEqual(9);
  });
});

function isChatRef(
  value: BackfillChatRef | undefined,
): value is BackfillChatRef {
  return value !== undefined;
}

describe('backfill run', () => {
  let dir: string;
  let store: FingerprintStore;
  let registry: SkillSuggestionsRegistry;
  const personal: SkillSuggestionPartition = {
    key: 'personal',
    owner: { kind: 'personal' },
    privateWorkspaceId: null,
  };
  const chats: BackfillChatRef[] = [
    { projectId: 'ws', worktreeId: 'wt', chatId: 'c1', lastActivityAt: NOW },
    { projectId: 'gone', worktreeId: 'wt', chatId: 'c2', lastActivityAt: NOW },
    { projectId: 'ws', worktreeId: 'wt', chatId: 'c3', lastActivityAt: NOW },
  ];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'skill-backfill-'));
    store = new FingerprintStore(() => join(dir, 'fp.jsonl'));
    registry = new SkillSuggestionsRegistry(() => join(dir, 'state.json'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<BackfillDeps> = {}): BackfillDeps {
    return {
      store,
      registry,
      slicer: slicer(),
      now: () => NOW,
      isAllowed: () => true,
      listChats: () => Promise.resolve(chats),
      readTranscript: (ref, consume) =>
        consume(rows([user(`${ref.chatId}-m1`, PROMPT)])),
      resolvePartition: (ref) =>
        Promise.resolve(ref.projectId === 'gone' ? null : personal),
      ...overrides,
    };
  }

  it('records turns for existing workspaces with the same ids as live turns', async () => {
    expect(await runBackfill(deps())).toBe('done');
    const recorded = (await store.read()).filter(
      (row): row is TurnFingerprint => row.kind === 'turn',
    );
    expect(recorded.map((row) => [row.chatId, row.userMessageId])).toEqual([
      ['c1', 'c1-m1'],
      ['c3', 'c3-m1'],
    ]);
    expect((await registry.read()).backfill).toEqual({
      done: true,
      nextChatIndex: 0,
    });
    // A live turn with the same message id is not counted again.
    const first = recorded[0];
    if (!first) throw new Error('expected a recorded turn');
    expect(await store.append([{ ...first, status: 'success' }])).toBe(0);
  });

  it('pauses when a session becomes busy and resumes from the cursor', async () => {
    let busy = false;
    const reads: string[] = [];
    const first = await runBackfill(
      deps({
        slicer: new TimeSlicer({
          budgetMs: 0,
          shouldStop: (): boolean => busy,
          yieldToEventLoop: (): Promise<void> => Promise.resolve(),
        }),
        readTranscript: (ref, consume) => {
          reads.push(ref.chatId);
          busy = true;
          return consume(rows([user(`${ref.chatId}-m1`, PROMPT)]));
        },
      }),
    );
    expect(first).toBe('cancelled');
    const cursor = (await registry.read()).backfill;
    expect(cursor.done).toBe(false);
    expect(cursor.chatIdsSnapshot).toHaveLength(3);
    busy = false;
    const listChats = jest.fn(() => Promise.resolve(chats));
    expect(
      await runBackfill(
        deps({
          listChats,
          readTranscript: (ref, consume) => {
            reads.push(ref.chatId);
            return consume(rows([user(`${ref.chatId}-m1`, PROMPT)]));
          },
        }),
      ),
    ).toBe('done');
    expect(listChats).not.toHaveBeenCalled();
    expect(reads).toEqual(['c1', 'c1', 'c3']);
  });

  it('keeps a chat that reaches the turn cap when the reader requires a full read', async () => {
    const many = (chatId: string): PersistedChatMessage[] =>
      Array.from({ length: 205 }, (_, i) =>
        user(`${chatId}-m${i}`, `${PROMPT} number ${i}`),
      );
    expect(
      await runBackfill(
        deps({
          listChats: () => Promise.resolve([chats[0]].filter(isChatRef)),
          readTranscript: strictRead(many),
        }),
      ),
    ).toBe('done');
    const turns = (await store.read()).filter((row) => row.kind === 'turn');
    expect(turns).toHaveLength(200);
  });

  it('resumes a chat a busy session interrupted when the reader requires a full read', async () => {
    let busy = false;
    let reads = 0;
    const rowsFor = (chatId: string): PersistedChatMessage[] => {
      reads += 1;
      // The session turns busy partway through the first chat's transcript.
      if (reads === 1) busy = true;
      return [user(`${chatId}-m1`, PROMPT), user(`${chatId}-m2`, PROMPT)];
    };
    const first = await runBackfill(
      deps({
        slicer: new TimeSlicer({
          budgetMs: 0,
          shouldStop: (): boolean => busy,
          yieldToEventLoop: (): Promise<void> => Promise.resolve(),
        }),
        readTranscript: strictRead(rowsFor),
      }),
    );
    expect(first).toBe('cancelled');
    expect((await registry.read()).backfill.nextChatIndex).toBe(0);
    busy = false;
    expect(
      await runBackfill(deps({ readTranscript: strictRead(rowsFor) })),
    ).toBe('done');
    const recorded = (await store.read())
      .filter((row): row is TurnFingerprint => row.kind === 'turn')
      .map((row) => row.userMessageId);
    expect(recorded).toEqual(['c1-m1', 'c1-m2', 'c3-m1', 'c3-m2']);
  });

  it('does not advance the cursor when the gate closes during the append', async () => {
    let allowed = true;
    const append = store.append.bind(store);
    jest.spyOn(store, 'append').mockImplementation(async (rows) => {
      const written = await append(rows);
      allowed = false;
      return written;
    });
    expect(await runBackfill(deps({ isAllowed: () => allowed }))).toBe(
      'cancelled',
    );
    expect((await registry.read()).backfill.nextChatIndex).toBe(0);
  });

  it('discards work when the gate closes', async () => {
    let allowed = true;
    const result = await runBackfill(
      deps({
        isAllowed: () => allowed,
        readTranscript: (ref, consume) => {
          allowed = false;
          return consume(rows([user(`${ref.chatId}-m1`, PROMPT)]));
        },
      }),
    );
    expect(result).toBe('cancelled');
    expect(await store.read()).toEqual([]);
  });
});
