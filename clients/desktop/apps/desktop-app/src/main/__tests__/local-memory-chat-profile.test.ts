import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initClaudeModels,
  type PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  CHAT_HISTORY_PROFILE_FILE_KEY,
  buildChatHistoryProfilePrompt,
  prepareChatHistoryProfileInput,
  renderChatHistoryProfileIndexLine,
  renderChatHistoryProfileTopic,
  upsertChatHistoryProfileIndexLine,
  validateChatHistoryProfile,
  type ChatHistoryProfileGeneration,
  type ChatHistoryProfileInput,
  type PreparedChatHistoryProfile,
} from '../memory/local/chat-history-profile';
import {
  refreshChatHistoryProfile,
  requestChatHistoryProfileRefresh,
} from '../memory/local/chat-history-profile-refresh';
import {
  memoryEditRevision,
  withMemoryWriteLock,
} from '../memory/local/edit-coordination';
import { readConsolidationState } from '../memory/local/consolidation-state';
import {
  LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
  LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
} from '@canopy/desktop-shared/types/local-memory';

let mockMemoryRoot = '';
const mockReadPreferencesFile = jest.fn<
  Promise<Partial<PreferencesData>>,
  []
>();
const mockBroadcastLocalMemoryChanged = jest.fn();
const mockIsLocalMemoryModelBlockedByPolicy = jest.fn<
  Promise<boolean>,
  [string, string | undefined]
>(() => Promise.resolve(false));

jest.mock('../lib/paths', () => ({
  getUserMemoryDir: (): string => join(mockMemoryRoot, 'memory'),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<Partial<PreferencesData>> =>
    mockReadPreferencesFile(),
}));

jest.mock('../lib/background-helper-queue', () => ({
  BACKGROUND_HELPER_PRIORITIES: { memoryImport: 4 },
  enqueueBackgroundHelperTask: <T>(options: {
    task: () => Promise<T>;
  }): Promise<T> => options.task(),
}));

jest.mock('../memory/local/model-policy', () => ({
  isLocalMemoryModelBlockedByPolicy: (
    model: string,
    workspaceId?: string,
  ): Promise<boolean> =>
    mockIsLocalMemoryModelBlockedByPolicy(model, workspaceId),
}));

jest.mock('../memory/local/change-events', () => ({
  broadcastLocalMemoryChanged: (scope: unknown): void => {
    mockBroadcastLocalMemoryChanged(scope);
  },
}));

initClaudeModels([{ id: 'claude-haiku-4-5-20251001', label: 'Haiku' }]);

// The worked example: what a handful of real titles support, and what they
// do not.
const EXAMPLE_INPUT: ChatHistoryProfileInput = {
  projects: [
    { name: 'unstoppable-website', chatCount: 5 },
    { name: 'canopy', chatCount: 9 },
  ],
  chats: [
    {
      title: 'Fix flaky Playwright UI automation spec',
      project: 'canopy',
      lastActivityAt: '2026-09-20T10:00:00.000Z',
    },
    {
      title: 'fix flaky playwright UI automation spec',
      project: 'canopy',
      lastActivityAt: '2026-09-18T10:00:00.000Z',
    },
    {
      title: 'Address PR review comments on the import flow',
      project: 'canopy',
      lastActivityAt: '2026-09-17T10:00:00.000Z',
    },
    {
      title: 'Address PR review comments on checkout',
      project: 'unstoppable-website',
      lastActivityAt: '2026-09-16T10:00:00.000Z',
    },
    {
      title: 'Prep slides for the Unstoppable Domains all-hands',
      lastActivityAt: '2026-09-15T10:00:00.000Z',
    },
    { title: 'New chat', lastActivityAt: '2026-09-14T10:00:00.000Z' },
    {
      title: "Rewrite Ryan's bio for the conference site",
      lastActivityAt: '2026-09-12T10:00:00.000Z',
    },
    {
      title: "Ryan's 1:1 notes with the Unstoppable Domains design lead",
      lastActivityAt: '2026-09-10T10:00:00.000Z',
    },
  ],
};

