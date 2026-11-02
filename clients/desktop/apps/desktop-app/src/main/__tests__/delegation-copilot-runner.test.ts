import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type {
  CopilotPreToolInput,
  CopilotToolDecision,
} from '@canopy/desktop-shared/node/copilot/session-policy';
import type { CursorCapabilityProjection } from '@canopy/desktop-shared/lib/cursor-capabilities';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CurrentToolMetadata } from '@github/copilot-sdk';
import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import type {
  AgentRunRequest,
  NativeRunHandle,
} from '@canopy/desktop-shared/node/delegation';
import { InMemoryDelegationTranscriptPort } from '@canopy/desktop-shared/node/delegation/in-memory-transcript-port';
import type {
  DelegationTranscriptChange,
  DelegationTranscriptTarget,
} from '@canopy/desktop-shared/node/delegation/transcript-port';
import { DelegationNativePolicy } from '../agents/delegation/native-policy';
import {
  authorizeDelegatedCopilotTool,
  createCopilotDelegationRunner,
} from '../agents/delegation/copilot-runner';
import { DELEGATION_TRANSCRIPT_RECORDER_LIMITS } from '../agents/delegation/transcript-recorder';
import {
  account,
  nativeRuntime as createCopilotNativeRuntime,
  request as copilotRequest,
  type FixtureRuntime,
} from './helpers/delegation-runner-fixtures/copilot';

const mockOpen = jest.fn<Promise<FixtureRuntime>, unknown[]>();
const mockCheckGeneration = jest.fn<void, unknown[]>();
jest.mock('../copilot/connection', () => ({
  openManagedCopilotRuntime: (...args: unknown[]): Promise<FixtureRuntime> =>
    mockOpen(...args),
  assertCopilotConnectionGeneration: (...args: unknown[]): void =>
    mockCheckGeneration(...args),
}));
const mockMcpDigests = jest.fn((): Record<string, string> => ({}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    getMcpCapabilityDigests: mockMcpDigests,
  })),
}));
const mockProjection = jest.fn<CursorCapabilityProjection, []>();
const mockMaterialize = jest.fn<
  Promise<{ warnings: string[]; skillIds: string[]; commandIds: string[] }>,
  []
>();
jest.mock('../plugins/plugin-resolver', () => ({
  buildCursorCapabilityProjection: (): CursorCapabilityProjection =>
    mockProjection(),
}));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeSelectedCapabilityRoot: async (
    root: string,
  ): ReturnType<typeof mockMaterialize> => {
    await mkdir(root, { recursive: true });
    return mockMaterialize();
  },
}));
jest.mock('../agents/delegation/canopy-tools', () => ({
  delegateAppToolGuidance: (): string => '',
}));

let cwd: string;
let abort: AbortController;
let tools: DelegationNativePolicy;
let allowed: boolean;
let retainedReadRoots: string[];
let selectedMcpServers: Record<string, McpServerConfig>;
/** Per-test override of the status the fixture runtime reports for a server. */
let serverStatuses: Record<string, 'connected' | 'needs-auth' | 'failed'> = {};
const mockReportError = jest.fn();
const check = jest.fn(() => Promise.resolve({ decision: 'allow' as const }));
beforeEach(async () => {
  cwd = await realpath(await mkdtemp(join(tmpdir(), 'copilot-delegate-test-')));
  abort = new AbortController();
  allowed = true;
  retainedReadRoots = [];
  selectedMcpServers = {};
  serverStatuses = {};
  mockReportError.mockReset();
  jest.clearAllMocks();
  mockMcpDigests.mockReturnValue({});
  mockProjection.mockReturnValue({ skills: [], commands: [] });
  mockMaterialize.mockResolvedValue({
    warnings: [],
    skillIds: [],
    commandIds: [],
  });
  tools = createTools();
  await writeFile(join(cwd, 'evidence.txt'), 'evidence');
});
function createTools(
  writePaths: string[] = ['permitted.txt'],
  instructions?: string,
): DelegationNativePolicy {
  return new DelegationNativePolicy({
    cwd,
    writePaths,
    instructions,
    readRoots: retainedReadRoots,
    mcpServerNames: ['selected'],
    signal: abort.signal,
    delegationId: 'child',
    mode: (): 'full-access' => 'full-access',
    allowed: (): Promise<boolean> => Promise.resolve(allowed),
    approval: {
      check,
      setMode: jest.fn(),
      reevaluatePendingApprovals: (): Promise<void> => Promise.resolve(),
      dispose: jest.fn(),
    },
    emit: (): Promise<void> => Promise.resolve(),
  });
}
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const input = (toolName: string, toolArgs: unknown): CopilotPreToolInput => ({
  sessionId: 'session',
  timestamp: new Date(0),
  workingDirectory: cwd,
  toolName,
  toolArgs,
});

