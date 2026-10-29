import { openCodeNativeOperations } from '../tool-input';
import { headlessOpenCodeDecision } from '../headless-policy';
import { openCodePromptUsage } from '../runtime-api';

it.each(['~', '~/host-approval/index.js', '~\\host-approval\\index.js'])(
  'rejects provider-expanded home paths before any authorization: %s',
  (target) => {
    for (const [name, input] of [
      ['read', { path: target }],
      ['write', { path: target, content: 'replacement' }],
      ['edit', { path: target, oldString: 'before', newString: 'after' }],
      ['glob', { path: target, pattern: '*' }],
      ['grep', { path: target, pattern: 'secret' }],
      ['shell', { workdir: target, command: 'pwd' }],
      [
        'patch',
        {
          patchText: `*** Begin Patch\n*** Add File: ${target}\n+replacement\n*** End Patch`,
        },
      ],
      [
        'patch',
        {
          patchText: `*** Begin Patch\n*** Update File: safe.txt\n*** Move to: ${target}\n@@\n-before\n+after\n*** End Patch`,
        },
      ],
    ] as const) {
      expect(
        openCodeNativeOperations(name, input, '/workspace'),
      ).toBeUndefined();
      expect(
        headlessOpenCodeDecision(
          'dangerous_all',
          {
            sessionId: 's',
            toolCallId: 't',
            toolName: name,
            toolArgs: input,
          },
          '/workspace',
        ).decision,
      ).toBe('deny');
    }
  },
);

it.each([
  '/c/private.txt',
  '/c:/private.txt',
  '/cygdrive/c/private.txt',
  '/mnt/c/private.txt',
])(
  'rejects Windows shell path expansion before authorization: %s',
  (target) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(
        openCodeNativeOperations(
          'write',
          { path: target, content: 'x' },
          'C:\\workspace',
        ),
      ).toBeUndefined();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  },
);

it('normalizes v2 native paths and shell commands for the existing approval service', () => {
  expect(
    openCodeNativeOperations('read', { path: 'source.ts' }, '/workspace'),
  ).toEqual([
    {
      tool: 'Read',
      input: { file_path: '/workspace/source.ts' },
      mutates: false,
    },
  ]);
  expect(
    openCodeNativeOperations(
      'shell',
      { command: 'pwd', workdir: 'src' },
      '/workspace',
    ),
  ).toEqual([
    {
      tool: 'Bash',
      input: { command: 'pwd', cwd: '/workspace/src' },
      mutates: true,
    },
  ]);
  expect(
    openCodeNativeOperations(
      'patch',
      { patchText: '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch' },
      '/workspace',
    ),
  ).toEqual([
    {
      tool: 'Write',
      input: { file_path: '/workspace/a.txt', content: '' },
      mutates: true,
    },
  ]);
});

it('checks every patch source, destination and deleted file before permitting a move', () => {
  expect(
    openCodeNativeOperations(
      'apply_patch',
      {
        patchText:
          '*** Begin Patch\n*** Update File: a.txt\n*** Move to: ../outside.txt\n@@\n-old\n+new\n*** Delete File: b.txt\n*** End Patch',
      },
      '/workspace',
    ),
  ).toEqual([
    {
      tool: 'Write',
      input: { file_path: '/workspace/a.txt', content: '' },
      mutates: true,
    },
    {
      tool: 'Write',
      input: { file_path: '/outside.txt', content: '' },
      mutates: true,
    },
    {
      tool: 'Write',
      input: { file_path: '/workspace/b.txt', content: '' },
      mutates: true,
    },
  ]);
});

it.each(['task', 'question', 'batch', 'unknown'])(
  'declines unsupported %s even for unattended full access',
  (toolName) => {
    expect(
      headlessOpenCodeDecision(
        'dangerous_all',
        { sessionId: 's', toolCallId: 't', toolName, toolArgs: {} },
        '/workspace',
      ).decision,
    ).toBe('deny');
  },
);

it.each(['none', 'read_only', 'plan'] as const)(
  '%s declines writes and shell commands',
  (preset) => {
    for (const [toolName, toolArgs] of [
      ['bash', { command: 'touch sentinel' }],
      ['write', { filePath: 'sentinel', content: 'x' }],
    ] as const)
      expect(
        headlessOpenCodeDecision(
          preset,
          { sessionId: 's', toolCallId: 't', toolName, toolArgs },
          '/workspace',
        ).decision,
      ).toBe('deny');
  },
);

it('reads v2 prompt usage without counting resumed history', () => {
  expect(
    openCodePromptUsage({
      inputTokens: 30,
      outputTokens: 13,
      thoughtTokens: 4,
      cachedReadTokens: 6,
      cachedWriteTokens: 8,
    }),
  ).toEqual({
    input_tokens: 30,
    output_tokens: 17,
    reasoning_tokens: 4,
    cache_read_input_tokens: 6,
    cache_creation_input_tokens: 8,
  });
  expect(openCodePromptUsage(undefined)).toBeUndefined();
  expect(openCodePromptUsage({ inputTokens: 10, outputTokens: 2 })).toEqual({
    input_tokens: 10,
    output_tokens: 2,
    reasoning_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

it('rejects detached v2 shell jobs that cannot be tied to the active turn', () => {
  expect(
    openCodeNativeOperations(
      'shell',
      { command: 'touch sentinel', background: true },
      '/workspace',
    ),
  ).toBeUndefined();
});

it.each([undefined, null, {}, { outputTokens: 1 }, { inputTokens: 1 }])(
  'does not fabricate zero usage from a missing or incomplete prompt report %#',
  (value) => expect(openCodePromptUsage(value)).toBeUndefined(),
);

for (const field of [
  'inputTokens',
  'outputTokens',
  'thoughtTokens',
  'cachedReadTokens',
  'cachedWriteTokens',
]) {
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    `rejects invalid supplied ${field}: %s`,
    (value) =>
      expect(
        openCodePromptUsage({
          inputTokens: 1,
          outputTokens: 2,
          [field]: value,
        }),
      ).toBeUndefined(),
  );
}

it('keeps reported zeros distinct from an absent report', () => {
  expect(openCodePromptUsage({ inputTokens: 0, outputTokens: 0 })).toEqual({
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

it('never treats a cumulative native cost as a prompt cost', () => {
  const usage = openCodePromptUsage({
    inputTokens: 10,
    outputTokens: 5,
    cost: 100.75,
    estimatedCostUsd: 100.75,
  });
  expect(usage).toMatchObject({ input_tokens: 10, output_tokens: 5 });
  expect(usage).not.toHaveProperty('estimated_cost_usd');
});

it.each([
  { inputTokens: 0, outputTokens: Number.MAX_SAFE_INTEGER, thoughtTokens: 1 },
  { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
  {
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: Number.MAX_SAFE_INTEGER,
    cachedWriteTokens: 1,
  },
])('refuses overflowing counters instead of rounding them %#', (value) => {
  expect(openCodePromptUsage(value)).toBeUndefined();
});
