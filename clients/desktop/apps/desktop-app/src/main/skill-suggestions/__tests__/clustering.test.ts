import {
  chainEndsWith,
  collapseRepeats,
  findChainCandidates,
  findPromptCandidates,
  isSingleSkillTurn,
} from '../clustering';
import {
  turnMatchId,
  type ChatChainFingerprint,
  type TurnFingerprint,
} from '../fingerprint-store';
import { normalizePromptTokens } from '../normalize';
import { TimeSlicer } from '../time-slicer';

let seq = 0;
function turn(
  text: string,
  chatId: string,
  day: string,
  tools: string[] = [],
): TurnFingerprint {
  seq += 1;
  return {
    kind: 'turn',
    projectId: 'ws',
    worktreeId: 'wt',
    chatId,
    userMessageId: `m-${seq}`,
    partition: 'personal',
    createdAt: seq,
    day,
    excerpt: text,
    tokens: normalizePromptTokens(text),
    tools,
    status: 'success',
  };
}

function chain(
  chatId: string,
  day: string,
  skills: string[],
): ChatChainFingerprint {
  seq += 1;
  return {
    kind: 'chat_chain',
    projectId: 'ws',
    worktreeId: 'wt',
    chatId,
    partition: 'personal',
    skills,
    lastActivityAt: seq,
    day,
  };
}

const repeated = [
  turn(
    'Summarize the weekly release notes for the mobile app',
    'a',
    '2026-10-01',
  ),
  turn('Summarize weekly release notes for the desktop app', 'b', '2026-10-02'),
  turn(
    'Please summarize this week release notes for the web app',
    'c',
    '2026-10-03',
  ),
];
const noise = [
  turn(
    'Refactor the payment retry logic in the billing service',
    'd',
    '2026-10-01',
  ),
  turn('Write a haiku about autumn leaves falling', 'e', '2026-10-02'),
];

describe('skill suggestion clustering', () => {
  it('groups similar prompts across chats and days', async () => {
    const candidates = await findPromptCandidates([...repeated, ...noise]);
    expect(candidates).toHaveLength(1);
    expect(candidates?.[0]?.members.map((row) => row.chatId).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('still finds a task repeated in more than a fifth of all requests', async () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) =>
        turn(
          `Summarize standup notes from the platform team meeting ${i}`,
          `s${i}`,
          `2026-10-0${(i % 3) + 1}`,
        ),
      ),
      ...Array.from({ length: 9 }, (_, i) =>
        turn(
          `Unrelated request ${i} about ${['billing', 'oauth', 'webhooks'][i % 3]} retries`,
          `x${i}`,
          '2026-10-04',
        ),
      ),
    ];
    const candidates = await findPromptCandidates(rows);
    expect(candidates?.map((candidate) => candidate.members.length)).toEqual([
      6,
    ]);
  });

  it('needs the shared content tokens live matching needs', async () => {
    // Short skill prompts score high but share one content token, so live
    // matching could never surface a suggestion built from them.
    const rows = ['2026-10-01', '2026-10-02', '2026-10-03'].map((day, i) =>
      turn('/review staging', `c${i}`, day, ['skill:review', 'Bash']),
    );
    expect(await findPromptCandidates(rows)).toEqual([]);
  });

  it('requires three members on two chats and two days', async () => {
    const sameChat = repeated.map((row) => ({ ...row, chatId: 'same' }));
    expect(await findPromptCandidates(sameChat)).toEqual([]);
    const sameDay = repeated.map((row) => ({ ...row, day: '2026-10-01' }));
    expect(await findPromptCandidates(sameDay)).toEqual([]);
    expect(await findPromptCandidates(repeated.slice(0, 2))).toEqual([]);
  });

  it('skips turns an open suggestion already counts', async () => {
    const first = repeated[0];
    if (!first) throw new Error('expected a seeded turn');
    const exclude = new Set([turnMatchId(first)]);
    expect(
      await findPromptCandidates(repeated, { excludeTurnIds: exclude }),
    ).toEqual([]);
  });

  it('ignores turns whose only action is one skill', async () => {
    const skillOnly = [
      turn('/review', 'a', '2026-10-01', ['skill:review']),
      turn('/review', 'b', '2026-10-02', ['skill:review']),
      turn('/review', 'c', '2026-10-03', ['skill:review']),
    ];
    expect(skillOnly.every(isSingleSkillTurn)).toBe(true);
    expect(await findPromptCandidates(skillOnly)).toEqual([]);
  });

  it('stops when the slicer is stopped', async () => {
    const slicer = new TimeSlicer({ shouldStop: (): boolean => true });
    expect(await findPromptCandidates(repeated, { slicer })).toBeNull();
  });

  it('stays within its slice budget on a large input', async () => {
    let clock = 0;
    const rows = Array.from({ length: 400 }, (_, i) =>
      turn(
        `unique request number ${i} about topic ${i % 7}`,
        `c${i}`,
        '2026-10-01',
      ),
    );
    const slicer = new TimeSlicer({
      budgetMs: 8,
      now: (): number => clock,
      yieldToEventLoop: (): Promise<void> => Promise.resolve(),
    });
    const original = slicer.tick.bind(slicer);
    slicer.tick = (): Promise<boolean> => {
      clock += 1;
      return original();
    };
    await findPromptCandidates(rows, { slicer });
    expect(slicer.yields).toBeGreaterThan(0);
    expect(slicer.longestSliceMs).toBeLessThanOrEqual(9);
  });

  it('collapses consecutive repeats and finds the longest chain', () => {
    expect(collapseRepeats(['a', 'a', 'b', 'b', 'a'])).toEqual(['a', 'b', 'a']);
    const chains = [
      chain('a', '2026-10-01', ['review', 'review', 'push-branch', 'open-pr']),
      chain('b', '2026-10-02', ['review', 'push-branch', 'open-pr']),
      chain('c', '2026-10-02', ['lint', 'review', 'push-branch', 'open-pr']),
    ];
    const candidates = findChainCandidates(chains);
    expect(candidates.map((entry) => entry.skills)).toEqual([
      ['review', 'push-branch', 'open-pr'],
    ]);
  });

  it('requires three chats on two days for a chain', () => {
    const sameDay = [
      chain('a', '2026-10-01', ['x', 'y']),
      chain('b', '2026-10-01', ['x', 'y']),
      chain('c', '2026-10-01', ['x', 'y']),
    ];
    expect(findChainCandidates(sameDay)).toEqual([]);
    const twoChats = [
      chain('a', '2026-10-01', ['x', 'y']),
      chain('b', '2026-10-02', ['x', 'y']),
    ];
    expect(findChainCandidates(twoChats)).toEqual([]);
  });

  it('drops chains an existing suggestion already proposes', () => {
    const chains = [
      chain('a', '2026-10-01', ['x', 'y']),
      chain('b', '2026-10-02', ['x', 'y']),
      chain('c', '2026-10-03', ['x', 'y']),
    ];
    expect(
      findChainCandidates(chains, { existingChains: [['x', 'y']] }),
    ).toEqual([]);
  });

  it('matches a chat chain suffix', () => {
    expect(chainEndsWith(['a', 'x', 'x', 'y'], ['x', 'y'])).toBe(true);
    expect(chainEndsWith(['x', 'y', 'a'], ['x', 'y'])).toBe(false);
    expect(chainEndsWith(['y'], ['x', 'y'])).toBe(false);
  });
});
