import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  realpath,
  symlink,
  link,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  DELEGATION_NATIVE_CLAUDE_TOOLS,
  DelegationNativePolicy,
  commandForApproval,
  containsUnmanagedShellDetachment,
  delegatedToolDenialReason,
  trustedWindowsShells,
} from '../agents/delegation/native-policy';
import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import type { ApprovalCheck, ApprovalMode } from '@canopy/desktop-shared/types';
import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import type * as FsPromises from 'node:fs/promises';

const actualFsPromises =
  jest.requireActual<typeof FsPromises>('node:fs/promises');

let cwd: string;
let mode: ApprovalMode;
let generation: string;
let controller: AbortController;
const check = jest.fn<Promise<{ decision: 'allow' | 'deny' }>, [ApprovalCheck]>(
  () => Promise.resolve({ decision: 'allow' }),
);
const emit = jest.fn<Promise<void>, [AgentDelegationEvent['event']]>(() =>
  Promise.resolve(),
);
function policy(
  writePaths = ['src'],
  allowed = (): Promise<boolean> => Promise.resolve(true),
  writable = (): boolean => true,
): DelegationNativePolicy {
  return new DelegationNativePolicy({
    cwd,
    writePaths,
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed,
    writable,
    approval: {
      check,
      // The parent explicitly permits the ordinary test grant.
      evaluate: () => Promise.resolve('allow'),
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
}
beforeEach(async () => {
  cwd = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'native-delegation-policy-')),
  );
  await mkdir(path.join(cwd, 'src'));
  await writeFile(path.join(cwd, 'src/file.ts'), 'before');
  mode = 'auto';
  generation = '1';
  controller = new AbortController();
  check.mockReset().mockResolvedValue({ decision: 'allow' });
  emit.mockClear();
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
it.each(['ask', 'auto', 'full-access'] as const)(
  'routes Claude Bash through the parent %s policy, including commands outside file grants',
  async (approvalMode) => {
    mode = approvalMode;
    const tools = policy([]);
    const input = { command: 'git status --short' };
    await expect(tools.authorize('Bash', input, 'shell')).resolves.toBe(true);
    expect(check).toHaveBeenCalledWith(
      { kind: 'command', command: input.command, cwd },
      expect.objectContaining({ subagentId: 'child', toolUseId: 'shell' }),
    );
    await expect(tools.authorize('Bash', input, 'shell')).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
    check.mockResolvedValue({ decision: 'deny' });
    await expect(
      tools.authorize('Bash', { command: 'touch ../outside' }, 'denied'),
    ).resolves.toBe(false);
  },
);
it('allows Claude-managed background Bash through the parent command policy', async () => {
  await expect(
    policy().authorize(
      'Bash',
      { command: 'printf later > src/file.ts', run_in_background: true },
      'background-shell',
    ),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'command',
      command: 'printf later > src/file.ts',
    }),
    expect.objectContaining({ toolUseId: 'background-shell' }),
  );
  check.mockResolvedValue({ decision: 'deny' });
  await expect(
    policy().authorize(
      'Bash',
      { command: 'touch ../outside', run_in_background: true },
      'denied-background-shell',
    ),
  ).resolves.toBe(false);
});

it('lets a delegate stop its own background tasks and read their output', async () => {
  // The pinned CLI has no TaskOutput tool: output is read from the file the
  // Bash result reports, under a read root the host provides.
  expect(DELEGATION_NATIVE_CLAUDE_TOOLS).toContain('TaskStop');
  expect(DELEGATION_NATIVE_CLAUDE_TOOLS).not.toContain('TaskOutput');
  await expect(
    policy().authorize('TaskStop', { task_id: 'b3rngwsi0' }, 'task-stop'),
  ).resolves.toBe(true);
});

it('explains refused shell backgrounding and names the managed alternative', () => {
  expect(delegatedToolDenialReason('Bash', { command: 'sleep 1 &' })).toMatch(
    /run_in_background/,
  );
  expect(
    delegatedToolDenialReason('Bash', { command: 'nohup ./server' }),
  ).toMatch(/run_in_background/);
  expect(
    delegatedToolDenialReason('Bash', {
      command: 'sleep 1',
      run_in_background: true,
    }),
  ).toBeUndefined();
  expect(
    delegatedToolDenialReason('Read', { file_path: 'src/file.ts' }),
  ).toBeUndefined();
});

