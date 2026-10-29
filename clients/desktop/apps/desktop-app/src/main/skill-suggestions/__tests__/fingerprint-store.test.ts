import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compactRows,
  FINGERPRINT_TURN_ROW_CAP,
  FingerprintStore,
  localDay,
  parseFingerprintLines,
  type ChatChainFingerprint,
  type TurnFingerprint,
} from '../fingerprint-store';
import {
  SKILL_SUGGESTION_DRAFT_PROMPT_LEAD,
  skillSuggestionChainDraftLead,
} from '@canopy/desktop-shared/lib/skill-suggestions';
import { buildTurnFingerprint, ChatChainCache } from '../recording';

jest.mock('../../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 16, 12);

function turn(overrides: Partial<TurnFingerprint> = {}): TurnFingerprint {
  return {
    kind: 'turn',
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    userMessageId: 'msg-1',
    partition: 'personal',
    createdAt: NOW,
    day: localDay(NOW),
    excerpt: 'Summarize the release notes',
    tokens: ['notes', 'release', 'summarize'],
    tools: [],
    status: 'success',
    ...overrides,
  };
}

function chain(
  overrides: Partial<ChatChainFingerprint> = {},
): ChatChainFingerprint {
  return {
    kind: 'chat_chain',
    projectId: 'ws-1',
    worktreeId: 'wt-1',
    chatId: 'chat-1',
    partition: 'personal',
    skills: ['review'],
    lastActivityAt: NOW,
    day: localDay(NOW),
    ...overrides,
  };
}

let dir: string;
let path: string;
let store: FingerprintStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-fingerprints-'));
  path = join(dir, 'derived', 'skill-suggestions', 'fingerprints.jsonl');
  store = new FingerprintStore(() => path);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('skill suggestion fingerprint store', () => {
  it('appends and de-duplicates turn rows on chat and message id', async () => {
    expect(await store.append([turn(), turn()])).toBe(1);
    expect(await store.append([turn({ excerpt: 'changed' })])).toBe(0);
    expect(await store.append([turn({ userMessageId: 'msg-2' })])).toBe(1);
    const fresh = new FingerprintStore(() => path);
    expect(await fresh.append([turn()])).toBe(0);
    expect(await store.read()).toHaveLength(2);
  });

  it('records a turn again after a failed append', async () => {
    await store.append([turn({ userMessageId: 'warm' })]);
    // A directory where the file should be makes only the append fail.
    await rm(path);
    await mkdir(path);
    await expect(store.append([turn()])).rejects.toThrow();
    await rm(path, { recursive: true });
    expect(await store.append([turn()])).toBe(1);
  });

  it('keeps the latest chain row per chat', async () => {
    await store.append([chain({ skills: ['review'] })]);
    await store.append([chain({ skills: ['review', 'push-branch'] })]);
    const rows = await store.read();
    expect(rows).toEqual([chain({ skills: ['review', 'push-branch'] })]);
  });

  it('redacts secret-shaped excerpts before writing', async () => {
    const secret = 'sk-ant-api03-' + 'a'.repeat(90);
    await store.append([turn({ excerpt: `deploy with ${secret}` })]);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(secret);
  });

  it('derives tokens from the redacted prompt, not the raw one', () => {
    const secret = 'sk-ant-api03-' + 'a'.repeat(90);
    const row = buildTurnFingerprint(
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        userMessageId: 'msg-1',
        promptText: `Deploy the staging release with key ${secret} today`,
        tools: [],
        createdAt: NOW,
        status: 'success',
      },
      {
        key: 'personal',
        owner: { kind: 'personal' },
        privateWorkspaceId: null,
      },
    );
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain('a'.repeat(20));
  });

  it('never records a sent skill-suggestion drafting prompt', () => {
    const base = {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      chatId: 'chat-1',
      userMessageId: 'msg-1',
      tools: [],
      createdAt: NOW,
      status: 'success',
    };
    const personal = {
      key: 'personal',
      owner: { kind: 'personal' as const },
      privateWorkspaceId: null,
    };
    expect(
      buildTurnFingerprint(
        {
          ...base,
          promptText: `${SKILL_SUGGESTION_DRAFT_PROMPT_LEAD}\n\nTask: Weekly sales report`,
        },
        personal,
      ),
    ).toBeNull();
    expect(
      buildTurnFingerprint(
        {
          ...base,
          promptText: `${skillSuggestionChainDraftLead(['review', 'push-branch'])}\nDraft one SKILL.md`,
        },
        personal,
      ),
    ).toBeNull();
  });

  it('redacts a secret that crosses the excerpt cap', () => {
    const filler = 'deploy staging release notes '.repeat(40).slice(0, 984);
    const row = buildTurnFingerprint(
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        chatId: 'chat-1',
        userMessageId: 'msg-1',
        promptText: `${filler} ghp_${'B'.repeat(36)} done`,
        tools: [],
        createdAt: NOW,
        status: 'success',
      },
      {
        key: 'personal',
        owner: { kind: 'personal' },
        privateWorkspaceId: null,
      },
    );
    expect(row?.excerpt.length).toBeLessThanOrEqual(1000);
    expect(JSON.stringify(row)).not.toContain('BBBB');
  });

  it('retries the chain cache load after a failed read', async () => {
    jest
      .spyOn(store, 'read')
      .mockRejectedValueOnce(new Error('EIO'))
      .mockResolvedValueOnce([chain()]);
    const cache = new ChatChainCache(store);
    await expect(cache.get('chat-1')).rejects.toThrow('EIO');
    expect(await cache.get('chat-1')).toEqual(chain());
  });

  it('does not repopulate the chain cache from a read started before reset', async () => {
    await store.append([chain()]);
    const cache = new ChatChainCache(store);
    const inFlight = cache.get('chat-1');
    cache.reset();
    await store.clear();
    // Even the caller already waiting gets the post-reset view.
    expect(await inFlight).toBeNull();
    expect(await cache.get('chat-1')).toBeNull();
  });

  it('skips corrupt lines', async () => {
    await store.append([turn()]);
    await writeFile(
      path,
      `${await readFile(path, 'utf8')}{not json\n{"kind":"turn"}\n`,
    );
    expect(await new FingerprintStore(() => path).read()).toHaveLength(1);
    expect(parseFingerprintLines('garbage\n\n')).toEqual([]);
  });

  it('compacts turn rows by age and cap and prunes chains with their chat', () => {
    const rows = [
      turn({
        userMessageId: 'old',
        createdAt: NOW - 61 * DAY,
        chatId: 'old-chat',
      }),
      chain({ chatId: 'old-chat' }),
      ...Array.from({ length: FINGERPRINT_TURN_ROW_CAP + 5 }, (_, index) =>
        turn({ userMessageId: `m-${index}`, createdAt: NOW - index }),
      ),
      chain(),
    ];
    const kept = compactRows(rows, { now: NOW });
    const turns = kept.filter((row) => row.kind === 'turn');
    expect(turns).toHaveLength(FINGERPRINT_TURN_ROW_CAP);
    expect(turns.some((row) => row.userMessageId === 'old')).toBe(false);
    expect(kept.filter((row) => row.kind === 'chat_chain')).toEqual([chain()]);
  });

  it('prunes rows for chats that no longer exist', async () => {
    await store.append([turn(), turn({ chatId: 'gone', userMessageId: 'x' })]);
    const kept = await store.compact({
      now: NOW,
      liveChatIds: new Set(['chat-1']),
    });
    expect(kept.map((row) => row.chatId)).toEqual(['chat-1']);
    expect(await store.read()).toHaveLength(1);
  });

  it('purges a deleted workspace and its private partition', async () => {
    await store.append([
      turn(),
      turn({ projectId: 'ws-2', userMessageId: 'a', chatId: 'c2' }),
      turn({
        projectId: 'ws-3',
        partition: 'personal/private:ws-2',
        userMessageId: 'b',
        chatId: 'c3',
      }),
    ]);
    expect(await store.purgeWorkspace('ws-2')).toBe(2);
    expect((await store.read()).map((row) => row.projectId)).toEqual(['ws-1']);
  });

  it('clears every fingerprint', async () => {
    await store.append([turn()]);
    await store.clear();
    expect(await store.read()).toEqual([]);
    expect(await store.append([turn()])).toBe(1);
  });
});