test('native reads, writes and every search root obey live child grants above Full access', async () => {
  const decide = (name: string, args: unknown): Promise<CopilotToolDecision> =>
    authorizeDelegatedCopilotTool(
      input(name, args),
      tools,
      abort.signal,
      'call',
    );
  expect(await decide('view', { path: 'evidence.txt' })).toEqual({
    decision: 'allow',
  });
  expect(await decide('view', { path: '/outside/evidence.txt' })).toEqual({
    decision: 'deny',
  });
  expect(
    await decide('create', { path: 'ungranted.txt', file_text: 'no' }),
  ).toEqual({ decision: 'deny' });
  expect(
    await decide('create', { path: 'permitted.txt', file_text: 'yes' }),
  ).toEqual({ decision: 'allow' });
  expect(
    await decide('grep', { pattern: 'evidence', paths: [cwd, '/outside'] }),
  ).toEqual({ decision: 'deny' });
  expect(await decide('task', { prompt: 'escape' })).toEqual({
    decision: 'deny',
  });
  allowed = false;
  expect(await decide('view', { path: 'evidence.txt' })).toEqual({
    decision: 'deny',
  });
  abort.abort();
  expect(await decide('list_bash', {})).toEqual({ decision: 'deny' });
});

function nativeRuntime(
  options: { hold?: boolean; assistantText?: string } = {},
): ReturnType<typeof createCopilotNativeRuntime> {
  return createCopilotNativeRuntime({
    account,
    serverStatuses,
    ...options,
    openRuntime: (runtime) => mockOpen.mockResolvedValue(runtime),
  });
}
function request(resumeSessionId?: string): AgentRunRequest {
  return copilotRequest({
    cwd,
    signal: abort.signal,
    resumeSessionId,
    account,
  });
}

function transcriptHarness(): {
  port: InMemoryDelegationTranscriptPort;
  admitted: DelegationTranscriptChange[];
  firstAdmission: Promise<void>;
} {
  const port = new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
  });
  const admitted: DelegationTranscriptChange[] = [];
  let admit: () => void = () => undefined;
  const firstAdmission = new Promise<void>((resolve) => {
    admit = resolve;
  });
  const append = port.appendChanges.bind(port);
  jest
    .spyOn(port, 'appendChanges')
    .mockImplementation(async (input, signal) => {
      const result = await append(input, signal);
      if (result.ok) {
        admitted.push(...input.changes);
        admit();
      }
      return result;
    });
  return { port, admitted, firstAdmission };
}

function transcriptRequest(original: AgentRunRequest): AgentRunRequest {
  const target: DelegationTranscriptTarget = {
    kind: 'delegation',
    chatId: original.parent.chatId,
    delegationId: original.delegationId,
    runGeneration: original.runGeneration,
  };
  return { ...original, transcriptStream: { target } };
}

function retainedText(
  changes: readonly DelegationTranscriptChange[],
  text: string,
): boolean {
  return changes.some(
    ({ row }) =>
      row.final &&
      row.blocks.some((block) => block.type === 'text' && block.text === text),
  );
}

