import {
  buildSkillStarterPrompt,
  buildTryItCapabilityKey,
  buildTryItPrompt,
  isTryItCapability,
  isTryItCapabilityArray,
  normalizeTryItCapabilities,
  resolveDetailPrimaryCta,
  resolveTryItHarness,
  resolveTryItModelId,
  TRY_IT_PROMPT_MAX_LENGTH,
  type TryItHarnessOption,
} from '../index';

const capability = {
  kind: 'mcp' as const,
  sourceId: 'curated',
  catalogId: 'github',
  name: 'GitHub',
};

it.each([
  ['loading', 'installed', 'pending'],
  ['signed-in', 'loading', 'pending'],
  ['guest', 'loading', 'pending'],
  ['guest', 'not-installed', 'try'],
  ['guest', 'installed', 'try'],
  ['signed-in', 'installed', 'try'],
  ['signed-in', 'not-installed', 'install'],
  ['signed-in', 'pending', 'pending'],
] as const)('resolves %s / %s', (account, installation, expected) => {
  expect(resolveDetailPrimaryCta({ account, installation })).toBe(expected);
});

it.each([
  ['guest', 'installed', 'ready', 'try'],
  ['guest', 'installed', 'loading', 'pending'],
  ['guest', 'installed', 'setup-required', 'try'],
  ['guest', 'not-installed', 'setup-required', 'try'],
  ['signed-in', 'installed', 'setup-required', 'try'],
  ['signed-in', 'not-installed', 'loading', 'install'],
] as const)(
  'preserves installation semantics while harness setup is missing (%s, %s, %s)',
  (account, installation, runtime, expected) => {
    expect(resolveDetailPrimaryCta({ account, installation, runtime })).toBe(
      expected,
    );
  },
);

it('keys by account, kind and complete source identity, excluding display names', () => {
  const key = buildTryItCapabilityKey('alice', capability);
  expect(
    buildTryItCapabilityKey('alice', { ...capability, name: 'Renamed' }),
  ).toBe(key);
  for (const [account, entry] of [
    ['bob', capability],
    ['alice', { ...capability, kind: 'plugin' as const }],
    ['alice', { ...capability, sourceId: 'other-marketplace' }],
    ['alice', { ...capability, catalogId: 'other-entry' }],
  ] as const)
    expect(buildTryItCapabilityKey(account, entry)).not.toBe(key);
  expect(
    buildTryItCapabilityKey('a', {
      ...capability,
      sourceId: 'a:b',
      catalogId: 'c',
    }),
  ).not.toBe(
    buildTryItCapabilityKey('a', {
      ...capability,
      sourceId: 'a',
      catalogId: 'b:c',
    }),
  );
});

it('validates and de-duplicates serializable unresolved identities', () => {
  expect(isTryItCapability(JSON.parse(JSON.stringify(capability)))).toBe(true);
  for (const value of [
    null,
    [],
    {},
    { ...capability, kind: 'unknown' },
    { ...capability, sourceId: '' },
    { ...capability, name: 'x'.repeat(257) },
    { ...capability, catalogId: 'a\u0000b' },
    { ...capability, extra: true },
  ]) {
    expect(isTryItCapability(value)).toBe(false);
  }
  expect(isTryItCapabilityArray(Array(201).fill(capability))).toBe(false);
  const normalized = normalizeTryItCapabilities([
    capability,
    { ...capability, name: 'Renamed' },
  ]);
  expect(normalized).toEqual([capability]);
  expect(normalized[0]).not.toBe(capability);
});

it.each(['plugin', 'mcp', 'skill'] as const)(
  'prefers explicit prompts for %s and only trims their edges',
  (kind) => {
    expect(
      buildTryItPrompt({
        kind,
        name: 'Tool',
        description: 'Fallback.',
        tryNowPrompt: '  Keep\n  my wording?!  ',
        frontmatter: { example: 'Other' },
      }),
    ).toBe('Keep\n  my wording?!');
  },
);