const EXAMPLE_MODEL_OUTPUT = {
  facts: [
    { category: 'name', text: 'Ryan', evidence: ['T5', 'T6'] },
    // A company no title names is a guess, not a fact.
    { category: 'company', text: 'Acme Corp', evidence: ['T2'] },
    {
      category: 'company',
      text: 'Unstoppable Domains',
      evidence: ['T4', 'T6'],
    },
    {
      category: 'occupation',
      text: 'Software engineer',
      evidence: ['T1', 'T2'],
    },
    {
      category: 'frequent-task',
      text: 'Fixes flaky Playwright UI automation specs',
      evidence: ['T1'],
    },
    {
      category: 'frequent-task',
      text: 'Addresses pull request review comments',
      evidence: ['T2', 'T3'],
    },
    // Cites an entry that does not exist.
    {
      category: 'frequent-task',
      text: 'Plans marketing campaigns',
      evidence: ['T9'],
    },
    // One chat is not a frequent task.
    {
      category: 'frequent-task',
      text: 'Writes conference bios',
      evidence: ['T5'],
    },
    { category: 'tool', text: 'Playwright', evidence: ['T1'] },
    // A tool no cited title names is a guess.
    { category: 'tool', text: 'Kubernetes', evidence: ['T1'] },
    {
      category: 'other',
      text: 'Works across the canopy and unstoppable-website projects',
      evidence: ['P1', 'P2'],
    },
    // One chat is not lasting context.
    { category: 'other', text: 'Speaks at conferences', evidence: ['T5'] },
  ],
};

const EXAMPLE_TOPIC = `# User profile from Claude and Codex chat titles

Summarized on 2026-09-25 from 7 chats across 2 projects in the user's Claude and Codex history. Rescanning that history replaces this file.

- Name: Ryan
- Occupation: Software engineer
- Company: Unstoppable Domains

## Frequent tasks

- Fixes flaky Playwright UI automation specs (2 chats)
- Addresses pull request review comments (2 chats)

## Tools and technologies

- Playwright (2 chats)

## Other context

- Works across the canopy and unstoppable-website projects (14 chats)
`;

const EXAMPLE_INDEX_LINE =
  '- [User profile from Claude and Codex chat titles](topics/chat-history-profile.md): Name: Ryan. Occupation: Software engineer. Company: Unstoppable Domains. Frequent tasks: Fixes flaky Playwright UI automation specs; Addresses pull request review comments. Tools: Playwright.';

function prepared(
  input: ChatHistoryProfileInput = EXAMPLE_INPUT,
): PreparedChatHistoryProfile {
  const result = prepareChatHistoryProfileInput(input);
  if (!result) throw new Error('Expected usable chat titles');
  return result;
}