async function startStream(
  transcriptPort: InMemoryDelegationTranscriptPort,
): Promise<{
  runner: ReturnType<typeof createCopilotDelegationRunner>;
  handle: NativeRunHandle;
  terminal: Promise<AgentDelegationEvent['event']>;
}> {
  const runner = createCopilotDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'fixture',
        profileDir: join(cwd, 'private-profile'),
        tools,
        plugins: [],
        retainedReadRoots,
        mcpServers: selectedMcpServers,
      }),
    reportError: jest.fn(),
    transcriptPort,
  });
  let finish: (event: AgentDelegationEvent['event']) => void = () => undefined;
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    finish = resolve;
  });
  const handle = await runner.start(
    transcriptRequest(request()),
    ({ event }) => {
      if (event.type === 'terminal') finish(event);
      return Promise.resolve();
    },
  );
  return { runner, handle, terminal };
}
async function run(
  resumeSessionId?: string,
  thinkingLevel?: AgentRunRequest['route']['effectiveThinkingLevel'],
  prompt = 'Read evidence',
): Promise<{
  runner: ReturnType<typeof createCopilotDelegationRunner>;
  events: AgentDelegationEvent['event'][];
  terminal: Promise<AgentDelegationEvent['event']>;
}> {
  const runner = createCopilotDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'fixture',
        profileDir: join(cwd, 'private-profile'),
        tools,
        plugins: [],
        retainedReadRoots,
        mcpServers: selectedMcpServers,
      }),
    reportError: mockReportError,
  });
  const events: AgentDelegationEvent['event'][] = [];
  let finish!: (event: AgentDelegationEvent['event']) => void;
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    finish = resolve;
  });
  const original = request(resumeSessionId);
  const runRequest = {
    ...original,
    task: { ...original.task, prompt },
    route: { ...original.route, effectiveThinkingLevel: thinkingLevel },
  };
  await runner.start(runRequest, ({ event }) => {
    events.push(event);
    if (event.type === 'terminal') finish(event);
    return Promise.resolve();
  });
  return { runner, events, terminal };
}
test('retains identity, canonical transcript and usage across native resume', async () => {
  const first = nativeRuntime();
  const result = await run();
  expect(await result.terminal).toMatchObject({
    status: 'completed',
    finalText: 'Verified evidence',
    usage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 2 },
  });
  expect(result.events).toContainEqual({
    type: 'started',
    nativeSessionId: 'native-child',
  });
  expect(
    result.events.some(
      (event) =>
        event.type === 'transcript' &&
        event.items.some(
          (item) => item.type === 'text' && item.text === 'Verified evidence',
        ),
    ),
  ).toBe(true);
  expect(first.runtime.close).toHaveBeenCalled();
  const second = nativeRuntime();
  expect(await (await run('native-child')).terminal).toMatchObject({
    status: 'completed',
  });
  expect(second.runtime.client.resumeSession).toHaveBeenCalledWith(
    'native-child',
    expect.objectContaining({
      enableConfigDiscovery: false,
      enableFileHooks: false,
      mcpServers: {},
    }),
  );
});
test('rejects missing resume state instead of creating a fresh conversation', async () => {
  const f = nativeRuntime();
  expect(await (await run('missing')).terminal).toMatchObject({
    status: 'failed',
  });
  expect(f.sends).toHaveLength(0);
  expect(f.runtime.close).toHaveBeenCalled();
});

test('writes a versioned native session binding', async () => {
  nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  const saved: unknown = JSON.parse(
    await readFile(join(cwd, 'private-profile', 'host-session.json'), 'utf8'),
  );
  expect(saved).toMatchObject({ version: 3, sessionId: 'native-child' });
});

test('persists capability identity for a retained Copilot delegate', async () => {
  nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  const saved: unknown = JSON.parse(
    await readFile(join(cwd, 'private-profile', 'host-session.json'), 'utf8'),
  );
  expect(saved).toHaveProperty(
    'capabilitySnapshot.digest',
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
  expect(saved).toMatchObject({
    capabilitySnapshot: {
      version: 1,
    },
  });
});

test('rejects changed retained command instructions before resuming a delegate', async () => {
  const command = {
    id: 'review',
    markdown: 'Read the selected evidence',
    description: 'Review',
    label: 'Review',
  };
  mockProjection.mockReturnValue({ skills: [], commands: [command] });
  mockMaterialize.mockResolvedValue({
    warnings: [],
    skillIds: [],
    commandIds: ['review'],
  });
  nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  mockProjection.mockReturnValue({
    skills: [],
    commands: [{ ...command, markdown: 'Different instructions' }],
  });
  const next = nativeRuntime();
  expect(await (await run('native-child')).terminal).toMatchObject({
    status: 'failed',
  });
  expect(next.runtime.client.resumeSession).not.toHaveBeenCalled();
  expect(next.sends).toEqual([]);
  expect(next.runtime.close).toHaveBeenCalled();
});

test.each([
  { version: 1 },
  { version: 2 },
  { nativeToolSnapshot: undefined },
  { nativeToolSnapshot: { version: 1, digest: 'bad' } },
  { version: 99 },
  { capabilitySnapshot: undefined },
  { capabilitySnapshot: { version: 2, digest: 'a'.repeat(64) } },
  { capabilitySnapshot: { version: 1, digest: 'malformed' } },
  { runtimeVersion: undefined },
  { runtimeVersion: '0.0.0' },
])('rejects an unverifiable delegate binding: %j', async (changes) => {
  nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  const file = join(cwd, 'private-profile', 'host-session.json');
  const saved: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!saved || typeof saved !== 'object') throw new Error('Expected binding');
  await writeFile(file, JSON.stringify({ ...saved, ...changes }));
  const previous = await readFile(file, 'utf8');
  const next = nativeRuntime();
  expect(await (await run('native-child')).terminal).toMatchObject({
    status: 'failed',
  });
  expect(next.runtime.client.resumeSession).not.toHaveBeenCalled();
  expect(next.sends).toEqual([]);
  expect(await readFile(file, 'utf8')).toBe(previous);
  expect(next.runtime.close).toHaveBeenCalled();
});