it('uses valid skill frontmatter in precedence order and ignores malformed values', () => {
  const base = {
    kind: 'skill' as const,
    name: 'Writer',
    description: 'Draft a brief...',
    tryNowPrompt: '  ',
  };
  expect(
    buildTryItPrompt({
      ...base,
      frontmatter: {
        example: ' First ',
        usage: 'Second',
        example_prompt: 'Third',
      },
    }),
  ).toBe('First');
  expect(
    buildTryItPrompt({
      ...base,
      frontmatter: { example: {}, usage: ' Second ', example_prompt: 'Third' },
    }),
  ).toBe('Second');
  expect(
    buildTryItPrompt({
      ...base,
      frontmatter: { example: ' ', usage: [], example_prompt: ' Third ' },
    }),
  ).toBe('Third');
  expect(
    buildTryItPrompt({ ...base, frontmatter: { example: false, usage: 5 } }),
  ).toBe('Using Writer, draft a brief.');
});

const GRANOLA_DESCRIPTION = [
  'Granola MCP connects your meeting history to ChatGPT so your assistant can pull real context from past conversations while you work.',
  "Use MCP when you're already working on something bigger:",
  '-   Writing PRDs or proposals: Pull customer feedback, stakeholder input, and decisions from relevant meetings directly into your draft',
  '-   Building presentations or reports: Combine insights from multiple conversations with your other research and data',
].join('\n\n');

describe('fallback Try it prompts', () => {
  it('turns a long marketplace description into one short task', () => {
    const prompt = buildTryItPrompt({
      kind: 'plugin',
      name: 'Granola',
      description: GRANOLA_DESCRIPTION,
      tryNowPrompt: '',
    });
    expect(prompt).toBe(
      'Using Granola, pull real context from past conversations.',
    );
    expect(prompt.length).toBeLessThanOrEqual(TRY_IT_PROMPT_MAX_LENGTH);
    expect(prompt).not.toContain('connects your meeting history');
    expect(prompt).not.toContain('PRDs');
  });

  it('lets the catalog prompt win over a long description', () => {
    expect(
      buildTryItPrompt({
        kind: 'plugin',
        name: 'Granola',
        description: GRANOLA_DESCRIPTION,
        tryNowPrompt:
          'Summarize the key decisions from my most recent meeting.',
      }),
    ).toBe('Summarize the key decisions from my most recent meeting.');
  });

  it.each([
    [
      'Notion',
      'Search and summarize your Notion pages and comments.',
      'Using Notion, search and summarize my Notion pages and comments.',
    ],
    [
      'PR Helper',
      'Summarizes pull requests and drafts review comments for your team.',
      'Using PR Helper, summarize pull requests and draft review comments for my team.',
    ],
    [
      'Figma',
      'This MCP server helps Claude read designs from Figma files.',
      'Using Figma, read designs from Figma files.',
    ],
    [
      'table-helper',
      '**Formats** markdown tables in [docs](https://example.com). More.',
      'Using table-helper, format markdown tables in docs.',
    ],
    [
      'Linear',
      'Linear is an issue tracker for software teams. It does lots.',
      'Try one quick, real task with Linear, an issue tracker for software teams, and show me the result.',
    ],
  ])(
    'derives a task for %s from its opening sentence',
    (name, description, expected) => {
      expect(buildTryItPrompt({ kind: 'mcp', name, description })).toBe(
        expected,
      );
    },
  );

  it('trims an overlong task at a word boundary without a dangling word', () => {
    const prompt = buildTryItPrompt({
      kind: 'plugin',
      name: 'Sentry',
      description:
        'Query Sentry issues, inspect stack traces, and triage production errors across every project, environment, release, team, and region in the whole organization at once.',
    });
    expect(prompt.length).toBeLessThanOrEqual(TRY_IT_PROMPT_MAX_LENGTH);
    expect(prompt).toMatch(/^Using Sentry, query Sentry issues, .*[a-z]\.$/);
    expect(prompt).not.toMatch(/\b(?:and|the|in|of),?\.$/);
  });

  it.each(['plugin', 'mcp', 'skill'] as const)(
    'falls back to a short generic task for %s',
    (kind) => {
      const label = kind === 'mcp' ? 'MCP server' : kind;
      const generic = `Using the My Tool ${label}, run one quick, real example and show me the result.`;
      expect(buildTryItPrompt({ kind, name: ' My   Tool ' })).toBe(generic);
      // A setup verb names the wiring, not a task to try.
      expect(
        buildTryItPrompt({
          kind,
          name: 'My Tool',
          description: 'Connects My Tool to Claude.',
        }),
      ).toBe(generic);
      expect(
        buildTryItPrompt({
          kind,
          name: 'My Tool',
          description: 'Official integration for teams.',
        }),
      ).toBe(generic);
    },
  );
});

