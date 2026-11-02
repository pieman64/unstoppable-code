import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import type { DelegationParent } from '@canopy/desktop-shared/node/delegation/parent';
import type {
  CursorTurnHost,
  CursorTurnRequest,
  CursorTurnResult,
} from '@canopy/desktop-shared/node/cursor/turn-driver';
import { DelegationNativePolicy } from '../agents/delegation/native-policy';
import {
  authorizeDelegatedCursorTool,
  createCursorDelegationRunner,
} from '../agents/delegation/cursor-runner';
import { DELEGATION_TRANSCRIPT_RECORDER_LIMITS } from '../agents/delegation/transcript-recorder';
import {
  request as cursorRequest,
  success,
} from './helpers/delegation-runner-fixtures/cursor';

const mockTurn = jest.fn<
  Promise<CursorTurnResult>,
  [CursorTurnRequest, CursorTurnHost]
>();
const mockUnregister = jest.fn();
const mockRuntime = jest.fn().mockResolvedValue({
  launch: { command: '/managed/cursor', args: [] },
  env: { PATH: '/usr/bin', HOME: '/private/home' },
  target: { hookRuntime: 'node' },
});
jest.mock('@canopy/desktop-shared/node/cursor/turn-driver', () => ({
  runCursorTurn: (
    ...args: [CursorTurnRequest, CursorTurnHost]
  ): Promise<CursorTurnResult> => mockTurn(...args),
}));
jest.mock('../cursor/connection', () => ({
  getManagedCursorRuntime: (...args: unknown[]): unknown =>
    mockRuntime(...args),
}));
jest.mock('../cursor/approval-check', () => ({
  verifyCursorVersion: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): unknown => ({
    unregisterCanopyWorktreeSessionRoute: mockUnregister,
  }),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  buildCursorCapabilityProjection: (): unknown => ({
    skills: [],
    commands: [],
  }),
}));
jest.mock('@canopy/desktop-shared/node/cursor/capability-root', () => ({
  materializeCursorCapabilityRoot: (): Promise<unknown> =>
    Promise.resolve({
      warnings: [],
      skillIds: [],
      commandIds: [],
    }),
}));
jest.mock('../agents/delegation/canopy-tools', () => ({
  delegateAppToolGuidance: (): string => '',
}));