describe('prepareChatHistoryProfileInput', () => {
  it('numbers projects and de-duplicated chat titles newest first, skipping placeholders', () => {
    const result = prepared();
    expect(
      result.entries.map((entry) => ({
        id: entry.id,
        text: entry.text,
        count: entry.count,
      })),
    ).toEqual([
      { id: 'P1', text: 'canopy', count: 9 },
      { id: 'P2', text: 'unstoppable-website', count: 5 },
      { id: 'T1', text: 'Fix flaky Playwright UI automation spec', count: 2 },
      {
        id: 'T2',
        text: 'Address PR review comments on the import flow',
        count: 1,
      },
      { id: 'T3', text: 'Address PR review comments on checkout', count: 1 },
      {
        id: 'T4',
        text: 'Prep slides for the Unstoppable Domains all-hands',
        count: 1,
      },
      {
        id: 'T5',
        text: "Rewrite Ryan's bio for the conference site",
        count: 1,
      },
      {
        id: 'T6',
        text: "Ryan's 1:1 notes with the Unstoppable Domains design lead",
        count: 1,
      },
    ]);
    expect(result.chatCount).toBe(7);
    expect(result.projectCount).toBe(2);
  });

  it('returns null when no chat has a usable title', () => {
    expect(
      prepareChatHistoryProfileInput({
        projects: [{ name: 'app', chatCount: 3 }],
        chats: [
          { title: 'Untitled', lastActivityAt: null },
          { title: 'Imported from Codex', lastActivityAt: null },
          {
            title: 'Codex chat from Sep 3, 2026, 10:00 AM',
            lastActivityAt: null,
          },
          { title: '  ', lastActivityAt: null },
        ],
      }),
    ).toBeNull();
  });

  it('redacts contact details and home paths before a title reaches the model', () => {
    const result = prepared({
      projects: [],
      chats: [
        {
          title: 'Email jane.doe@example.com about /Users/jane/offsite.md',
          lastActivityAt: null,
        },
      ],
    });
    const [entry] = result.entries;
    expect(entry?.text).not.toContain('jane.doe@example.com');
    expect(entry?.text).not.toContain('/Users/jane');
  });

  it('hashes the same titles the same way regardless of order or timestamps', () => {
    const reordered: ChatHistoryProfileInput = {
      projects: [...EXAMPLE_INPUT.projects].reverse(),
      chats: [...EXAMPLE_INPUT.chats]
        .reverse()
        .map((chat) => ({ ...chat, lastActivityAt: null })),
    };
    expect(prepared(reordered).inputHash).toBe(prepared().inputHash);
  });

  it('changes the hash when a new title appears', () => {
    const grown: ChatHistoryProfileInput = {
      ...EXAMPLE_INPUT,
      chats: [
        ...EXAMPLE_INPUT.chats,
        { title: 'Draft the Q4 hiring plan', lastActivityAt: null },
      ],
    };
    expect(prepared(grown).inputHash).not.toBe(prepared().inputHash);
  });
});

describe('buildChatHistoryProfilePrompt', () => {
  it('sends every numbered entry as data and asks for cited evidence', () => {
    const prompt = buildChatHistoryProfilePrompt(prepared());
    expect(prompt.systemPrompt).toContain(
      "You summarize what a person's own chat titles reveal about them.",
    );
    expect(prompt.userMessage).toContain('P1. canopy — 9 chats');
    expect(prompt.userMessage).toContain(
      'T1. Fix flaky Playwright UI automation spec — canopy (2 chats)',
    );
    expect(prompt.userMessage).toContain(
      'T4. Prep slides for the Unstoppable Domains all-hands',
    );
    expect(prompt.userMessage).toContain('evidence');
    expect(prompt.userMessage).toContain(
      '- For name, company, and tool, `text` is the value alone, written exactly as an entry writes it.',
    );
    expect(prompt.userMessage).toContain(
      '- A name or company must be written in at least two chat titles. An occupation, a frequent task, or other context needs at least two supporting chats.',
    );
  });
});