describe('resolveTryItHarness', () => {
  const option = (
    harness: TryItHarnessOption['harness'],
    supported: boolean,
    available: boolean,
  ): TryItHarnessOption => ({ harness, supported, available });

  it('keeps the preferred harness when the capability supports it', () => {
    expect(
      resolveTryItHarness({
        preferred: 'codex',
        options: [option('claude', true, true), option('codex', true, true)],
      }),
    ).toBe('codex');
  });

  it('moves a Claude default to Codex when Claude is unsupported', () => {
    expect(
      resolveTryItHarness({
        preferred: 'claude',
        options: [
          option('claude', false, true),
          option('codex', true, true),
          option('cursor', true, false),
        ],
      }),
    ).toBe('codex');
  });

  it('picks the first supported, available harness without a usable default', () => {
    expect(
      resolveTryItHarness({
        preferred: null,
        options: [
          option('claude', true, false),
          option('codex', false, true),
          option('cursor', true, true),
        ],
      }),
    ).toBe('cursor');
  });

  it('returns null when no supported harness is available', () => {
    expect(
      resolveTryItHarness({
        preferred: 'claude',
        options: [option('claude', false, true), option('codex', true, false)],
      }),
    ).toBeNull();
  });
});

describe('resolveTryItModelId', () => {
  const models = [
    { id: 'opus', provider: 'claude', available: true },
    {
      id: 'locked-codex',
      provider: 'codex',
      available: true,
      libraryEligibility: 'locked' as const,
    },
    {
      id: 'gpt-5.5',
      provider: 'ai-gateway',
      harness: 'codex',
      available: true,
    },
  ];

  it('pins the first usable Codex model when the Claude default is unsupported', () => {
    expect(
      resolveTryItModelId({
        models,
        currentModelId: 'opus',
        support: { claude: false, codex: true },
      }),
    ).toBe('gpt-5.5');
  });

  it('keeps a supported current model', () => {
    expect(
      resolveTryItModelId({
        models,
        currentModelId: 'opus',
        support: { claude: true, codex: true },
      }),
    ).toBeUndefined();
  });

  it('keeps the current model when no supported harness has a usable model', () => {
    expect(
      resolveTryItModelId({
        models: models.slice(0, 2),
        currentModelId: 'opus',
        support: { claude: false, codex: true },
      }),
    ).toBeUndefined();
  });
});

it('shares the fallback task and frontmatter with the legacy skill helper', () => {
  expect(
    buildSkillStarterPrompt({
      name: 'Writer',
      description: 'Draft a brief.',
      frontmatter: null,
    }),
  ).toBe('Using Writer, draft a brief.');
  expect(
    buildSkillStarterPrompt({
      name: 'Writer',
      description: '',
      frontmatter: null,
    }),
  ).toBe(
    'Using the Writer skill, run one quick, real example and show me the result.',
  );
  expect(
    buildSkillStarterPrompt({
      name: 'Writer',
      description: '',
      frontmatter: { usage: ' Do this ' },
    }),
  ).toBe('Do this');
});