test('resume refreshes owner-supplied write instructions and live authorization', async () => {
  nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  tools = createTools([]);
  const next = nativeRuntime();
  expect(await (await run('native-child')).terminal).toMatchObject({
    status: 'completed',
  });
  expect(next.configs[0]).toHaveProperty(
    'systemMessage.content',
    expect.stringContaining('Native file tools have read-only permissions.'),
  );
  expect(
    await authorizeDelegatedCopilotTool(
      input('create', { path: 'permitted.txt', file_text: 'no' }),
      tools,
      abort.signal,
      'resumed-write',
    ),
  ).toEqual({ decision: 'deny' });
});

test('retained file identity survives restaging but rejects changed bytes', async () => {
  const prepareFiles = async (
    directory: string,
    contents: string,
  ): Promise<void> => {
    await mkdir(directory);
    await writeFile(join(directory, 'instructions.md'), contents);
    retainedReadRoots = [directory];
    tools = createTools(
      ['permitted.txt'],
      `Read ${JSON.stringify(directory)}/instructions.md`,
    );
  };
  await prepareFiles(join(cwd, 'first-copy'), 'Retained instructions');
  nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  await prepareFiles(join(cwd, 'second-copy'), 'Retained instructions');
  nativeRuntime();
  expect(await (await run('native-child')).terminal).toMatchObject({
    status: 'completed',
  });
  await writeFile(
    join(cwd, 'second-copy', 'instructions.md'),
    'Changed instructions',
  );
  const next = nativeRuntime();
  expect(await (await run('native-child')).terminal).toMatchObject({
    status: 'failed',
  });
  expect(next.runtime.client.resumeSession).not.toHaveBeenCalled();
  expect(next.sends).toEqual([]);
});

test('rejects changed retained agent instructions before a resumed send', async () => {
  tools = createTools(['permitted.txt'], 'Original agent instructions');
  nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  tools = createTools(['permitted.txt'], 'Changed agent instructions');
  const next = nativeRuntime();
  expect(await (await run('native-child')).terminal).toMatchObject({
    status: 'failed',
  });
  expect(next.runtime.client.resumeSession).not.toHaveBeenCalled();
  expect(next.sends).toEqual([]);
});

test('fails by name when a selected MCP server needs sign-in', async () => {
  selectedMcpServers = {
    selected: { type: 'http', url: 'http://localhost/selected' },
  };
  serverStatuses.selected = 'needs-auth';
  const f = nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'failed' });
  expect(f.sends).toEqual([]);
  expect(mockReportError).toHaveBeenCalledWith(
    expect.objectContaining({
      message:
        'Copilot could not connect to the MCP server "selected" (needs-auth). Connect or deselect it, then run again.',
    }),
  );
});

test('rejects changed retained MCP authority before a resumed send', async () => {
  mockMcpDigests.mockReturnValue({ selected: 'a'.repeat(64) });
  nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  mockMcpDigests.mockReturnValue({ selected: 'b'.repeat(64) });
  const next = nativeRuntime();
  expect(await (await run('native-child')).terminal).toMatchObject({
    status: 'failed',
  });
  expect(next.runtime.client.resumeSession).not.toHaveBeenCalled();
  expect(next.sends).toEqual([]);
});

test.each([undefined, 99])(
  'rejects native binding version %s before resume',
  async (version) => {
    nativeRuntime();
    expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
    const bindingFile = join(cwd, 'private-profile', 'host-session.json');
    await writeFile(
      bindingFile,
      JSON.stringify({ version, sessionId: 'native-child', cwd, account }),
    );
    const next = nativeRuntime();
    expect(await (await run('native-child')).terminal).toMatchObject({
      status: 'failed',
    });
    expect(next.runtime.client.resumeSession).not.toHaveBeenCalled();
    expect(next.sends).toEqual([]);
    expect(next.runtime.close).toHaveBeenCalled();
  },
);