describe('validateChatHistoryProfile', () => {
  it('keeps only facts the cited titles support (worked example)', () => {
    expect(
      validateChatHistoryProfile(EXAMPLE_MODEL_OUTPUT, prepared()),
    ).toEqual([
      { category: 'name', text: 'Ryan', chatCount: 2 },
      { category: 'occupation', text: 'Software engineer', chatCount: 3 },
      { category: 'company', text: 'Unstoppable Domains', chatCount: 2 },
      {
        category: 'frequent-task',
        text: 'Fixes flaky Playwright UI automation specs',
        chatCount: 2,
      },
      {
        category: 'frequent-task',
        text: 'Addresses pull request review comments',
        chatCount: 2,
      },
      { category: 'tool', text: 'Playwright', chatCount: 2 },
      {
        category: 'other',
        text: 'Works across the canopy and unstoppable-website projects',
        chatCount: 14,
      },
    ]);
  });

  it('drops a name that no cited title contains', () => {
    const facts = validateChatHistoryProfile(
      { facts: [{ category: 'name', text: 'Alex', evidence: ['T5'] }] },
      prepared(),
    );
    expect(facts).toEqual([]);
  });

  it('matches a name written with accents and typographic punctuation', () => {
    const facts = validateChatHistoryProfile(
      {
        facts: [{ category: 'name', text: 'Zoë', evidence: ['T1', 'T2'] }],
      },
      prepared({
        projects: [],
        chats: [
          { title: 'Zoë’s onboarding checklist', lastActivityAt: null },
          { title: 'ZOË: weekly plan', lastActivityAt: null },
        ],
      }),
    );
    expect(facts).toEqual([{ category: 'name', text: 'Zoë', chatCount: 2 }]);
  });

  it('drops a name only one chat mentions, since titles often name other people', () => {
    const facts = validateChatHistoryProfile(
      { facts: [{ category: 'name', text: 'Ryan', evidence: ['T5'] }] },
      prepared(),
    );
    expect(facts).toEqual([]);
  });

  it('counts only the cited chats that mention a name', () => {
    const facts = validateChatHistoryProfile(
      {
        facts: [
          { category: 'name', text: 'Ryan', evidence: ['T5', 'T1', 'T2'] },
        ],
      },
      prepared(),
    );
    expect(facts).toEqual([]);
  });

  it('does not take a name from a project name alone', () => {
    const facts = validateChatHistoryProfile(
      { facts: [{ category: 'name', text: 'Sarah', evidence: ['P1'] }] },
      prepared({
        projects: [{ name: 'sarah-wedding-site', chatCount: 6 }],
        chats: [{ title: 'Pick a venue', lastActivityAt: null }],
      }),
    );
    expect(facts).toEqual([]);
  });

  it('needs two chat titles that write the company', () => {
    const facts = validateChatHistoryProfile(
      {
        facts: [
          {
            category: 'company',
            text: 'Unstoppable Domains',
            evidence: ['T4'],
          },
        ],
      },
      prepared(),
    );
    expect(facts).toEqual([]);
  });

  it('drops a tool no cited title names', () => {
    const facts = validateChatHistoryProfile(
      {
        facts: [
          { category: 'tool', text: 'Kubernetes', evidence: ['T1', 'T2'] },
        ],
      },
      prepared(),
    );
    expect(facts).toEqual([]);
  });

  it('needs two supporting chats for other lasting context', () => {
    const facts = validateChatHistoryProfile(
      {
        facts: [
          {
            category: 'other',
            text: 'Speaks at conferences',
            evidence: ['T5'],
          },
        ],
      },
      prepared(),
    );
    expect(facts).toEqual([]);
  });

  it('needs two supporting chats before calling something an occupation', () => {
    const facts = validateChatHistoryProfile(
      {
        facts: [{ category: 'occupation', text: 'Speaker', evidence: ['T5'] }],
      },
      prepared(),
    );
    expect(facts).toEqual([]);
  });

  it('does not count a title twice when its project is cited too', () => {
    const facts = validateChatHistoryProfile(
      {
        facts: [
          {
            category: 'frequent-task',
            text: 'Maintains the canopy app',
            evidence: ['P1', 'T1', 'T1'],
          },
        ],
      },
      prepared(),
    );
    expect(facts).toEqual([
      {
        category: 'frequent-task',
        text: 'Maintains the canopy app',
        chatCount: 9,
      },
    ]);
  });

  it('flattens fact text to one clean line', () => {
    const facts = validateChatHistoryProfile(
      {
        facts: [
          {
            category: 'frequent-task',
            text: '## Playwright\n  and   Jest',
            evidence: ['T1'],
          },
        ],
      },
      prepared(),
    );
    expect(facts).toEqual([
      { category: 'frequent-task', text: 'Playwright and Jest', chatCount: 2 },
    ]);
  });

  it('keeps the first of repeated facts', () => {
    const facts = validateChatHistoryProfile(
      {
        facts: [
          { category: 'tool', text: 'Playwright', evidence: ['T1'] },
          { category: 'tool', text: 'playwright', evidence: ['T1'] },
        ],
      },
      prepared(),
    );
    expect(facts).toHaveLength(1);
  });

  it('returns an empty list when the titles support nothing', () => {
    expect(validateChatHistoryProfile({ facts: [] }, prepared())).toEqual([]);
  });

  it('rejects output that does not match the schema', () => {
    expect(
      validateChatHistoryProfile({ memoryMd: 'x' }, prepared()),
    ).toBeNull();
    expect(validateChatHistoryProfile(null, prepared())).toBeNull();
    expect(
      validateChatHistoryProfile({ facts: 'Ryan' }, prepared()),
    ).toBeNull();
  });
});