it('gates a selected MCP tool through the delegated parent approval and rejects ambient servers', async () => {
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: [],
    mcpServerNames: ['selected_review'],
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    approval: {
      check,
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
  await expect(
    tools.authorizeMcp(
      'selected_review',
      'review_evidence',
      { id: 1 },
      'mcp-1',
    ),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledWith(
    {
      kind: 'mcp',
      server: 'selected_review',
      tool: 'review_evidence',
    },
    expect.objectContaining({ subagentId: 'child', toolUseId: 'mcp-1' }),
  );
  check.mockClear();
  await expect(
    tools.authorizeMcp('ambient', 'read', {}, 'mcp-2'),
  ).resolves.toBe(false);
  expect(check).not.toHaveBeenCalled();
  controller.abort();
  await expect(
    tools.authorizeMcp('selected_review', 'review_evidence', {}, 'mcp-3'),
  ).resolves.toBe(false);
});

it('approves app-owned tools with the parent chat MCP identity', async () => {
  const tools = policy([]);
  await expect(
    tools.authorizeAppTool('canopy', 'SearchMemory', true, 'app-1'),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledWith(
    { kind: 'mcp', server: 'canopy', tool: 'SearchMemory' },
    expect.objectContaining({ subagentId: 'child', toolUseId: 'app-1' }),
  );
  check.mockResolvedValueOnce({ decision: 'deny' });
  await expect(
    tools.authorizeAppTool('canopy', 'SaveMemory', false, 'app-2'),
  ).resolves.toBe(false);
  controller.abort();
  check.mockClear();
  await expect(
    tools.authorizeAppTool('canopy', 'SearchMemory', true, 'app-3'),
  ).resolves.toBe(false);
  expect(check).not.toHaveBeenCalled();
});

it('keeps read-only app tools but blocks mutating ones while the parent plans', async () => {
  const tools = policy(
    [],
    (): Promise<boolean> => Promise.resolve(true),
    (): boolean => false,
  );
  await expect(
    tools.authorizeAppTool('canopy', 'QueryCodeGraph', true, 'plan-read'),
  ).resolves.toBe(true);
  check.mockClear();
  await expect(
    tools.authorizeAppTool('canopy', 'DispatchAction', false, 'plan-write'),
  ).resolves.toBe(false);
  expect(check).not.toHaveBeenCalled();
});

it('revokes an in-flight app tool approval when the parent mode changes', async () => {
  let release: ((result: { decision: 'allow' | 'deny' }) => void) | undefined;
  check.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = policy([]).authorizeAppTool(
    'canopy',
    'SaveMemory',
    false,
    'app-pending',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  mode = 'ask';
  release?.({ decision: 'allow' });
  await expect(pending).resolves.toBe(false);
});

it('revokes an in-flight selected MCP approval when the parent mode changes', async () => {
  let release: ((result: { decision: 'allow' | 'deny' }) => void) | undefined;
  check.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: [],
    mcpServerNames: ['selected_review'],
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    approval: {
      check,
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
  const pending = tools.authorizeMcp(
    'selected_review',
    'review_evidence',
    {},
    'mcp-pending',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  mode = 'ask';
  release?.({ decision: 'allow' });
  await expect(pending).resolves.toBe(false);
});

it('dedupes concurrent hook and canUseTool calls for one MCP tool_use id into a single approval check', async () => {
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: [],
    mcpServerNames: ['selected_review'],
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    approval: {
      check,
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
  const [fromHook, fromCanUseTool] = await Promise.all([
    tools.authorizeMcpToolUse(
      'selected_review',
      'review_evidence',
      { id: 1 },
      'mcp-dedupe',
    ),
    tools.authorizeMcpToolUse(
      'selected_review',
      'review_evidence',
      { id: 2 },
      'mcp-dedupe',
    ),
  ]);
  expect(fromHook).toBe(true);
  expect(fromCanUseTool).toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
  // A later call for the very same tool_use id also reuses the decision.
  await expect(
    tools.authorizeMcpToolUse(
      'selected_review',
      'review_evidence',
      {},
      'mcp-dedupe',
    ),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
});

it('asks again for each transport-gated MCP call, even when its JSON-RPC id repeats', async () => {
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: [],
    mcpServerNames: ['selected_review'],
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    approval: {
      check,
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
  // A proxied MCP client numbers its requests from 0 on every connection,
  // so after a capability reload a new call can reuse an earlier id.
  check.mockResolvedValueOnce({ decision: 'deny' });
  await expect(
    tools.authorizeMcp('selected_review', 'review_evidence', { q: 'a' }, '0'),
  ).resolves.toBe(false);
  await expect(
    tools.authorizeMcp('selected_review', 'review_evidence', { q: 'b' }, '0'),
  ).resolves.toBe(true);
  await expect(
    tools.authorizeMcp('selected_review', 'review_evidence', { q: 'c' }, '0'),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledTimes(3);
});

it('never reuses a decided MCP approval after the parent mode or rules change', async () => {
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: [],
    mcpServerNames: ['selected_review'],
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    approval: {
      check,
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
  await expect(
    tools.authorizeMcpToolUse(
      'selected_review',
      'review_evidence',
      {},
      'mcp-stale',
    ),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
  mode = 'ask';
  // The same tool_use id is permanently invalidated by the mode change; it
  // is never re-prompted (a fresh call would carry a fresh tool_use id).
  await expect(
    tools.authorizeMcpToolUse(
      'selected_review',
      'review_evidence',
      {},
      'mcp-stale',
    ),
  ).resolves.toBe(false);
  expect(check).toHaveBeenCalledTimes(1);
  mode = 'auto';
  generation = 'revoked';
  await expect(
    tools.authorizeMcpToolUse(
      'selected_review',
      'review_evidence',
      {},
      'mcp-stale',
    ),
  ).resolves.toBe(false);
  expect(check).toHaveBeenCalledTimes(1);
});

it('reads a function instructions option live, reflecting a mid-run capability reload', () => {
  let capabilityInstructions = 'initial capability instructions';
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: ['src'],
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    instructions: (): string => capabilityInstructions,
    approval: {
      check,
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
  expect(tools.instructions()).toContain('initial capability instructions');
  capabilityInstructions = 'reloaded capability instructions';
  expect(tools.instructions()).toContain('reloaded capability instructions');
  expect(tools.instructions()).not.toContain('initial capability instructions');
});

it('allows the selected Agent skill tool only through parent approval', async () => {
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: [],
    skillNames: ['reviewer:reviewer'],
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    approval: {
      check,
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
  await expect(
    tools.authorize('Skill', { skill: 'reviewer:reviewer' }, 'selected-skill'),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledWith(
    { kind: 'tool', toolName: 'Skill' },
    expect.objectContaining({
      subagentId: 'child',
      toolUseId: 'selected-skill',
    }),
  );
  check.mockClear();
  await expect(
    tools.authorize('Skill', { skill: 'code-review' }, 'ambient-skill'),
  ).resolves.toBe(false);
  expect(check).not.toHaveBeenCalled();
  await expect(
    policy([]).authorize('Skill', { skill: 'ambient' }, 'ambient-skill'),
  ).resolves.toBe(false);
});

it('requires parent command approval before a selected stdio MCP server starts', async () => {
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: [],
    mcpServerNames: ['selected_plugin'],
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    approval: {
      check,
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
  await expect(
    tools.authorizeMcpLaunch(
      'selected_plugin',
      '/usr/bin/node',
      ['/retained/plugin/server.js'],
      'launch-1',
    ),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'command',
      command: '/usr/bin/node /retained/plugin/server.js',
      cwd,
    }),
    expect.objectContaining({ subagentId: 'child', toolUseId: 'launch-1' }),
  );
  check.mockClear();
  await expect(
    tools.authorizeMcpLaunch('ambient', '/usr/bin/node', [], 'launch-2'),
  ).resolves.toBe(false);
  expect(check).not.toHaveBeenCalled();
});

it('includes the actual selected MCP working directory in startup approval', async () => {
  const tools = new DelegationNativePolicy({
    cwd,
    writePaths: [],
    mcpServerNames: ['selected_plugin'],
    mode: (): ApprovalMode => mode,
    signal: controller.signal,
    delegationId: 'child',
    allowed: (): Promise<boolean> => Promise.resolve(true),
    approval: {
      check,
      setMode: jest.fn(),
      policyContextKey: (): string => generation,
      dispose: jest.fn(),
    },
    emit,
  });
  await expect(
    tools.authorizeMcpLaunch(
      'selected_plugin',
      '/usr/bin/node',
      ['/retained/plugin/server.js'],
      'launch-cwd',
      undefined,
      '/retained/plugin',
    ),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'command',
      command:
        'cd /retained/plugin && /usr/bin/node /retained/plugin/server.js',
    }),
    expect.objectContaining({ toolUseId: 'launch-cwd' }),
  );
});

it.each([
  'sleep 1 &',
  'nohup ./payload',
  "'nohup' ./payload",
  'n\\ohup ./payload',
  'env TASK=child nohup ./payload',
  'sudo -u nobody setsid ./payload',
  'setsid ./payload',
  'printf ready & disown',
  'cd /tmp\nnohup ./payload',
  'cd /tmp\r\nsetsid ./payload',
  'printf ready\ndisown',
  "sh -c 'nohup sleep 600 >/tmp/delegated.log 2>&1 &'",
  'bash -lc "setsid ./payload"',
  "env TASK=child zsh -c 'disown'",
  "TASK=child bash -c 'nohup ./payload'",
])(
  'rejects shell-level detachment in delegated Claude Bash: %s',
  async (command) => {
    await expect(
      policy().authorize('Bash', { command }, 'detached-shell'),
    ).resolves.toBe(false);
    expect(check).not.toHaveBeenCalled();
  },
);

it.each([
  "printf '%s' 'safe & literal'",
  'printf safe \\& literal',
  'true && pwd',
  "bash -c 'printf safe'",
  'sh -c \'printf "%s" "safe & literal"\'',
])(
  'allows non-detaching ampersand syntax in delegated Claude Bash: %s',
  async (command) => {
    await expect(
      policy().authorize('Bash', { command }, 'foreground-shell'),
    ).resolves.toBe(true);
  },
);

it('permits approved Claude Bash whatever its write scope holds', async () => {
  await Promise.all(
    Array.from({ length: 70 }, (_, index) =>
      writeFile(path.join(cwd, 'src', `large-scope-${index}.ts`), 'before'),
    ),
  );
  await expect(
    policy().authorize('Bash', { command: 'pwd' }, 'large-shell-scope'),
  ).resolves.toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
});

it('rejects Claude Bash in read-only mode when no write paths were declared', async () => {
  const tools = policy(
    [],
    () => Promise.resolve(true),
    () => false,
  );
  await expect(
    tools.authorize(
      'Bash',
      { command: 'touch escaped.txt' },
      'read-only-shell',
    ),
  ).resolves.toBe(false);
  expect(check).not.toHaveBeenCalled();
});

it('revalidates a cached Claude approval after the asynchronous path check', async () => {
  let active = true;
  const tools = policy([], () => Promise.resolve(active));
  const input = { file_path: 'src/file.ts' };
  await expect(tools.authorize('Read', input, 'cached-read')).resolves.toBe(
    true,
  );
  const originalLstat = actualFsPromises.lstat;
  const lstatSpy = jest.spyOn(actualFsPromises, 'lstat');
  lstatSpy.mockImplementation(async (...args) => {
    const result = await originalLstat(...args);
    if (String(args[0]) === path.join(cwd, 'src/file.ts')) active = false;
    return result;
  });
  try {
    await expect(tools.authorize('Read', input, 'cached-read')).resolves.toBe(
      false,
    );
  } finally {
    lstatSpy.mockRestore();
  }
});

it('rechecks Claude ownership after the final asynchronous path check', async () => {
  let active = true;
  let completionPublished = false;
  const tools = policy([], () => Promise.resolve(active));
  emit.mockImplementation((event) => {
    if (event.type === 'approval' && !event.pending) completionPublished = true;
    return Promise.resolve();
  });
  const originalLstat = actualFsPromises.lstat;
  const lstatSpy = jest.spyOn(actualFsPromises, 'lstat');
  lstatSpy.mockImplementation(async (...args) => {
    const result = await originalLstat(...args);
    if (
      completionPublished &&
      String(args[0]) === path.join(cwd, 'src/file.ts')
    )
      active = false;
    return result;
  });
  try {
    await expect(
      tools.authorize('Read', { file_path: 'src/file.ts' }, 'final-path-race'),
    ).resolves.toBe(false);
  } finally {
    lstatSpy.mockRestore();
    emit.mockReset().mockResolvedValue(undefined);
  }
});
it('revokes Claude Bash approval when parent rules change or the child is cancelled', async () => {
  const tools = policy();
  check.mockImplementationOnce(() => {
    generation = '2';
    return Promise.resolve({ decision: 'allow' });
  });
  await expect(
    tools.authorize('Bash', { command: 'pwd' }, 'changed'),
  ).resolves.toBe(false);
  controller.abort();
  await expect(
    tools.authorize('Bash', { command: 'pwd' }, 'cancelled'),
  ).resolves.toBe(false);
  expect(check).toHaveBeenCalledTimes(1);
});

/** The 8.3 short form of an existing Windows path, or undefined when the
 * volume does not generate short names. */
function windowsShortPath(file: string): string | undefined {
  // Verbatim arguments: Node's quoting would otherwise reach `for` as `\"`.
  const short = execFileSync(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `"for %I in ("${file}") do @echo %~sI"`],
    { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true },
  ).trim();
  return short && short.toLowerCase() !== file.toLowerCase()
    ? short
    : undefined;
}

(process.platform === 'win32' ? it : it.skip)(
  'permits native reads when the worktree path uses Windows 8.3 short names',
  async () => {
    // Profiles whose names exceed eight characters give TEMP, and anything
    // created under it, a short-name spelling such as `C:\Users\CANOPY~2`.
    const long = path.join(cwd, 'long-directory-name');
    await mkdir(long);
    await writeFile(path.join(long, 'evidence.txt'), 'evidence');
    const short = windowsShortPath(long);
    if (!short) return;
    const originalCwd = cwd;
    cwd = short;
    try {
      const tools = policy([]);
      await expect(
        tools.authorize('Read', { file_path: 'evidence.txt' }, 'short-read'),
      ).resolves.toBe(true);
      await expect(
        tools.authorize(
          'Read',
          { file_path: path.join(short, 'evidence.txt') },
          'short-absolute-read',
        ),
      ).resolves.toBe(true);
    } finally {
      cwd = originalCwd;
    }
  },
);

it('permits native reads and approved edits without reading the edited file', async () => {
  const tools = policy();
  expect(
    await tools.authorize('Read', { file_path: 'src/file.ts' }, 'read'),
  ).toBe(true);
  expect(
    await tools.authorize(
      'Edit',
      { file_path: 'src/file.ts', old_string: 'before', new_string: 'after' },
      'edit',
    ),
  ).toBe(true);
  // Git and checkpoints track edits; the policy only publishes approvals.
  expect(emit.mock.calls.every(([event]) => event.type === 'approval')).toBe(
    true,
  );
});

it('rejects absolute and parent-traversing Glob patterns without an explicit path', async () => {
  const tools = policy();
  await expect(
    tools.authorize(
      'Glob',
      { pattern: path.join(path.dirname(cwd), '**', '*.pem') },
      'absolute-glob',
    ),
  ).resolves.toBe(false);
  await expect(
    tools.authorize('Glob', { pattern: '../**/*.pem' }, 'parent-glob'),
  ).resolves.toBe(false);
  expect(check).not.toHaveBeenCalled();
});

it.each([
  ['Write', 'binary', Buffer.from([0xff, 0xfe, 0x00])],
  ['Write', 'large', Buffer.from('x'.repeat(100 * 1024))],
  ['Edit', 'large', Buffer.from('x'.repeat(100 * 1024))],
] as const)(
  'allows a Claude %s to an existing %s file inside the write grant',
  async (tool, _kind, content) => {
    const target = path.join(cwd, 'src/existing.dat');
    await writeFile(target, content);
    await expect(
      policy().authorize(
        tool,
        tool === 'Edit'
          ? { file_path: target, old_string: 'x', new_string: 'y' }
          : { file_path: target, content: 'after' },
        'write',
      ),
    ).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(1);
  },
);

it('accepts a native Codex patch to a file larger than 64 KiB', async () => {
  const target = path.join(cwd, 'src/large.ts');
  await writeFile(target, 'x'.repeat(100 * 1024));
  const tools = policy();
  tools.observeCodex('item/started', {
    item: {
      type: 'fileChange',
      id: 'large-patch',
      changes: [{ path: target, kind: { type: 'update' } }],
    },
  });
  expect(
    await tools.approveCodex('item/fileChange/requestApproval', {
      itemId: 'large-patch',
    }),
  ).toEqual({ decision: 'accept' });
});

it.each(['ask', 'auto', 'full-access'] as const)(
  'checks native commands against the live parent %s policy before execution',
  async (selectedMode) => {
    mode = selectedMode;
    const tools = policy();
    const request = {
      kind: 'command',
      itemId: 'read',
      cwd,
      command: '/bin/cat src/file.ts',
    };
    expect(
      await tools.approveCodex(
        'item/commandExecution/requestApproval',
        request,
      ),
    ).toEqual({ decision: 'accept' });
    expect(check).toHaveBeenCalledWith(
      { kind: 'command', command: request.command, cwd },
      expect.objectContaining({
        subagentId: 'child',
        toolUseId: 'read',
        details: {
          kind: 'command',
          command: request.command,
          cwd,
        },
      }),
    );
    check.mockResolvedValueOnce({ decision: 'deny' });
    expect(
      await tools.approveCodex('item/commandExecution/requestApproval', {
        ...request,
        itemId: 'next',
      }),
    ).toEqual({ decision: 'decline' });
    expect(check).toHaveBeenCalledTimes(2);
  },
);

it.each(['mode', 'rules', 'cancel'] as const)(
  'declines a command approval after %s changes while pending',
  async (change) => {
    check.mockImplementationOnce(() => {
      if (change === 'mode') mode = 'ask';
      if (change === 'rules') generation = 'revoked';
      if (change === 'cancel') controller.abort();
      return Promise.resolve({ decision: 'allow' });
    });
    expect(
      await policy().approveCodex('item/commandExecution/requestApproval', {
        kind: 'command',
        itemId: 'pending',
        cwd,
        command: 'pwd',
      }),
    ).toEqual({ decision: 'decline' });
    expect(check).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['/bin/zsh -lc "cat \'src/file.ts\'"', "cat 'src/file.ts'"],
  ['/bin/zsh -c pwd', 'pwd'],
  ['/bin/bash -c \'echo "quoted value"\'', 'echo "quoted value"'],
  ["/bin/sh -c 'echo '\"'\"'literal'\"'\"''", "echo 'literal'"],
  ["/bin/zsh -c '/bin/sh -c pwd'", '/bin/sh -c pwd'],
])(
  'checks the actual command behind the single native envelope %s',
  async (command, expected) => {
    await policy().approveCodex('item/commandExecution/requestApproval', {
      kind: 'command',
      itemId: 'envelope',
      cwd,
      command,
    });
    expect(check).toHaveBeenCalledWith(
      { kind: 'command', command: expected, cwd },
      expect.anything(),
    );
    if (expected.startsWith('cat'))
      expect(
        evaluateApproval(
          { kind: 'command', command: expected },
          {
            mode: 'ask',
            rules: { session: [], project: [], global: [] },
            workspaceRoot: cwd,
          },
        ).outcome,
      ).toBe('prompt');
    if (expected.startsWith('/bin/sh'))
      expect(
        evaluateApproval(
          { kind: 'command', command: expected },
          {
            mode: 'ask',
            rules: { session: [], project: [], global: [] },
            workspaceRoot: cwd,
          },
        ).outcome,
      ).toBe('deny');
  },
);

it.each([
  '/bin/zsh -c "pwd" extra',
  '/bin/zsh -c pwd; echo hidden',
  '/bin/zsh -c "echo $HOME"',
  '/bin/zsh -c "echo `pwd`"',
  "/bin/zsh -c 'unterminated",
  '/bin/zsh -c "pwd"\n/bin/echo hidden',
])(
  'rejects a nonliteral or multi-argument native envelope %s',
  async (command) => {
    expect(
      await policy().approveCodex('item/commandExecution/requestApproval', {
        kind: 'command',
        itemId: 'envelope',
        cwd,
        command,
      }),
    ).toEqual({ decision: 'decline' });
    expect(check).not.toHaveBeenCalled();
  },
);

(process.platform === 'darwin' ? it : it.skip)(
  'accepts the native canonical spelling of a macOS workspace directory',
  async () => {
    const canonical = cwd;
    cwd = cwd.replace(/^\/private\/var\//, '/var/');
    expect(cwd).not.toBe(canonical);
    expect(
      await policy().approveCodex('item/commandExecution/requestApproval', {
        kind: 'command',
        itemId: 'canonical',
        cwd: canonical,
        command: 'pwd',
      }),
    ).toEqual({ decision: 'accept' });
  },
);

it('does not turn command approval into additional filesystem or network authority', async () => {
  const tools = policy();
  for (const extra of [
    { additionalPermissions: { fileSystem: { write: [cwd] } } },
    { networkApprovalContext: { host: 'example.com' } },
    { reason: 'Run outside the sandbox' },
    { environmentId: 'remote' },
    { kind: 'unknown' },
    { cwd: path.dirname(cwd) },
    { command: '' },
    { itemId: undefined },
  ]) {
    expect(
      await tools.approveCodex('item/commandExecution/requestApproval', {
        kind: 'command',
        itemId: 'forbidden',
        cwd,
        command: 'pwd',
        ...extra,
      }),
    ).toEqual({ decision: 'decline' });
  }
  expect(check).not.toHaveBeenCalled();
});

it('checks commands carrying an already-approved same-turn native write grant', async () => {
  const tools = policy();
  const identity = { threadId: 'thread', turnId: 'turn' };
  await tools.approveCodex('item/permissions/requestApproval', {
    ...identity,
    itemId: 'grant',
    permissions: { fileSystem: { write: [path.join(cwd, 'src')] } },
  });
  const request = {
    ...identity,
    kind: 'command',
    itemId: 'write',
    cwd,
    command: 'printf text > src/file.ts',
    additionalPermissions: {
      network: null,
      fileSystem: {
        read: null,
        write: [path.join(cwd, 'src/file.ts')],
        entries: [
          {
            path: { type: 'path', path: path.join(cwd, 'src/file.ts') },
            access: 'write',
          },
        ],
      },
    },
  };
  expect(
    await tools.approveCodex('item/commandExecution/requestApproval', request),
  ).toEqual({ decision: 'accept' });
  expect(check).toHaveBeenCalledTimes(2);
  check.mockResolvedValueOnce({ decision: 'deny' });
  expect(
    await tools.approveCodex('item/commandExecution/requestApproval', {
      ...request,
      itemId: 'denied',
    }),
  ).toEqual({ decision: 'decline' });
  expect(check).toHaveBeenCalledTimes(3);
  for (const replacement of [
    { turnId: 'other' },
    { threadId: 'other' },
    { additionalPermissions: { fileSystem: { write: [cwd] } } },
    {
      additionalPermissions: {
        fileSystem: { write: [path.join(cwd, 'src')], read: [cwd] },
      },
    },
    {
      additionalPermissions: {
        fileSystem: {
          write: [path.join(cwd, 'src')],
          entries: [{ path: { type: 'path', path: cwd }, access: 'write' }],
        },
      },
    },
    {
      additionalPermissions: {
        network: { enabled: true },
        fileSystem: { write: [path.join(cwd, 'src')] },
      },
    },
  ])
    expect(
      await tools.approveCodex('item/commandExecution/requestApproval', {
        ...request,
        ...replacement,
      }),
    ).toEqual({ decision: 'decline' });
  generation = 'changed';
  expect(
    await tools.approveCodex('item/commandExecution/requestApproval', request),
  ).toEqual({ decision: 'decline' });
  expect(check).toHaveBeenCalledTimes(3);
});
it.each(['rules', 'mode', 'cancel', 'owner'] as const)(
  'declines a Codex command when %s changes while its approval completion publishes',
  async (change) => {
    let active = true;
    const tools = policy(['src'], () => Promise.resolve(active));
    const identity = { threadId: 'thread', turnId: 'turn' };
    const sourceDirectory = path.join(cwd, 'src');
    await tools.approveCodex('item/permissions/requestApproval', {
      ...identity,
      itemId: 'grant-directory',
      permissions: { fileSystem: { write: [sourceDirectory] } },
    });
    emit.mockImplementation((event) => {
      if (event.type === 'approval' && !event.pending) {
        if (change === 'rules') generation = 'revoked';
        if (change === 'mode') mode = 'ask';
        if (change === 'cancel') controller.abort();
        if (change === 'owner') active = false;
      }
      return Promise.resolve();
    });
    try {
      await expect(
        tools.approveCodex('item/commandExecution/requestApproval', {
          ...identity,
          kind: 'command',
          itemId: 'write-directory',
          cwd,
          command: 'printf generated > src/generated.ts',
          additionalPermissions: { fileSystem: { write: [sourceDirectory] } },
        }),
      ).resolves.toEqual({ decision: 'decline' });
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      emit.mockReset().mockResolvedValue(undefined);
    }
  },
);

it.each(['claude', 'codex'] as const)(
  '%s rechecks command authority after publishing approval completion',
  async (harness) => {
    const tools = policy();
    emit.mockImplementation((event) => {
      if (event.type === 'approval' && !event.pending) generation = 'revoked';
      return Promise.resolve();
    });
    try {
      const result =
        harness === 'claude'
          ? await tools.authorize('Bash', { command: 'pwd' }, 'shell')
          : await tools.approveCodex('item/commandExecution/requestApproval', {
              kind: 'command',
              itemId: 'shell',
              cwd,
              command: 'pwd',
            });
      expect(result).toEqual(
        harness === 'claude' ? false : { decision: 'decline' },
      );
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      emit.mockReset().mockResolvedValue(undefined);
    }
  },
);

it('rechecks Codex ownership after the final asynchronous directory check', async () => {
  let active = true;
  let completionPublished = false;
  const tools = policy([], () => Promise.resolve(active));
  emit.mockImplementation((event) => {
    if (event.type === 'approval' && !event.pending) completionPublished = true;
    return Promise.resolve();
  });
  const originalLstat = actualFsPromises.lstat;
  const lstatSpy = jest.spyOn(actualFsPromises, 'lstat');
  lstatSpy.mockImplementation(async (...args) => {
    const result = await originalLstat(...args);
    if (completionPublished && String(args[0]) === cwd) active = false;
    return result;
  });
  try {
    await expect(
      tools.approveCodex('item/commandExecution/requestApproval', {
        kind: 'command',
        itemId: 'final-directory-race',
        cwd,
        command: 'pwd',
      }),
    ).resolves.toEqual({ decision: 'decline' });
  } finally {
    lstatSpy.mockRestore();
    emit.mockReset().mockResolvedValue(undefined);
  }
});

it('denies an Edit whose parent rules change while approval completion publishes', async () => {
  const tools = policy();
  emit.mockImplementation((event) => {
    if (event.type === 'approval' && !event.pending) generation = 'revoked';
    return Promise.resolve();
  });
  try {
    await expect(
      tools.authorize(
        'Edit',
        {
          file_path: 'src/file.ts',
          old_string: 'before',
          new_string: 'after',
        },
        'revoked-edit',
      ),
    ).resolves.toBe(false);
  } finally {
    emit.mockReset().mockResolvedValue(undefined);
  }
});

it('fails an Edit approval whose completion publication fails', async () => {
  const tools = policy();
  emit.mockImplementation((event) =>
    event.type === 'approval' && !event.pending
      ? Promise.reject(new Error('completion publication failed'))
      : Promise.resolve(),
  );
  try {
    await expect(
      tools.authorize(
        'Edit',
        {
          file_path: 'src/file.ts',
          old_string: 'before',
          new_string: 'after',
        },
        'failed-completion-edit',
      ),
    ).rejects.toThrow('completion publication failed');
  } finally {
    emit.mockReset().mockResolvedValue(undefined);
  }
});

it('rechecks live write eligibility after publishing Codex command approval', async () => {
  let writable = true;
  const tools = policy(
    ['src'],
    () => Promise.resolve(true),
    () => writable,
  );
  const identity = { threadId: 'thread', turnId: 'turn' };
  const sourceDirectory = path.join(cwd, 'src');
  await tools.approveCodex('item/permissions/requestApproval', {
    ...identity,
    itemId: 'grant-directory',
    permissions: { fileSystem: { write: [sourceDirectory] } },
  });
  emit.mockImplementation((event) => {
    if (event.type === 'approval' && !event.pending) writable = false;
    return Promise.resolve();
  });
  try {
    await expect(
      tools.approveCodex('item/commandExecution/requestApproval', {
        ...identity,
        kind: 'command',
        itemId: 'plan-mode-command',
        cwd,
        command: 'printf generated > src/generated.ts',
        additionalPermissions: {
          fileSystem: { write: [sourceDirectory] },
        },
      }),
    ).resolves.toEqual({ decision: 'decline' });
  } finally {
    emit.mockReset().mockResolvedValue(undefined);
  }
});

it('normalizes relative Codex write grants before returning them', async () => {
  const tools = policy();
  const sourceDirectory = path.join(cwd, 'src');
  await expect(
    tools.approveCodex('item/permissions/requestApproval', {
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'relative-grant',
      permissions: { fileSystem: { write: ['src'] } },
    }),
  ).resolves.toEqual({
    permissions: { fileSystem: { read: [], write: [sourceDirectory] } },
    scope: 'turn',
  });
});

it('rechecks Claude shell authority after publishing its approval', async () => {
  let checks = 0;
  const tools = policy(['src'], () => Promise.resolve(++checks < 2));
  await expect(
    tools.authorize(
      'Bash',
      { command: 'printf changed > src/file.ts' },
      'revoked-shell',
    ),
  ).resolves.toBe(false);
});
it('rechecks live write eligibility after publishing Claude shell approval', async () => {
  let writable = true;
  const tools = policy(
    ['src'],
    () => Promise.resolve(true),
    () => writable,
  );
  emit.mockImplementation((event) => {
    if (event.type === 'approval' && !event.pending) writable = false;
    return Promise.resolve();
  });
  try {
    await expect(
      tools.authorize('Bash', { command: 'pwd' }, 'plan-mode-shell'),
    ).resolves.toBe(false);
  } finally {
    emit.mockReset().mockResolvedValue(undefined);
  }
});

it('rejects hard-linked files for native reads and writes', async () => {
  const tools = policy();
  const externalDirectory = await mkdtemp(
    path.join(os.tmpdir(), 'native-delegation-hard-link-'),
  );
  const externalFile = path.join(externalDirectory, 'external.txt');
  const linkedFile = path.join(cwd, 'src/linked.txt');
  try {
    await writeFile(externalFile, 'external secret');
    await link(externalFile, linkedFile);

    await expect(
      tools.authorize('Read', { file_path: linkedFile }, 'read-hard-link'),
    ).resolves.toBe(false);
    await expect(
      tools.authorize(
        'Write',
        { file_path: linkedFile, content: 'replacement' },
        'write-hard-link',
      ),
    ).resolves.toBe(false);
  } finally {
    await rm(externalDirectory, { recursive: true, force: true });
  }
});
it('accepts a command whose directory grant holds more files than earlier capture allowed', async () => {
  const sourceDirectory = path.join(cwd, 'src');
  await Promise.all(
    Array.from({ length: 64 }, (_, index) =>
      writeFile(path.join(sourceDirectory, `existing-${index}.ts`), 'x'),
    ),
  );
  const tools = policy();
  const identity = { threadId: 'thread', turnId: 'turn' };
  await tools.approveCodex('item/permissions/requestApproval', {
    ...identity,
    itemId: 'grant-large-directory',
    permissions: { fileSystem: { write: [sourceDirectory] } },
  });
  await expect(
    tools.approveCodex('item/commandExecution/requestApproval', {
      ...identity,
      kind: 'command',
      itemId: 'write-large-directory',
      cwd,
      command: 'touch src/generated.ts',
      additionalPermissions: {
        network: null,
        fileSystem: {
          read: null,
          write: [sourceDirectory],
          entries: [
            {
              path: { type: 'path', path: sourceDirectory },
              access: 'write',
            },
          ],
        },
      },
    }),
  ).resolves.toEqual({ decision: 'accept' });
});
it('denies custom tools, recursion, shell escapes, ungranted paths and read-only writes', async () => {
  const tools = policy();
  for (const name of ['CustomTool', 'Agent', 'Bash'])
    expect(
      await tools.authorize(name, { file_path: 'src/file.ts' }, name),
    ).toBe(false);
  for (const file of ['../outside', '.env', '.git/config', 'other/file.ts'])
    expect(await tools.authorize('Write', { file_path: file }, file)).toBe(
      false,
    );
  expect(
    await policy([]).authorize(
      'Write',
      { file_path: 'src/file.ts' },
      'readonly',
    ),
  ).toBe(false);
  expect(
    await tools.approveCodex('item/commandExecution/requestApproval', {
      command: 'touch /tmp/escape',
    }),
  ).toEqual({ decision: 'decline' });
});
it('denies symlink paths and revocations while native approval is pending', async () => {
  await symlink(os.tmpdir(), path.join(cwd, 'src/link'));
  expect(
    await policy().authorize('Read', { file_path: 'src/link/private' }, 'link'),
  ).toBe(false);
  check.mockImplementationOnce(() => {
    generation = '2';
    return Promise.resolve({ decision: 'allow' });
  });
  expect(
    await policy().authorize(
      'Write',
      { file_path: 'src/file.ts' },
      'changed-rules',
    ),
  ).toBe(false);
  check.mockImplementationOnce(() => {
    mode = 'ask';
    return Promise.resolve({ decision: 'allow' });
  });
  expect(
    await policy().authorize(
      'Write',
      { file_path: 'src/file.ts' },
      'changed-mode',
    ),
  ).toBe(false);
});
it('limits native Codex patch approval to every observed file including rename destinations', async () => {
  const tools = policy();
  tools.observeCodex('item/started', {
    item: {
      type: 'fileChange',
      id: 'patch',
      changes: [
        {
          path: path.join(cwd, 'src/file.ts'),
          kind: { type: 'update', move_path: path.join(cwd, 'outside.ts') },
        },
      ],
    },
  });
  expect(
    await tools.approveCodex('item/fileChange/requestApproval', {
      itemId: 'patch',
    }),
  ).toEqual({ decision: 'decline' });
  expect(
    await tools.approveCodex('item/fileChange/requestApproval', {
      itemId: 'unknown',
    }),
  ).toEqual({ decision: 'decline' });
  tools.observeCodex('item/started', {
    item: {
      type: 'fileChange',
      id: 'patch',
      changes: [
        {
          path: path.join(cwd, 'src/file.ts'),
          kind: { type: 'update', move_path: null },
        },
      ],
    },
  });
  expect(
    await tools.approveCodex('item/fileChange/requestApproval', {
      itemId: 'patch',
    }),
  ).toEqual({ decision: 'accept' });
});
it('refuses network and read expansion through native permission requests', async () => {
  const tools = policy();
  for (const permissions of [
    {
      network: { enabled: true },
      fileSystem: { read: [], write: [path.join(cwd, 'src')] },
    },
    { fileSystem: { read: ['/'], write: [path.join(cwd, 'src')] } },
    { fileSystem: { read: [], write: ['/tmp'] } },
  ]) {
    expect(
      await tools.approveCodex('item/permissions/requestApproval', {
        permissions,
      }),
    ).toEqual({ permissions: {}, scope: 'turn' });
  }
});

it('reuses one native call approval across the SDK hook and permission callback, while rechecking revocation', async () => {
  const tools = policy();
  const input = { file_path: 'src/file.ts', content: 'replacement' };
  expect(await tools.authorize('Write', input, 'same-call')).toBe(true);
  expect(
    await tools.authorize(
      'Write',
      { ...input, file_path: path.join(cwd, 'src/file.ts') },
      'same-call',
    ),
  ).toBe(true);
  expect(check).toHaveBeenCalledTimes(1);
  generation = 'revoked';
  expect(await tools.authorize('Write', input, 'same-call')).toBe(false);
});

it.each(['permissions', 'fileChange'])(
  'honors descendant deny rules for native %s grants in Auto',
  async (kind) => {
    check.mockImplementationOnce((input) => {
      const evaluation = evaluateApproval(input, {
        mode: 'auto',
        workspaceRoot: cwd,
        rules: {
          session: [
            {
              id: 'protected',
              behavior: 'deny',
              target: {
                kind: 'file-write',
                path: path.join(cwd, 'src/file.ts'),
              },
              origin: 'settings',
              createdAt: '2026-09-16T00:00:00.000Z',
            },
          ],
          project: [],
          global: [],
        },
      });
      return Promise.resolve({
        decision: evaluation.outcome === 'allow' ? 'allow' : 'deny',
      });
    });
    const request =
      kind === 'permissions'
        ? {
            itemId: 'grant',
            permissions: { fileSystem: { write: [path.join(cwd, 'src')] } },
          }
        : { itemId: 'grant', grantRoot: path.join(cwd, 'src') };
    expect(
      await policy().approveCodex(`item/${kind}/requestApproval`, request),
    ).toEqual(
      kind === 'permissions'
        ? { permissions: {}, scope: 'turn' }
        : { decision: 'decline' },
    );
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'file-write', isGrant: true }),
      expect.anything(),
    );
  },
);

it('does not reuse an individual edit approval for a later permission grant', async () => {
  const tools = policy();
  expect(
    await tools.authorize('Write', { file_path: 'src/file.ts' }, 'same-call'),
  ).toBe(true);
  check.mockResolvedValueOnce({ decision: 'deny' });
  expect(
    await tools.approveCodex('item/permissions/requestApproval', {
      itemId: 'same-call',
      permissions: { fileSystem: { write: [path.join(cwd, 'src/file.ts')] } },
    }),
  ).toEqual({ permissions: {}, scope: 'turn' });
  expect(check).toHaveBeenCalledTimes(2);
});

describe('containsUnmanagedShellDetachment on Windows', () => {
  it('rejects Git Bash, cmd and PowerShell launchers that outlive the command', () => {
    for (const command of [
      'start notepad.exe',
      'cmd /c start server.exe',
      'cmd.exe //c "start /b node server.js"',
      'powershell -Command Start-Process node -ArgumentList server.js',
      'pwsh.exe -c "Start-Job { node server.js }"',
      'powershell.exe -NoProfile -Command "saps node"',
      'powershell -c "start notepad"',
      'pwsh -Command "Get-Date; start node server.js"',
      'powershell -c \'[System.Diagnostics.Process]::Start("node")\'',
      'powershell -c "Invoke-CimMethod Win32_Process -MethodName Create"',
      'powershell -EncodedCommand ZQBjAGgAbwA=',
      'pwsh -enc ZQBjAGgAbwA=',
      // Git Bash strips unquoted backslashes; these are the forms that run.
      'C:/Windows/System32/cmd.exe /c start x',
      "'C:\\Windows\\System32\\cmd.exe' /c start x",
      'nohup.exe node server.js',
      // Bash keeps backslashes inside double quotes, so these still run cmd/pwsh.
      '"C:\\Windows\\System32\\cmd.exe" /c start x',
      '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -c "Start-Process node"',
      'cmd /c "echo hi & start x"',
      'env FOO=1 start x',
      'exec start x',
      'env -u HOME start x',
      'env -S "start notepad"',
      'bash.exe -c "nohup node server.js"',
    ])
      expect(containsUnmanagedShellDetachment(command, 0, 'win32')).toBe(true);
  });

  it('allows ordinary Windows commands, including the word start in arguments', () => {
    for (const command of [
      'npm start',
      'env NODE_ENV=test npm start',
      'exec npm start',
      'yarn start',
      'cmd /c echo start',
      'cmd.exe //c "echo starting"',
      'git status',
      'cmd /c echo started',
      'powershell -Command Get-ChildItem',
      'pwsh -NoProfile -File build.ps1',
      'powershell -Command Write-Output start',
      'bash -c "npm run start"',
    ])
      expect(containsUnmanagedShellDetachment(command, 0, 'win32')).toBe(false);
  });

  it('keeps POSIX behavior unchanged', () => {
    expect(
      containsUnmanagedShellDetachment(
        'sh -c "echo \\"quoted\\" \\\\ done; nohup node x"',
        0,
        'darwin',
      ),
    ).toBe(true);
    expect(
      containsUnmanagedShellDetachment('echo "a\\b" && ls', 0, 'darwin'),
    ).toBe(false);
    expect(containsUnmanagedShellDetachment('start notepad', 0, 'darwin')).toBe(
      false,
    );
    expect(containsUnmanagedShellDetachment('nohup node x', 0, 'darwin')).toBe(
      true,
    );
  });
});

describe('commandForApproval on Windows', () => {
  // Codex renders the approval command as shlex_join([shell, -NoProfile?,
  // -Command, script]); single quotes inside the script become '"'"'.
  const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
  const powershell =
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const shells = trustedWindowsShells({
    SystemRoot: 'C:\\WINDOWS',
    ProgramFiles: 'C:\\Program Files',
  });
  const decode = (command: string): string | undefined =>
    commandForApproval(command, 'win32', shells);
  const envelope = (
    script: string,
    shell = powershell,
    profile = true,
  ): string =>
    [
      quote(shell),
      ...(profile ? ['-NoProfile'] : []),
      '-Command',
      quote(script),
    ].join(' ');

  it.each([
    ['git status'],
    ['Get-ChildItem src'],
    ["Get-Content 'src\\file with space.ts'"],
    ['Get-Content a.txt | Select-Object -First 5'],
    ['npm test; git status'],
    ['git fetch && git status'],
  ])('decodes the plain script %s', (script) => {
    expect(decode(envelope(script))).toBe(script);
    expect(
      decode(
        envelope(script, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', false),
      ),
    ).toBe(script);
  });

  it.each([
    ['$env:USERPROFILE'],
    ['git log $(Remove-Item x)'],
    ['git status @(Remove-Item x)'],
    ['Write-Output `$x'],
    ['Get-ChildItem | ForEach-Object { Remove-Item $_ }'],
    ['git status > out.txt'],
    ['& notepad.exe'],
    ['[System.Diagnostics.Process]::Start("x")'],
    ["Write-Output 'it''s'"],
    ['git --% status'],
    ['git status # comment'],
    // Typographic quotes end a PowerShell string the engine would keep open.
    ["git status 'x\u2019; Remove-Item -Recurse src; \u2019x'"],
    ['git status \u201cx\u201d'],
    ['Get-ChildItem \u2013Recurse'],
    // Dot-sourcing runs a script file.
    ['. .\\script.ps1'],
    ['git status; . .\\script.ps1'],
  ])('refuses a script PowerShell would expand or evaluate: %s', (script) => {
    expect(decode(envelope(script))).toBeUndefined();
  });

  it('refuses other envelopes and passes non-envelope commands through', () => {
    expect(
      decode(`${quote(powershell)} -EncodedCommand ZQBjAGgAbwA=`),
    ).toBeUndefined();
    expect(decode(`${envelope('git status')} extra`)).toBeUndefined();
    expect(
      decode(`powershell.exe -Command ${quote('git status')}`),
    ).toBeUndefined();
    expect(decode('git status')).toBe('git status');
    expect(commandForApproval('/bin/zsh -c pwd', 'darwin')).toBe('pwd');
    // The POSIX envelope decodes the same way on every host.
    expect(decode('/bin/zsh -c pwd')).toBe('pwd');
  });

  it('decodes only the trusted PowerShell installations, whatever the name', () => {
    expect(shells).toEqual([
      'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe',
      'c:\\program files\\powershell\\7\\pwsh.exe',
    ]);
    // The model chooses the shell binary; a same-named copy is not trusted.
    for (const shell of [
      'C:\\worktree\\tools\\powershell.exe',
      'C:\\Users\\dev\\pwsh.exe',
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\..\\..\\..\\..\\worktree\\powershell.exe',
    ])
      expect(decode(envelope('git status', shell))).toBeUndefined();
    expect(
      decode(
        envelope(
          'git status',
          'c:\\windows\\system32\\WindowsPowerShell\\v1.0\\POWERSHELL.EXE',
        ),
      ),
    ).toBe('git status');
    // Without a resolvable system directory nothing is trusted.
    expect(trustedWindowsShells({})).toEqual([]);
    expect(
      commandForApproval(envelope('git status'), 'win32', []),
    ).toBeUndefined();
  });

  it('lets the approval engine prompt for, and rules match, a decoded script', () => {
    const decoded = decode(envelope('git status'));
    expect(decoded).toBe('git status');
    const ctx = {
      mode: 'ask' as const,
      workspaceRoot: 'C:\\work',
    };
    const check = {
      kind: 'command' as const,
      command: decoded ?? '',
      shellPlatform: 'windows' as const,
    };
    expect(
      evaluateApproval(check, {
        ...ctx,
        rules: { session: [], project: [], global: [] },
      }).outcome,
    ).toBe('prompt');
    // The raw envelope is an interpreter payload the engine always refuses.
    expect(
      evaluateApproval(
        { ...check, command: envelope('git status') },
        { ...ctx, rules: { session: [], project: [], global: [] } },
      ).outcome,
    ).toBe('deny');
  });
});

describe('Codex sandbox write profile', () => {
  const command = (itemId: string): Record<string, unknown> => ({
    threadId: 'thread',
    turnId: 'turn',
    kind: 'command',
    itemId,
    cwd,
    command: 'printf changed >> src/file.ts',
  });

  it('declines commands in a write-profile turn once the root chat plans, until the next turn', async () => {
    let writable = true;
    const tools = policy(
      ['src'],
      () => Promise.resolve(true),
      () => writable,
    );
    tools.setCodexTurnWrites(true);
    await expect(
      tools.approveCodex('item/commandExecution/requestApproval', command('a')),
    ).resolves.toEqual({ decision: 'accept' });
    writable = false;
    await expect(
      tools.approveCodex('item/commandExecution/requestApproval', command('b')),
    ).resolves.toEqual({ decision: 'decline' });
    expect(check).toHaveBeenCalledTimes(1);
    // The next turn runs under the read-only profile, where the sandbox
    // itself keeps the command from writing.
    tools.setCodexTurnWrites(false);
    await expect(
      tools.approveCodex('item/commandExecution/requestApproval', command('c')),
    ).resolves.toEqual({ decision: 'accept' });
  });

  it('declines a write-profile command when the root starts planning during its approval', async () => {
    let writable = true;
    const tools = policy(
      ['src'],
      () => Promise.resolve(true),
      () => writable,
    );
    tools.setCodexTurnWrites(true);
    check.mockImplementation(() => {
      writable = false;
      return Promise.resolve({ decision: 'allow' });
    });
    await expect(
      tools.approveCodex('item/commandExecution/requestApproval', command('a')),
    ).resolves.toEqual({ decision: 'decline' });
  });

  it('returns the resolved grants', async () => {
    const tools = policy(['src']);
    await expect(tools.prepareCodexSandboxWrites()).resolves.toEqual([
      path.join(cwd, 'src'),
    ]);
  });

  it('prepares grants while the root chat plans', async () => {
    const tools = policy(
      ['src'],
      () => Promise.resolve(true),
      () => false,
    );
    await expect(tools.prepareCodexSandboxWrites()).resolves.toEqual([
      path.join(cwd, 'src'),
    ]);
  });

  it('keeps the grants however many files they hold', async () => {
    const tools = policy(['src']);
    await Promise.all(
      Array.from({ length: 300 }, (_, index) =>
        writeFile(path.join(cwd, `src/file-${index}.txt`), 'x'),
      ),
    );
    await expect(tools.prepareCodexSandboxWrites()).resolves.toEqual([
      path.join(cwd, 'src'),
    ]);
  });

  it('adds no write grant to the sandbox when a grant fails the path checks', async () => {
    await symlink(path.join(cwd, 'src'), path.join(cwd, 'linked'));
    await expect(
      policy(['src', 'linked']).prepareCodexSandboxWrites(),
    ).resolves.toEqual([]);
    await expect(policy([]).prepareCodexSandboxWrites()).resolves.toEqual([]);
  });

  describe('with a parent policy for a grant', () => {
    const evaluate = jest.fn<
      Promise<'allow' | 'deny' | 'prompt'>,
      [ApprovalCheck]
    >();
    // The parent's saved rule denies writes to src/file.ts, inside the grant.
    const denyingPolicy = (): DelegationNativePolicy =>
      new DelegationNativePolicy({
        cwd,
        writePaths: ['src'],
        mode: (): ApprovalMode => mode,
        signal: controller.signal,
        delegationId: 'child',
        allowed: () => Promise.resolve(true),
        writable: () => true,
        approval: {
          check,
          evaluate,
          setMode: jest.fn(),
          policyContextKey: (): string => generation,
          reevaluatePendingApprovals: () => Promise.resolve(),
          dispose: jest.fn(),
        },
        emit,
      });
    beforeEach(() => {
      evaluate.mockReset().mockImplementation((candidate) =>
        Promise.resolve(
          evaluateApproval(candidate, {
            mode: 'full-access',
            workspaceRoot: cwd,
            rules: {
              session: [],
              project: [
                {
                  id: 'deny-evidence',
                  behavior: 'deny',
                  target: { kind: 'file-write', path: 'src/file.ts' },
                  origin: 'settings',
                  createdAt: '2026-09-28T00:00:00.000Z',
                },
              ],
              global: [],
            },
          }).outcome,
        ),
      );
    });

    it('keeps the grant out of the sandbox, so a shell cannot bypass the rule', async () => {
      await expect(
        denyingPolicy().prepareCodexSandboxWrites(),
      ).resolves.toEqual([]);
      expect(evaluate).toHaveBeenCalledWith({
        kind: 'file-write',
        path: path.join(cwd, 'src'),
        isGrant: true,
      });
      // Deciding the sandbox never prompts the user.
      expect(check).not.toHaveBeenCalled();
    });

    it('declines a write-profile command once the rule denies writes inside the grant', async () => {
      const tools = denyingPolicy();
      tools.setCodexTurnWrites(true);
      await expect(
        tools.approveCodex(
          'item/commandExecution/requestApproval',
          command('a'),
        ),
      ).resolves.toEqual({ decision: 'decline' });
      expect(check).not.toHaveBeenCalled();
    });

    it('admits the grant when the parent explicitly allows it', async () => {
      evaluate.mockResolvedValue('allow');
      await expect(
        denyingPolicy().prepareCodexSandboxWrites(),
      ).resolves.toEqual([path.join(cwd, 'src')]);
    });

    it('keeps a prompt-required protected file out of the sandbox', async () => {
      evaluate.mockImplementation((candidate) =>
        Promise.resolve(
          evaluateApproval(candidate, {
            mode: 'auto',
            workspaceRoot: cwd,
            protectedFileWritePaths: [path.join(cwd, 'src/approvals.json')],
            rules: { session: [], project: [], global: [] },
          }).outcome,
        ),
      );
      await expect(
        denyingPolicy().prepareCodexSandboxWrites(),
      ).resolves.toEqual([]);
      await expect(denyingPolicy().codexSandboxWritesRevoked()).resolves.toBe(
        true,
      );
      expect(check).not.toHaveBeenCalled();
    });

    it('revokes the sandbox grant when the parent policy changes to prompt, without prompting', async () => {
      const tools = denyingPolicy();
      evaluate.mockResolvedValueOnce('allow').mockResolvedValue('prompt');
      await expect(tools.prepareCodexSandboxWrites()).resolves.toEqual([
        path.join(cwd, 'src'),
      ]);
      await expect(tools.codexSandboxWritesRevoked()).resolves.toBe(true);
      expect(evaluate).toHaveBeenLastCalledWith({
        kind: 'file-write',
        path: path.join(cwd, 'src'),
        isGrant: true,
      });
      expect(check).not.toHaveBeenCalled();
    });

    it('revokes a running grant when the parent lowers approval mode', async () => {
      let sessionMode: ApprovalMode = 'full-access';
      mode = 'full-access';
      const setMode = jest.fn((next: ApprovalMode): void => {
        sessionMode = next;
      });
      const tools = new DelegationNativePolicy({
        cwd,
        writePaths: ['src'],
        mode: (): ApprovalMode => mode,
        signal: controller.signal,
        delegationId: 'child',
        allowed: (): Promise<boolean> => Promise.resolve(true),
        writable: (): boolean => true,
        approval: {
          check,
          evaluate: (candidate): Promise<'allow' | 'deny' | 'prompt'> =>
            Promise.resolve(
              evaluateApproval(candidate, {
                mode: sessionMode,
                workspaceRoot: cwd,
                rules: { session: [], project: [], global: [] },
              }).outcome,
            ),
          setMode,
          policyContextKey: (): string => generation,
          dispose: jest.fn(),
        },
        emit,
      });

      await expect(tools.prepareCodexSandboxWrites()).resolves.toEqual([
        path.join(cwd, 'src'),
      ]);
      mode = 'ask';
      await expect(tools.codexSandboxWritesRevoked()).resolves.toBe(true);
      expect(setMode).toHaveBeenLastCalledWith('ask');
      await expect(tools.prepareCodexSandboxWrites()).resolves.toEqual([]);
    });
  });

  it('keeps the sandbox grants while the parent still allows them, whatever the plan state', async () => {
    const tools = policy(
      ['src'],
      () => Promise.resolve(true),
      // The runner checks the root's plan state itself.
      () => false,
    );
    await expect(tools.codexSandboxWritesRevoked()).resolves.toBe(false);
    await expect(policy([]).codexSandboxWritesRevoked()).resolves.toBe(false);
    // The runner rechecks the grants at once when the parent policy changes.
    expect(tools.policyContextKey()).toBe('1');
    generation = '2';
    expect(tools.policyContextKey()).toBe('2');
    expect(check).not.toHaveBeenCalled();
  });

  it('revokes the sandbox grants once a grant fails the path checks', async () => {
    const tools = policy(['src']);
    await expect(tools.codexSandboxWritesRevoked()).resolves.toBe(false);
    await rm(path.join(cwd, 'src'), { recursive: true });
    await mkdir(path.join(cwd, 'elsewhere'));
    await symlink(path.join(cwd, 'elsewhere'), path.join(cwd, 'src'));
    await expect(tools.codexSandboxWritesRevoked()).resolves.toBe(true);
  });

  it('tells a Codex child where its shell may write and how to ask for more', () => {
    const codex = policy(['src']).instructions('codex');
    expect(codex).toContain(
      `Shell commands and file edits may write only within: ${path.join(cwd, 'src')}.`,
    );
    expect(codex).toContain('request_permissions');
    expect(codex).toContain('the parent must still approve it');
    expect(policy([]).instructions('codex')).toContain(
      'Shell commands and file edits are read-only',
    );
    // Claude children keep their file-tool wording.
    expect(policy(['src']).instructions()).toContain(
      'Native file-tool edits are permitted only within',
    );
  });
});

it('declines commands in a write-profile turn once a grant fails the path checks', async () => {
  const tools = policy(['src']);
  tools.setCodexTurnWrites(true);
  await rm(path.join(cwd, 'src'), { recursive: true });
  await mkdir(path.join(cwd, 'elsewhere'));
  await symlink(path.join(cwd, 'elsewhere'), path.join(cwd, 'src'));
  await expect(
    tools.approveCodex('item/commandExecution/requestApproval', {
      threadId: 'thread',
      turnId: 'turn',
      kind: 'command',
      itemId: 'swapped',
      cwd,
      command: 'printf changed >> src/file.ts',
    }),
  ).resolves.toEqual({ decision: 'decline' });
  expect(check).not.toHaveBeenCalled();
});