test.each(['off', 'ultra'] as const)(
  'omits SDK-unsupported delegated thinking value %s',
  async (level) => {
    const f = nativeRuntime();
    expect(await (await run(undefined, level)).terminal).toMatchObject({
      status: 'completed',
    });
    expect(f.configs[0].reasoningEffort).toBeUndefined();
  },
);

test.each(['grep', 'glob'] as const)(
  'denies native %s traversal of an allowed root containing private descendants',
  async (name) => {
    await mkdir(join(cwd, 'config'));
    await writeFile(join(cwd, 'config', 'credentials'), 'fixture-secret');
    await writeFile(join(cwd, 'server.key'), 'fixture-secret');
    const decide = (
      tool: string,
      args: unknown,
    ): Promise<CopilotToolDecision> =>
      authorizeDelegatedCopilotTool(
        input(tool, args),
        tools,
        abort.signal,
        'private-search',
      );
    expect(await decide('view', { path: 'config/credentials' })).toEqual({
      decision: 'deny',
    });
    expect(await decide('view', { path: 'server.key' })).toEqual({
      decision: 'deny',
    });
    const pattern = name === 'glob' ? '**/*' : 'fixture-secret';
    expect(await decide(name, { pattern, paths: [cwd] })).toEqual({
      decision: 'deny',
    });
    expect(await decide(name, { pattern })).toEqual({ decision: 'deny' });
  },
);

test('denies directory views that can list private descendants', async () => {
  await writeFile(join(cwd, 'server.key'), 'fixture-secret');
  expect(
    await authorizeDelegatedCopilotTool(
      input('view', { path: cwd }),
      tools,
      abort.signal,
      'directory-view',
    ),
  ).toEqual({ decision: 'deny' });
});

test('expands and advertises only successfully materialized selected commands', async () => {
  mockProjection.mockReturnValue({
    skills: [],
    commands: [
      {
        id: 'selected-review',
        markdown: '# Review files\n\nInspect $ARGUMENTS',
        description: 'Review files',
        label: 'Selected review',
      },
      {
        id: 'unavailable',
        markdown: 'Do not load this command',
        description: 'Unavailable',
        label: 'Unavailable',
      },
    ],
  });
  mockMaterialize.mockResolvedValue({
    warnings: [],
    skillIds: [],
    commandIds: ['selected-review'],
  });
  const f = nativeRuntime();
  expect(
    await (
      await run(undefined, undefined, '/selected-review evidence.txt')
    ).terminal,
  ).toMatchObject({ status: 'completed' });
  expect(f.sends).toEqual([
    'Managed delegated task:\n# Review files\n\nInspect evidence.txt',
  ]);
  expect(f.configs[0].systemMessage).toHaveProperty(
    'content',
    expect.stringContaining('/selected-review'),
  );
  expect(f.configs[0].systemMessage).toHaveProperty(
    'content',
    expect.stringContaining(
      join(
        cwd,
        'private-profile',
        'selected-capabilities',
        'commands',
        'selected-review.md',
      ),
    ),
  );
  expect(JSON.stringify(f.configs[0].systemMessage)).not.toContain(
    '/unavailable',
  );
});

test('does not expand a command the materializer did not load', async () => {
  mockProjection.mockReturnValue({
    skills: [],
    commands: [
      {
        id: 'unavailable',
        markdown: 'Do not load this command',
        description: 'Unavailable',
        label: 'Unavailable',
      },
    ],
  });
  const f = nativeRuntime();
  expect(
    await (
      await run(undefined, undefined, '/unavailable evidence.txt')
    ).terminal,
  ).toMatchObject({ status: 'completed' });
  expect(f.sends).toEqual([
    'Managed delegated task:\n/unavailable evidence.txt',
  ]);
  expect(JSON.stringify(f.configs[0].systemMessage)).not.toContain(
    '/unavailable',
  );
});

test.each([
  'read_bash',
  'list_bash',
  'stop_bash',
  'read_powershell',
  'list_powershell',
  'stop_powershell',
])(
  'revokes live authority for %s without requiring run cancellation',
  async (name) => {
    const args = name.startsWith('list_')
      ? {}
      : name.startsWith('read_')
        ? { shellId: 'owned-shell', delay: 0 }
        : { shellId: 'owned-shell' };
    const decide = (): Promise<CopilotToolDecision> =>
      authorizeDelegatedCopilotTool(
        input(name, args),
        tools,
        abort.signal,
        'shell-control',
      );
    expect(await decide()).toEqual({ decision: 'allow' });
    allowed = false;
    expect(abort.signal.aborted).toBe(false);
    expect(await decide()).toEqual({ decision: 'deny' });
  },
);