describe('rendering', () => {
  it('renders the worked example as a topic file and one index line', () => {
    const input = prepared();
    const facts = validateChatHistoryProfile(EXAMPLE_MODEL_OUTPUT, input);
    if (!facts) throw new Error('Expected valid facts');
    expect(
      renderChatHistoryProfileTopic(
        facts,
        input,
        new Date('2026-09-25T12:00:00.000Z'),
      ),
    ).toBe(EXAMPLE_TOPIC);
    expect(renderChatHistoryProfileIndexLine(facts)).toBe(EXAMPLE_INDEX_LINE);
  });
});

describe('upsertChatHistoryProfileIndexLine', () => {
  const line = `- [Profile](${CHAT_HISTORY_PROFILE_FILE_KEY}): Name: Ryan.`;

  it('starts an empty index with the line', () => {
    expect(upsertChatHistoryProfileIndexLine('', line)).toBe(`${line}\n`);
  });

  it('puts the line right under the index heading so it is always delivered', () => {
    expect(
      upsertChatHistoryProfileIndexLine(
        '# Memory Index\n\n## Shell\n- Quote variables.\n',
        line,
      ),
    ).toBe(`# Memory Index\n\n${line}\n\n## Shell\n- Quote variables.\n`);
  });

  it('puts the line first when the index has no heading', () => {
    expect(
      upsertChatHistoryProfileIndexLine('- Keep replies short.\n', line),
    ).toBe(`${line}\n\n- Keep replies short.\n`);
  });

  it('replaces every earlier reference to the profile instead of adding another', () => {
    const existing = [
      '# Memory Index',
      '',
      '- [Profile](topics/chat-history-profile.md): Name: Old.',
      '',
      '## About the user',
      '- See TOPICS/chat-history-profile.md for who the user is.',
      '- Travel: topics/chat-history-profile-2024.md',
      '',
    ].join('\n');
    expect(upsertChatHistoryProfileIndexLine(existing, line)).toBe(
      [
        '# Memory Index',
        '',
        line,
        '',
        '## About the user',
        '- Travel: topics/chat-history-profile-2024.md',
        '',
      ].join('\n'),
    );
  });

  it('is stable when applied twice', () => {
    const once = upsertChatHistoryProfileIndexLine('# Memory\n\n- a\n', line);
    expect(upsertChatHistoryProfileIndexLine(once, line)).toBe(once);
  });
});

