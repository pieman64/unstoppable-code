import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { build } from 'esbuild';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpenCodeToolInput } from '@canopy/desktop-shared/node/opencode/runtime';
import { createOpenCodeSchemaValidator } from '@canopy/desktop-shared/node/opencode/schema-validation';
import { validateOpenCodeMcpSchema } from '../opencode/schema-validation';
import { snapshotOpenCodeMcpTools } from '../opencode/capability-snapshot';
import { DelegationNativePolicy } from '../agents/delegation/native-policy';
import {
  authorizeDelegatedOpenCodeTool,
  createOpenCodeDelegationRunner,
} from '../agents/delegation/opencode-runner';
import {
  runOpenCodeTurn,
  type OpenCodeTurnResult,
} from '@canopy/desktop-shared/node/opencode/turn-driver';
import {
  openCodeCapabilityDigest,
  readOpenCodeCapabilityBinding,
} from '@canopy/desktop-shared/node/opencode/capability-snapshot';
import { routeFixture } from '@canopy/desktop-shared/node/delegation/__tests__/fixtures';
import type { AgentRunRequest } from '@canopy/desktop-shared/node/delegation';
jest.mock('@canopy/desktop-shared/node/opencode/turn-driver', () => ({
  runOpenCodeTurn: jest.fn(),
}));
jest.mock('../opencode/connection', () => ({
  openManagedOpenCodeRuntime: jest.fn((options: { signal: AbortSignal }) =>
    Promise.resolve({
      signal: options.signal,
      executable: process.execPath,
      prefix: [
        join(
          __dirname,
          '../../../../../packages/desktop-shared/src/node/opencode/__tests__/fake-agent.mjs',
        ),
      ],
      env: process.env,
      generation: 1,
      close: (): Promise<void> => Promise.resolve(),
    }),
  ),
  assertOpenCodeConnectionGeneration: jest.fn(),
}));
jest.mock('../plugins/plugin-resolver', () => ({
  buildCursorCapabilityProjection: jest.fn(() => ({
    skills: [],
    commands: [],
  })),
}));
jest.mock('../agents/delegation/canopy-tools', () => ({
  delegateAppToolGuidance: (): string => '',
}));
jest.mock('../opencode/schema-validation', () => ({
  validateOpenCodeMcpSchema: jest.fn(),
}));
jest.mock('../opencode/capability-snapshot', () => ({
  snapshotOpenCodeMcpTools: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: jest.fn(() => ({
    registerCanopyWorktreeSessionRoute: (): Promise<void> => Promise.resolve(),
    unregisterCanopyWorktreeSessionRoute: (): void => undefined,
    getCanopyWorktreeMcpUrl: (): string => 'http://localhost:1234/fixture',
  })),
}));
const sharedFixtures = join(
  __dirname,
  '../../../../../packages/desktop-shared/src/node/opencode/__tests__',
);
let fixtureDirectory: string;
let fixtureBundle: string;
beforeAll(async () => {
  fixtureDirectory = await mkdtemp(
    join(tmpdir(), 'opencode-delegate-fixture-'),
  );
  const worker = join(fixtureDirectory, 'schema-worker.cjs');
  await build({
    entryPoints: [join(sharedFixtures, '../schema-validation-worker.ts')],
    outfile: worker,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  // Production resolves a bundled entry beside the main bundle; Jest needs its own real worker.
  jest
    .mocked(validateOpenCodeMcpSchema)
    .mockImplementation(createOpenCodeSchemaValidator(worker));
  fixtureBundle = join(fixtureDirectory, 'turn.cjs');
  // Compile once so each real ACP turn avoids starting the TypeScript loader.
  await build({
    entryPoints: [join(sharedFixtures, 'delegation-turn.fixture.ts')],
    outfile: fixtureBundle,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
});
afterAll(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});
let cwd: string;
let abort: AbortController;
let tools: DelegationNativePolicy;
let allowed: boolean;
const check = jest.fn(() => Promise.resolve({ decision: 'allow' as const }));

beforeEach(async () => {
  cwd = await realpath(
    await mkdtemp(join(tmpdir(), 'opencode-delegate-test-')),
  );
  abort = new AbortController();
  allowed = true;
  jest.clearAllMocks();
  jest.mocked(snapshotOpenCodeMcpTools).mockResolvedValue([]);
  tools = new DelegationNativePolicy({
    cwd,
    writePaths: ['permitted.txt'],
    mcpServerNames: ['selected'],
    signal: abort.signal,
    delegationId: 'child',
    mode: (): 'full-access' => 'full-access',
    allowed: (): Promise<boolean> => Promise.resolve(allowed),
    approval: { check, setMode: jest.fn(), dispose: jest.fn() },
    emit: (): Promise<void> => Promise.resolve(),
  });
  await writeFile(join(cwd, 'evidence.txt'), 'evidence');
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const input = (
  toolName: string,
  toolArgs: Record<string, unknown>,
): OpenCodeToolInput => ({
  sessionId: 'session',
  toolCallId: 'call',
  toolName,
  toolArgs,
});

test('delegation resume identity binds file content and grants, not materialization paths', async () => {
  const profileDir = join(cwd, 'profile');
  const mockTurn = jest.mocked(runOpenCodeTurn);
  const outcomes: OpenCodeTurnResult[] = [];
  mockTurn.mockImplementation(async (request, host) => {
    const inputFile = join(cwd, 'turn-input.json');
    await writeFile(
      inputFile,
      JSON.stringify({
        cwd: request.cwd,
        profileDir: request.profileDir,
        capabilityContext: request.capabilityContext,
        sessionId: request.sessionId,
      }),
    );
    // ACP's ESM client runs in a real Node process, as in the shared scenarios.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [fixtureBundle, inputFile, join(sharedFixtures, 'fake-agent.mjs')],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    const value: unknown = JSON.parse(stdout);
    const result = z
      .object({
        sessionId: z.string().optional(),
        responseText: z.string(),
        isError: z.boolean(),
        cancelled: z.boolean(),
        message: z.string(),
      })
      .parse(value);
    if (!result.isError && result.sessionId) {
      const binding = await readOpenCodeCapabilityBinding(
        profileDir,
        result.sessionId,
      );
      if (!binding) throw new Error('Missing capability binding');
      await host.onSession?.(result.sessionId, binding);
    }
    outcomes.push(result);
    return result;
  });
  const capture = async (
    content: string,
    writePaths: string[],
  ): Promise<Parameters<typeof runOpenCodeTurn>[0]> => {
    const root = await mkdtemp(join(cwd, 'delegated-agent-files-'));
    await writeFile(join(root, 'AGENT.md'), content);
    const policy = new DelegationNativePolicy({
      cwd,
      writePaths,
      readRoots: [root],
      instructions: `Read ${root}/AGENT.md.`,
      signal: abort.signal,
      delegationId: 'child',
      mode: (): 'full-access' => 'full-access',
      allowed: (): Promise<boolean> => Promise.resolve(true),
      approval: { check, setMode: jest.fn(), dispose: jest.fn() },
      emit: (): Promise<void> => Promise.resolve(),
    });
    const reportError = jest.fn();
    const runner = createOpenCodeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'fixture/model',
          profileDir,
          tools: policy,
          retainedReadRoots: [root],
          plugins: [],
          mcpServers: {},
        }),
      reportError,
    });
    const request: AgentRunRequest = {
      delegationId: 'child',
      runGeneration: 1,
      launchKey: 'launch',
      parent: {
        harnessId: 'claude',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'parent',
        runtimeGeneration: 1,
        depth: 0,
        turnId: 'turn',
        toolCallId: 'spawn',
      },
      task: {
        modelId: 'opencode:fixture/model',
        description: 'read',
        prompt: 'read',
        deliveryMode: 'background',
      },
      route: routeFixture({
        harnessId: 'opencode',
        runtimeKind: 'opencode-acp',
        runtimeModelId: 'opencode:fixture/model',
      }),
      cwd,
      effectivePermission: 'read-only',
      ...(mockTurn.mock.calls.length
        ? { resumeSessionId: 'opencode-fixture' }
        : {}),
      signal: abort.signal,
    };
    let finish = (): void => {};
    const terminal = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await runner.start(request, ({ event }) => {
      if (event.type === 'terminal') finish();
      return Promise.resolve();
    });
    await terminal;
    expect(reportError).not.toHaveBeenCalled();
    expect(outcomes.at(-1)).toBeDefined();
    const turn = mockTurn.mock.calls.at(-1)?.[0];
    expect(turn).toBeDefined();
    if (!turn) throw new Error('Missing turn');
    expect(turn.instructions).toContain(root);
    return turn;
  };
  const first = await capture('same content', ['permitted.txt']);
  const resumed = await capture('same content', ['permitted.txt']);
  expect(openCodeCapabilityDigest(resumed.capabilityContext)).toBe(
    openCodeCapabilityDigest(first.capabilityContext),
  );
  expect(resumed.instructions).not.toBe(first.instructions);
  expect(resumed.sessionId).toBe('opencode-fixture');
  expect(outcomes[0]).toMatchObject({
    isError: false,
  });
  expect(outcomes[1]).toMatchObject({
    isError: false,
  });
  const changed = await capture('changed content', ['permitted.txt']);
  expect(openCodeCapabilityDigest(changed.capabilityContext)).not.toBe(
    openCodeCapabilityDigest(first.capabilityContext),
  );
  expect(outcomes[2]?.isError).toBe(true);
  expect(outcomes[2]?.message).toMatch(/capabilities changed/i);
  const grants = await capture('same content', ['different.txt']);
  expect(openCodeCapabilityDigest(grants.capabilityContext)).not.toBe(
    openCodeCapabilityDigest(first.capabilityContext),
  );
  expect(outcomes[3]?.isError).toBe(true);
  expect(outcomes[3]?.message).toMatch(/capabilities changed/i);
});

test('native reads, writes and every search root obey live child grants above Full access', async () => {
  const decide = (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ decision: 'allow' | 'deny' }> =>
    authorizeDelegatedOpenCodeTool(input(name, args), tools, abort.signal);
  expect(await decide('read', { filePath: 'evidence.txt' })).toEqual({
    decision: 'allow',
  });
  expect(await decide('read', { filePath: '/outside/evidence.txt' })).toEqual({
    decision: 'deny',
  });
  expect(
    await decide('write', { filePath: 'ungranted.txt', content: 'no' }),
  ).toEqual({ decision: 'deny' });
  expect(
    await decide('write', { filePath: 'permitted.txt', content: 'yes' }),
  ).toEqual({ decision: 'allow' });
  expect(
    await decide('grep', { pattern: 'evidence', paths: [cwd, '/outside'] }),
  ).toEqual({ decision: 'deny' });
  expect(await decide('task', { prompt: 'escape' })).toEqual({
    decision: 'deny',
  });
  allowed = false;
  expect(await decide('read', { filePath: 'evidence.txt' })).toEqual({
    decision: 'deny',
  });
  abort.abort();
  expect(await decide('bash', {})).toEqual({ decision: 'deny' });
});

test('patch moves require grants for every source and destination', async () => {
  const denied = await authorizeDelegatedOpenCodeTool(
    input('apply_patch', {
      patchText:
        '*** Begin Patch\n*** Update File: permitted.txt\n*** Move to: ungranted.txt\n@@\n-x\n+y\n*** End Patch',
    }),
    tools,
    abort.signal,
  );
  expect(denied).toEqual({ decision: 'deny' });
});

test('directory reads and private descendants cannot bypass file grants', async () => {
  await writeFile(join(cwd, 'server.key'), 'secret');
  for (const filePath of [cwd, join(cwd, 'server.key')])
    expect(
      await authorizeDelegatedOpenCodeTool(
        input('read', { filePath }),
        tools,
        abort.signal,
      ),
    ).toEqual({ decision: 'deny' });
});

// No subprocess is launched: exercise the real child policy with remembered allow.
test.each(['/Users', '/', '../other'])(
  'rejects a foreign Bash workdir %s before consulting approvals',
  async (workdir) => {
    expect(
      await authorizeDelegatedOpenCodeTool(
        input('bash', {
          command: 'rm -rf ryan',
          workdir,
        }),
        tools,
        abort.signal,
      ),
    ).toEqual({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
  },
);

test.each([undefined, '.', './nested/..'])(
  'keeps workspace Bash commands on the parent policy (%s)',
  async (workdir) => {
    expect(
      await authorizeDelegatedOpenCodeTool(
        input('bash', {
          command: 'printf fixture',
          ...(workdir === undefined ? {} : { workdir }),
        }),
        tools,
        abort.signal,
      ),
    ).toEqual({ decision: 'allow' });
    expect(check).toHaveBeenCalledWith(
      { kind: 'command', command: 'printf fixture', cwd },
      expect.anything(),
    );
  },
);

test.each(['allowed', 'policy-denied', 'invalid-input', 'collision'])(
  'delegated native MCP calls preserve raw policy identity and reject ambiguity: %s',
  async (scenario) => {
    jest.mocked(snapshotOpenCodeMcpTools).mockResolvedValue([
      {
        name: 'selected',
        identity: {},
        tools: (scenario === 'collision'
          ? ['files.read', 'files_read']
          : ['files.read']
        ).map((name) => ({
          name,
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false,
          },
        })),
      },
    ]);
    const policy = jest
      .spyOn(tools, 'canUseMcp')
      .mockResolvedValue(scenario !== 'policy-denied');
    const decisions: unknown[] = [];
    const displays: unknown[] = [];
    jest.mocked(runOpenCodeTurn).mockImplementation(async (_request, host) => {
      const args = { value: scenario === 'invalid-input' ? 42 : 'valid' };
      decisions.push(await host.authorize(input('selected_files_read', args)));
      displays.push(
        host.displayTool?.({ name: 'selected_files_read', input: args }),
      );
      return {
        responseText: 'done',
        isError: false,
        cancelled: false,
        message: '',
      };
    });
    const reportError = jest.fn();
    const runner = createOpenCodeDelegationRunner({
      available: () => Promise.resolve({ available: true }),
      prepare: () =>
        Promise.resolve({
          model: 'fixture/model',
          profileDir: join(cwd, 'profile'),
          tools,
          plugins: [],
          mcpServers: {
            selected: { type: 'http', url: 'http://127.0.0.1:1234/selected' },
          },
        }),
      reportError,
    });
    const request: AgentRunRequest = {
      delegationId: 'child',
      runGeneration: 1,
      launchKey: 'launch',
      parent: {
        harnessId: 'claude',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'parent',
        runtimeGeneration: 1,
        depth: 0,
        turnId: 'turn',
        toolCallId: 'spawn',
      },
      task: {
        modelId: 'opencode:fixture/model',
        description: 'read',
        prompt: 'read',
        deliveryMode: 'background',
      },
      route: routeFixture({
        harnessId: 'opencode',
        runtimeKind: 'opencode-acp',
        runtimeModelId: 'opencode:fixture/model',
      }),
      cwd,
      effectivePermission: 'read-only',
      signal: abort.signal,
    };
    let finish = (): void => {};
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    await runner.start(request, ({ event }) => {
      if (event.type === 'terminal') finish();
      return Promise.resolve();
    });
    await done;
    expect(reportError).not.toHaveBeenCalled();
    expect(decisions).toEqual([
      { decision: scenario === 'allowed' ? 'allow' : 'deny' },
    ]);
    if (scenario === 'allowed' || scenario === 'policy-denied') {
      expect(policy).toHaveBeenCalledTimes(1);
      expect(policy).toHaveBeenCalledWith(
        'selected',
        'files.read',
        expect.anything(),
      );
      expect(displays[0]).toMatchObject({ name: 'mcp__selected__files.read' });
    } else expect(policy).not.toHaveBeenCalled();
  },
);