test('delegate persists the verified native table before the started event', async () => {
  const f = nativeRuntime();
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  expect(f.metadata).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(
      await readFile(join(cwd, 'private-profile', 'host-session.json'), 'utf8'),
    ),
  ).toHaveProperty(
    'nativeToolSnapshot.digest',
    expect.stringMatching(/^[a-f0-9]{64}$/),
  );
});

test('delegate rejects a changed native MCP schema without publishing or sending', async () => {
  selectedMcpServers = {
    selected: { type: 'http', url: 'http://localhost/selected' },
  };
  const metadata: CurrentToolMetadata = {
    name: 'selected-read',
    mcpServerName: 'selected',
    mcpToolName: 'read',
    description: 'Read evidence',
    input_schema: { type: 'object', properties: { value: { type: 'string' } } },
  };
  nativeRuntime().metadata.mockResolvedValue({ tools: [metadata] });
  expect(await (await run()).terminal).toMatchObject({ status: 'completed' });
  const file = join(cwd, 'private-profile', 'host-session.json');
  const saved = await readFile(file, 'utf8');
  const next = nativeRuntime();
  next.metadata.mockResolvedValue({
    tools: [
      {
        ...metadata,
        input_schema: {
          type: 'object',
          properties: { value: { type: 'number' } },
        },
      },
    ],
  });
  const resumed = await run('native-child');
  expect(await resumed.terminal).toMatchObject({ status: 'failed' });
  expect(resumed.events.some((event) => event.type === 'started')).toBe(false);
  expect(next.sends).toEqual([]);
  expect(await readFile(file, 'utf8')).toBe(saved);
});

test('delegate never publishes or sends with uninitialized native metadata', async () => {
  const f = nativeRuntime();
  f.metadata.mockResolvedValue({ tools: null });
  const result = await run();
  expect(await result.terminal).toMatchObject({ status: 'failed' });
  expect(result.events.some((event) => event.type === 'started')).toBe(false);
  expect(f.sends).toEqual([]);
  await expect(
    readFile(join(cwd, 'private-profile', 'host-session.json'), 'utf8'),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('delegate cancellation during native metadata cannot publish a binding or send', async () => {
  const f = nativeRuntime();
  f.metadata.mockImplementation(() => {
    abort.abort();
    return Promise.resolve({ tools: [] });
  });
  const result = await run();
  expect(await result.terminal).toMatchObject({ status: 'cancelled' });
  expect(result.events.some((event) => event.type === 'started')).toBe(false);
  expect(f.sends).toEqual([]);
  await expect(
    readFile(join(cwd, 'private-profile', 'host-session.json'), 'utf8'),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

test('keeps stream-backed Copilot rows when the legacy transcript preview budget is exceeded', async () => {
  const text = 'x'.repeat(DELEGATION_TRANSCRIPT_RECORDER_LIMITS.itemBytes + 1);
  nativeRuntime({ assistantText: text });
  const { port, admitted } = transcriptHarness();
  const result = await startStream(port);

  await expect(result.terminal).resolves.toMatchObject({ status: 'completed' });
  expect(retainedText(admitted, text)).toBe(true);
});

test('attributes rejected Copilot row admission to fatal transcript storage failure', async () => {
  nativeRuntime();
  const port = new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
  });
  jest.spyOn(port, 'appendChanges').mockResolvedValue({
    ok: false,
    error: {
      code: 'storage_failure',
      message: 'fixture storage failure',
      retryable: false,
    },
  });
  const result = await startStream(port);

  await expect(result.terminal).resolves.toMatchObject({
    status: 'failed',
    error: {
      code: 'runtime_error',
      message:
        'The delegated transcript could not be saved. Retained partial output is available.',
      retryable: false,
    },
  });
});

test('finalizes Copilot rows before a requested stop is acknowledged as cancellation', async () => {
  const text = 'cancelled Copilot partial';
  nativeRuntime({ hold: true, assistantText: text });
  const { port, admitted, firstAdmission } = transcriptHarness();
  const result = await startStream(port);
  await firstAdmission;
  await expect(
    result.runner.stop(result.handle, 'user_cancelled'),
  ).resolves.toEqual({ stopped: true });

  await expect(result.terminal).resolves.toMatchObject({ status: 'cancelled' });
  expect(retainedText(admitted, text)).toBe(true);
});