describe('refreshChatHistoryProfile', () => {
  const memoryDir = (): string => join(mockMemoryRoot, 'memory');
  const finalize = jest.fn<void, ['success' | 'failure', string?]>();
  const generate = jest.fn<
    Promise<ChatHistoryProfileGeneration>,
    [PreparedChatHistoryProfile, unknown]
  >();
  const now = (): Date => new Date('2026-09-25T12:00:00.000Z');

  beforeEach(async () => {
    mockMemoryRoot = await mkdtemp(join(tmpdir(), 'chat-profile-'));
    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: true,
      localMemoryModel: 'claude-haiku-4-5-20251001',
      localMemoryThinkingLevel: 'off',
    });
    mockBroadcastLocalMemoryChanged.mockReset();
    finalize.mockReset();
    generate.mockReset();
    generate.mockResolvedValue({ output: EXAMPLE_MODEL_OUTPUT, finalize });
  });

  afterEach(async () => {
    await rm(mockMemoryRoot, { recursive: true, force: true });
  });

  it('saves the profile to user memory and indexes it', async () => {
    await mkdir(memoryDir(), { recursive: true });
    await writeFile(
      join(memoryDir(), 'MEMORY.md'),
      '# Memory Index\n\n- Prefer short replies.\n',
    );

    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({ status: 'updated' });

    await expect(
      readFile(join(memoryDir(), CHAT_HISTORY_PROFILE_FILE_KEY), 'utf8'),
    ).resolves.toBe(EXAMPLE_TOPIC);
    await expect(
      readFile(join(memoryDir(), 'MEMORY.md'), 'utf8'),
    ).resolves.toBe(
      `# Memory Index\n\n${EXAMPLE_INDEX_LINE}\n\n- Prefer short replies.\n`,
    );
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ inputHash: prepared().inputHash }),
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
    );
    expect(finalize).toHaveBeenCalledWith('success');
    expect(mockBroadcastLocalMemoryChanged).toHaveBeenCalledWith({
      scope: 'user',
    });
  });

  it('adds the profile line to a full index without dropping any line', async () => {
    const indexPath = join(memoryDir(), 'MEMORY.md');
    await mkdir(memoryDir(), { recursive: true });
    const facts = Array.from({ length: 260 }, (_, i) => `- fact ${i}`);
    await writeFile(indexPath, ['# Memory', ...facts].join('\n'));
    await refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now });
    const index = await readFile(indexPath, 'utf8');
    // The line goes right under the heading, inside the part of the index
    // every chat receives; consolidation, not the profile save, brings an
    // index back within its limits, after snapshotting it.
    expect(index.split('\n').slice(0, 3)).toEqual([
      '# Memory',
      '',
      EXAMPLE_INDEX_LINE,
    ]);
    for (const fact of facts) expect(index).toContain(`${fact}\n`);
  });

  it('marks the write as a memory edit so a consolidation already in flight does not overwrite it', async () => {
    const before = memoryEditRevision(memoryDir());
    await refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now });
    expect(memoryEditRevision(memoryDir())).toBe(before + 1);
  });

  it('does not ask the model again when the titles have not changed', async () => {
    await refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now });
    generate.mockClear();

    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({ status: 'unchanged' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not bring back a profile the user deleted while the titles are unchanged', async () => {
    await refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now });
    await rm(join(memoryDir(), CHAT_HISTORY_PROFILE_FILE_KEY));
    await writeFile(
      join(memoryDir(), 'MEMORY.md'),
      '- Prefer short replies.\n',
    );
    generate.mockClear();

    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({ status: 'unchanged' });
    expect(generate).not.toHaveBeenCalled();
    expect(existsSync(join(memoryDir(), CHAT_HISTORY_PROFILE_FILE_KEY))).toBe(
      false,
    );
  });

  it('collects the scan input only after checking the memory preference', async () => {
    const collect = jest.fn((): ChatHistoryProfileInput => EXAMPLE_INPUT);
    mockReadPreferencesFile.mockResolvedValue({ localMemoryEnabled: false });
    await expect(
      refreshChatHistoryProfile(collect, { generate, now }),
    ).resolves.toEqual({ status: 'disabled' });
    expect(collect).not.toHaveBeenCalled();

    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: true,
      localMemoryModel: 'claude-haiku-4-5-20251001',
      localMemoryThinkingLevel: 'off',
    });
    await expect(
      refreshChatHistoryProfile(collect, { generate, now }),
    ).resolves.toEqual({ status: 'updated' });
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it('records the refresh under the memory write lock', async () => {
    generate.mockResolvedValue({ output: { facts: [] }, finalize });
    let release: () => void = () => undefined;
    const held = withMemoryWriteLock(
      memoryDir(),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const refresh = refreshChatHistoryProfile(EXAMPLE_INPUT, {
      generate,
      now,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      existsSync(join(memoryDir(), 'chat-history-profile-state.json')),
    ).toBe(false);

    release();
    await held;
    await expect(refresh).resolves.toEqual({ status: 'no-facts' });
    expect(
      existsSync(join(memoryDir(), 'chat-history-profile-state.json')),
    ).toBe(true);
  });

  it('reads no titles at all when local memory is off', async () => {
    mockReadPreferencesFile.mockResolvedValue({ localMemoryEnabled: false });
    const untouchable: ChatHistoryProfileInput = {
      projects: [],
      chats: [
        {
          get title(): string {
            throw new Error('titles were read');
          },
          lastActivityAt: null,
        },
      ],
    };
    await expect(
      refreshChatHistoryProfile(untouchable, { generate, now }),
    ).resolves.toEqual({ status: 'disabled' });
  });

  it('refreshes in place when new titles arrive', async () => {
    await refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now });
    generate.mockResolvedValue({
      output: {
        facts: [
          { category: 'name', text: 'Ryan', evidence: ['T5', 'T6', 'T7'] },
        ],
      },
      finalize,
    });

    await expect(
      refreshChatHistoryProfile(
        {
          ...EXAMPLE_INPUT,
          chats: [
            ...EXAMPLE_INPUT.chats,
            { title: 'Ryan: draft the Q4 hiring plan', lastActivityAt: null },
          ],
        },
        { generate, now },
      ),
    ).resolves.toEqual({ status: 'updated' });

    const index = await readFile(join(memoryDir(), 'MEMORY.md'), 'utf8');
    expect(index).toBe(
      '- [User profile from Claude and Codex chat titles](topics/chat-history-profile.md): Name: Ryan.\n',
    );
    const topic = await readFile(
      join(memoryDir(), CHAT_HISTORY_PROFILE_FILE_KEY),
      'utf8',
    );
    expect(topic).toContain('- Name: Ryan');
    expect(topic).not.toContain('Playwright');
  });

  it('does nothing when local memory is off', async () => {
    mockReadPreferencesFile.mockResolvedValue({ localMemoryEnabled: false });
    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({ status: 'disabled' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('does nothing when no chat has a usable title', async () => {
    await expect(
      refreshChatHistoryProfile(
        { projects: [], chats: [{ title: 'New chat', lastActivityAt: null }] },
        { generate, now },
      ),
    ).resolves.toEqual({ status: 'no-titles' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('keeps the previous profile when the new titles support nothing, and does not ask again for them', async () => {
    await refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now });
    const grown: ChatHistoryProfileInput = {
      ...EXAMPLE_INPUT,
      chats: [
        ...EXAMPLE_INPUT.chats,
        { title: 'Quick question', lastActivityAt: null },
      ],
    };
    generate.mockResolvedValue({ output: { facts: [] }, finalize });

    await expect(
      refreshChatHistoryProfile(grown, { generate, now }),
    ).resolves.toEqual({ status: 'no-facts' });
    await expect(
      readFile(join(memoryDir(), CHAT_HISTORY_PROFILE_FILE_KEY), 'utf8'),
    ).resolves.toBe(EXAMPLE_TOPIC);

    generate.mockClear();
    await expect(
      refreshChatHistoryProfile(grown, { generate, now }),
    ).resolves.toEqual({ status: 'unchanged' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('retries on the next scan when the model fails', async () => {
    generate.mockRejectedValueOnce(new Error('model unavailable'));
    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({ status: 'failed', reason: 'model unavailable' });

    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({ status: 'updated' });
  });

  it('sends no titles to any model while the chosen model is unavailable, says why, and retries later', async () => {
    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: true,
      localMemoryModel: 'ollama-offline-model',
      localMemoryThinkingLevel: 'off',
    });
    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({
      status: 'model-unavailable',
      reason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
    });
    expect(generate).not.toHaveBeenCalled();
    expect(existsSync(join(memoryDir(), CHAT_HISTORY_PROFILE_FILE_KEY))).toBe(
      false,
    );
    await expect(readConsolidationState(memoryDir())).resolves.toMatchObject({
      lastResult: 'skipped',
      lastReason: LOCAL_MEMORY_MODEL_UNAVAILABLE_MESSAGE,
    });
    expect(mockBroadcastLocalMemoryChanged).toHaveBeenCalledWith({
      scope: 'user',
    });

    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: true,
      localMemoryModel: 'claude-haiku-4-5-20251001',
      localMemoryThinkingLevel: 'off',
    });
    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({ status: 'updated' });
  });

  it('sends no titles to any model while the organization blocks the memory model, says why, and retries later', async () => {
    mockIsLocalMemoryModelBlockedByPolicy.mockResolvedValueOnce(true);
    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({
      status: 'model-unavailable',
      reason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
    });
    expect(generate).not.toHaveBeenCalled();
    await expect(readConsolidationState(memoryDir())).resolves.toMatchObject({
      lastResult: 'skipped',
      lastReason: LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE,
    });

    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({ status: 'updated' });
  });

  it('reports invalid model output as a failure and retries later', async () => {
    generate.mockResolvedValueOnce({ output: { profile: 'x' }, finalize });
    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({
      status: 'invalid-output',
      reason: 'The chat history profile did not match the expected format',
    });
    expect(finalize).toHaveBeenCalledWith(
      'failure',
      'The chat history profile did not match the expected format',
    );

    await expect(
      refreshChatHistoryProfile(EXAMPLE_INPUT, { generate, now }),
    ).resolves.toEqual({ status: 'updated' });
  });
});

describe('requestChatHistoryProfileRefresh', () => {
  const finalize = jest.fn();

  beforeEach(async () => {
    mockMemoryRoot = await mkdtemp(join(tmpdir(), 'chat-profile-queue-'));
    mockReadPreferencesFile.mockResolvedValue({
      localMemoryEnabled: true,
      localMemoryModel: 'claude-haiku-4-5-20251001',
      localMemoryThinkingLevel: 'off',
    });
  });

  afterEach(async () => {
    await rm(mockMemoryRoot, { recursive: true, force: true });
  });

  it('runs one refresh at a time and folds scans that arrive meanwhile into the newest', async () => {
    let releaseFirst: () => void = () => undefined;
    let signalFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const generate = jest
      .fn<
        Promise<ChatHistoryProfileGeneration>,
        [PreparedChatHistoryProfile, unknown]
      >()
      .mockImplementationOnce(async () => {
        signalFirstStarted();
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
        return { output: EXAMPLE_MODEL_OUTPUT, finalize };
      })
      .mockResolvedValue({ output: { facts: [] }, finalize });
    const withTitle = (extra: string): ChatHistoryProfileInput => ({
      ...EXAMPLE_INPUT,
      chats: [...EXAMPLE_INPUT.chats, { title: extra, lastActivityAt: null }],
    });

    const first = requestChatHistoryProfileRefresh(withTitle('first scan'), {
      generate,
    });
    await firstStarted;
    const second = requestChatHistoryProfileRefresh(withTitle('second scan'), {
      generate,
    });
    const third = requestChatHistoryProfileRefresh(withTitle('third scan'), {
      generate,
    });
    releaseFirst();
    await Promise.all([first, second, third]);

    expect(generate).toHaveBeenCalledTimes(2);
    const texts = generate.mock.calls[1]?.[0].entries.map(
      (entry) => entry.text,
    );
    expect(texts).toContain('third scan');
    expect(texts).not.toContain('second scan');
  });
});