let cwd: string;
let profileDir: string;
let abort: AbortController;
let allowed: boolean;
let tools: DelegationNativePolicy;
const check = jest.fn(() => Promise.resolve({ decision: 'allow' as const }));
beforeEach(async () => {
  cwd = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'cursor-delegate-test-')),
  );
  profileDir = path.join(cwd, 'private-profile');
  abort = new AbortController();
  allowed = true;
  check.mockClear();
  mockTurn.mockReset();
  mockUnregister.mockClear();
  tools = new DelegationNativePolicy({
    cwd,
    writePaths: ['permitted.txt'],
    mcpServerNames: ['selected-server'],
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
  await writeFile(path.join(cwd, 'evidence.txt'), 'evidence');
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

const payload = (name: string, input: unknown): Record<string, unknown> => ({
  hook_event_name: 'preToolUse',
  tool_name: name,
  tool_input: input,
  tool_use_id: `native-${name}`,
});
it('enforces file grants, unknown tools, live authority and cancellation above Full access', async () => {
  expect(
    await authorizeDelegatedCursorTool(
      payload('Read', { file_path: path.join(cwd, 'evidence.txt') }),
      tools,
      abort.signal,
    ),
  ).toEqual({ decision: 'allow' });
  expect(
    await authorizeDelegatedCursorTool(
      payload('Read', { file_path: '/outside/evidence.txt' }),
      tools,
      abort.signal,
    ),
  ).toEqual({ decision: 'deny' });
  expect(
    await authorizeDelegatedCursorTool(
      payload('Write', {
        file_path: path.join(cwd, 'ungranted.txt'),
        content: 'no',
      }),
      tools,
      abort.signal,
    ),
  ).toEqual({ decision: 'deny' });
  expect(
    await authorizeDelegatedCursorTool(
      payload('Task', { prompt: 'escape' }),
      tools,
      abort.signal,
    ),
  ).toEqual({ decision: 'deny' });
  expect(
    await authorizeDelegatedCursorTool(
      payload('Shell', { command: 'pwd', cwd: '/outside' }),
      tools,
      abort.signal,
    ),
  ).toEqual({ decision: 'deny' });
  allowed = false;
  expect(
    await authorizeDelegatedCursorTool(
      payload('Read', { file_path: path.join(cwd, 'evidence.txt') }),
      tools,
      abort.signal,
    ),
  ).toEqual({ decision: 'deny' });
  abort.abort();
  expect(
    await authorizeDelegatedCursorTool(
      payload('MCP:ReadMemory', {}),
      tools,
      abort.signal,
    ),
  ).toEqual({ decision: 'deny' });
});

it('denies native traversal that could expose private files beneath an allowed root', async () => {
  await writeFile(path.join(cwd, 'auth.json'), '{"token":"secret"}');
  await writeFile(path.join(cwd, 'server.pem'), 'BEGIN PRIVATE KEY');
  for (const [name, input] of [
    ['Grep', { pattern: 'token', path: cwd }],
    ['Grep', { pattern: 'BEGIN', glob: '*.pem', path: cwd }],
    ['Glob', { glob_pattern: '*.txt', target_directory: cwd }],
    ['List', { file_path: cwd }],
    ['ReadLints', { file_path: path.join(cwd, 'evidence.txt') }],
  ] as const) {
    expect(
      await authorizeDelegatedCursorTool(
        payload(name, input),
        tools,
        abort.signal,
      ),
    ).toEqual({ decision: 'deny' });
  }
  expect(check).not.toHaveBeenCalled();
});

it('keeps direct Cursor file operations under child grants', async () => {
  expect(
    await authorizeDelegatedCursorTool(
      payload('Delete', { file_path: path.join(cwd, 'permitted.txt') }),
      tools,
      abort.signal,
    ),
  ).toEqual({ decision: 'allow' });
  for (const [name, input] of [
    ['Grep', { pattern: 'secret', file_path: '/outside' }],
    ['Glob', { glob_pattern: '*.txt', target_directory: '/outside' }],
    ['Glob', { glob_pattern: '../**/*', target_directory: cwd }],
    ['Delete', { file_path: path.join(cwd, 'evidence.txt') }],
    ['List', { file_path: '/outside' }],
    ['ReadLints', { file_path: '/outside/a.ts' }],
  ] as const) {
    expect(
      await authorizeDelegatedCursorTool(
        payload(name, input),
        tools,
        abort.signal,
      ),
    ).toEqual({ decision: 'deny' });
  }
});

function request(resumeSessionId?: string): AgentRunRequest {
  return cursorRequest({ cwd, signal: abort.signal, resumeSessionId });
}
async function run(
  resumeSessionId?: string,
  delegation?: DelegationParent,
): Promise<{
  runner: ReturnType<typeof createCursorDelegationRunner>;
  events: AgentDelegationEvent['event'][];
  terminal: Promise<AgentDelegationEvent['event']>;
}> {
  const runner = createCursorDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'default',
        profileDir,
        tools,
        plugins: [],
        mcpServers: {},
        bindMcpGates: (): void => undefined,
      }),
    reportError: jest.fn(),
    delegation: (): DelegationParent | undefined => delegation,
  });
  const events: AgentDelegationEvent['event'][] = [];
  let finish: (event: AgentDelegationEvent['event']) => void = () => undefined;
  const terminal = new Promise<AgentDelegationEvent['event']>((resolve) => {
    finish = resolve;
  });
  await runner.start(request(resumeSessionId), ({ event }) => {
    events.push(event);
    if (event.type === 'terminal') finish(event);
    return Promise.resolve();
  });
  return { runner, events, terminal };
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
  runner: ReturnType<typeof createCursorDelegationRunner>;
  handle: NativeRunHandle;
  terminal: Promise<AgentDelegationEvent['event']>;
}> {
  const runner = createCursorDelegationRunner({
    available: () => Promise.resolve({ available: true }),
    prepare: () =>
      Promise.resolve({
        model: 'default',
        profileDir,
        tools,
        plugins: [],
        mcpServers: {},
        bindMcpGates: (): void => undefined,
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
it('guides Cursor children toward only available native tools', async () => {
  let instructions = '';
  mockTurn.mockImplementation(async (_turn, host) => {
    const prompt = await host.beforePrompt({
      sessionId: 'native-child',
      contextLost: false,
      announce: () => undefined,
      mcp: {
        servers: [],
        notes: [],
        notices: [],
        appToolsAvailable: true,
        pluginServerNames: [],
      },
    });
    instructions = prompt.instructions;
    return success;
  });
  const result = await run();
  expect(await result.terminal).toMatchObject({ status: 'completed' });
  expect(instructions).toContain('Use native Read, Write, Delete, and Shell');
  expect(instructions).toContain(
    'Grep, Glob, List, and ReadLints are unavailable',
  );
});
it('detaches child tool bindings without cancelling nested delegates on completion', async () => {
  const detach = jest.fn();
  const close = jest.fn(() => Promise.resolve());
  mockTurn.mockResolvedValue(success);
  const result = await run(undefined, {
    detach,
    close,
  } as unknown as DelegationParent);
  expect(await result.terminal).toMatchObject({ status: 'completed' });
  expect(detach).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
});
it('retains native identity, transcript and usage and requires exact native resume', async () => {
  mockTurn.mockImplementation(async (turn, host) => {
    expect(turn).toMatchObject({
      rawModelId: 'default',
      sessionId: 'retained-child',
      requireExistingSession: true,
      thinkingLevel: 'high',
    });
    expect(turn.profileDir).toBe(profileDir);
    await host.beforePrompt({
      sessionId: 'native-child',
      contextLost: false,
      announce: () => undefined,
      mcp: {
        servers: [],
        notes: [],
        notices: [],
        appToolsAvailable: true,
        pluginServerNames: [],
      },
    });
    await host.emit({
      type: 'canopy_assistant_patch',
      messageId: 'answer',
      patches: [
        { index: 0, block: { type: 'text', text: 'Verified evidence' } },
      ],
    });
    const cleanup = host.cleanup?.();
    expect(cleanup).toBeInstanceOf(Promise);
    await cleanup;
    await host.onUsage?.({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
    });
    return success;
  });
  const result = await run('retained-child');
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
  expect(mockUnregister).toHaveBeenCalled();
});
it('waits for Cursor process cleanup before acknowledging stop', async () => {
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let drained = false;
  mockTurn.mockImplementation(async (turn) => {
    entered();
    await new Promise<void>((resolve) =>
      turn.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    drained = true;
    return { ...success, cancelled: true };
  });
  const result = await run();
  await started;
  await result.runner.stop({ runId: 'child' }, 'user_cancelled');
  expect(drained).toBe(true);
  expect(await result.terminal).toMatchObject({ status: 'cancelled' });
  expect(mockUnregister).toHaveBeenCalled();
});

it('admits selected MCP at ACP without duplicating the execution-time approval', async () => {
  mockTurn.mockImplementation(async (_turn, host) => {
    const native = { toolCallId: 'mcp-call', signal: abort.signal };
    const call = { server: 'selected-server', tool: 'echo', args: {} };
    await expect(host.authorizeMcp(call, native)).resolves.toEqual({
      decision: 'allow',
    });
    expect(check).not.toHaveBeenCalled();
    await expect(
      host.authorizeMcp({ ...call, server: 'unknown' }, native),
    ).resolves.toEqual({ decision: 'deny' });
    allowed = false;
    await expect(host.authorizeMcp(call, native)).resolves.toEqual({
      decision: 'deny',
    });
    return success;
  });
  const running = await run();
  expect(await running.terminal).toMatchObject({ status: 'completed' });
});

it('keeps stream-backed Cursor rows when the legacy transcript preview budget is exceeded', async () => {
  const text = 'x'.repeat(DELEGATION_TRANSCRIPT_RECORDER_LIMITS.itemBytes + 1);
  const secondText = 'second canonical row';
  mockTurn.mockImplementation(async (_turn, host) => {
    await host.emit({
      type: 'canopy_assistant_patch',
      role: 'assistant',
      messageId: 'large-answer',
      timestamp: 0,
      patches: [
        { index: 0, block: { type: 'text', text } },
        { index: 1, block: { type: 'text', text: secondText } },
      ],
    });
    return success;
  });
  const { port, admitted } = transcriptHarness();
  const appendChanges = jest.spyOn(port, 'appendChanges');
  const result = await startStream(port);

  await expect(result.terminal).resolves.toMatchObject({ status: 'completed' });
  expect(appendChanges).toHaveBeenCalled();
  expect(retainedText(admitted, text)).toBe(true);
  expect(retainedText(admitted, secondText)).toBe(true);
});

it('attributes rejected Cursor row admission to fatal transcript storage failure', async () => {
  mockTurn.mockImplementation(async (_turn, host) => {
    await host.emit({
      type: 'canopy_assistant_patch',
      role: 'assistant',
      messageId: 'storage-answer',
      timestamp: 0,
      patches: [{ index: 0, block: { type: 'text', text: 'pending' } }],
    });
    return success;
  });
  const port = new InMemoryDelegationTranscriptPort({
    owns: (): boolean => true,
  });
  const appendChanges = jest.spyOn(port, 'appendChanges');
  appendChanges.mockResolvedValue({
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
  expect(mockTurn).toHaveBeenCalledTimes(1);
  expect(appendChanges).toHaveBeenCalled();
});

it('finalizes Cursor rows before a requested stop is acknowledged as cancellation', async () => {
  const text = 'cancelled Cursor partial';
  let emitted: () => void = () => undefined;
  const patchEmitted = new Promise<void>((resolve) => {
    emitted = resolve;
  });
  mockTurn.mockImplementation(async (turn, host) => {
    await host.emit({
      type: 'canopy_assistant_patch',
      role: 'assistant',
      messageId: 'cancelled-answer',
      timestamp: 0,
      patches: [{ index: 0, block: { type: 'text', text } }],
    });
    emitted();
    await new Promise<void>((resolve) =>
      turn.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return { ...success, cancelled: true };
  });
  const { port, admitted } = transcriptHarness();
  const result = await startStream(port);
  await patchEmitted;
  await expect(
    result.runner.stop(result.handle, 'user_cancelled'),
  ).resolves.toEqual({ stopped: true });

  await expect(result.terminal).resolves.toMatchObject({ status: 'cancelled' });
  expect(retainedText(admitted, text)).toBe(true);
});
