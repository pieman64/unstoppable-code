import { BRAND } from '@canopy/brand/current';
import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import {
  authorizeCursorMcpTool,
  authorizeCursorTool,
} from '../cursor/tool-approval';
import type { ApprovalSessionHandle } from '../approvals/approval-service';

function noPendingApprovalReevaluation(): ApprovalSessionHandle['reevaluatePendingApprovals'] {
  return jest.fn<
    ReturnType<ApprovalSessionHandle['reevaluatePendingApprovals']>,
    Parameters<ApprovalSessionHandle['reevaluatePendingApprovals']>
  >(() => Promise.resolve());
}

describe('Cursor native tool authorization', () => {
  const check = jest.fn<
    ReturnType<ApprovalSessionHandle['check']>,
    Parameters<ApprovalSessionHandle['check']>
  >();
  const approval: ApprovalSessionHandle = {
    check,
    reevaluatePendingApprovals: noPendingApprovalReevaluation(),
    setMode: jest.fn(),
    dispose: jest.fn(),
  };
  const context = {
    approval,
    cwd: '/workspace',
    planMode: false,
    signal: new AbortController().signal,
  };
  const payload = (tool: string, input: unknown): unknown => ({
    hook_event_name: 'preToolUse',
    tool_name: tool,
    tool_input: input,
    tool_use_id: 'shared-id',
  });
  beforeEach(() => {
    check.mockReset();
    check.mockResolvedValue({ decision: 'allow' });
  });
  it('checks each Read/Write phase despite a shared tool ID', async () => {
    await authorizeCursorTool(
      payload('Read', { file_path: '/workspace/a' }),
      context,
    );
    await authorizeCursorTool(
      payload('Write', { file_path: '/workspace/a', content: 'new' }),
      context,
    );
    expect(check.mock.calls.map(([value]) => value)).toEqual([
      { kind: 'tool', toolName: 'Read' },
      { kind: 'file-write', path: '/workspace/a' },
    ]);
  });
  it('passes proposed Write content and a relative display path to shared approval', async () => {
    await authorizeCursorTool(
      payload('Write', { file_path: '/workspace/a', content: 'proposed\n' }),
      context,
    );
    expect(check).toHaveBeenCalledWith(
      { kind: 'file-write', path: '/workspace/a' },
      expect.objectContaining({
        details: {
          kind: 'file-write',
          path: '/workspace/a',
          displayPath: 'a',
          change: { kind: 'write', content: 'proposed\n' },
        },
        suggestedTarget: { kind: 'file-write', path: '/workspace/a' },
      }),
    );
  });
  it('preserves the complete shell command and working directory', async () => {
    const command = 'awk \'BEGIN {system("touch result")}\'';
    await authorizeCursorTool(
      payload('Shell', { command, cwd: '/workspace/subdir' }),
      context,
    );
    expect(check).toHaveBeenCalledWith(
      { kind: 'command', command, cwd: '/workspace/subdir' },
      expect.objectContaining({
        details: { kind: 'command', command, cwd: '/workspace/subdir' },
      }),
    );
  });
  it.each([
    'Workspace rule denied this command.',
    'Blocked by a safety rule (force-push). This call cannot be approved from a prompt. Do not retry or repackage the blocked operation. Choose a safe alternative or explain the block to the user.',
  ])(
    'returns the shared policy denial for a native Shell operation: %s',
    async (message) => {
      const denied = {
        decision: 'deny' as const,
        message,
      };
      check.mockResolvedValue(denied);
      expect(
        await authorizeCursorTool(
          payload('Shell', {
            command: 'printf blocked > result',
            cwd: '/workspace',
          }),
          context,
        ),
      ).toEqual(denied);
      expect(check).toHaveBeenCalledWith(
        {
          kind: 'command',
          command: 'printf blocked > result',
          cwd: '/workspace',
        },
        expect.objectContaining({ toolUseId: 'shared-id' }),
      );
    },
  );
  it.each(['Task', 'mcp__server__tool', 'Edit', 'Unknown'])(
    'denies unimplemented %s without a permissive generic fallback',
    async (tool) => {
      expect(
        await authorizeCursorTool(payload(tool, {}), context),
      ).toMatchObject({ decision: 'deny' });
      expect(check).not.toHaveBeenCalled();
    },
  );
  it.each([
    [
      'Grep',
      {
        pattern: 'needle',
        file_path: '/workspace',
        glob: '*.ts',
        output_mode: 'content',
      },
      'Grep',
    ],
    ['Grep', { pattern: '', file_path: '' }, 'Grep'],
    [
      'Glob',
      { glob_pattern: '**/*.ts', target_directory: '/workspace' },
      'Glob',
    ],
    ['Glob', { pattern: '**/*.ts', path: 'src' }, 'Glob'],
    ['List', { file_path: '/workspace', ignore: ['node_modules'] }, 'Read'],
    ['ReadLints', { file_path: '/workspace/a.ts' }, 'Read'],
  ])(
    'routes native %s through shared read approvals, including plan mode',
    async (tool, input, normalizedTool) => {
      for (const planMode of [false, true]) {
        check.mockClear();
        expect(
          await authorizeCursorTool(payload(String(tool), input), {
            ...context,
            planMode,
          }),
        ).toEqual({ decision: 'allow' });
        expect(check).toHaveBeenCalledWith(
          { kind: 'tool', toolName: normalizedTool },
          expect.objectContaining({ toolUseId: 'shared-id' }),
        );
        check.mockResolvedValueOnce({
          decision: 'deny',
          message: 'User denied this search.',
        });
        expect(
          await authorizeCursorTool(payload(String(tool), input), {
            ...context,
            planMode,
          }),
        ).toMatchObject({
          decision: 'deny',
          message: 'User denied this search.',
        });
      }
    },
  );

  it('treats Delete as a file mutation and enforces plan mode', async () => {
    const request = payload('Delete', { file_path: '/workspace/a.ts' });
    expect(await authorizeCursorTool(request, context)).toEqual({
      decision: 'allow',
    });
    expect(check).toHaveBeenCalledWith(
      { kind: 'file-write', path: '/workspace/a.ts' },
      expect.anything(),
    );
    check.mockClear();
    expect(
      await authorizeCursorTool(request, { ...context, planMode: true }),
    ).toMatchObject({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
  });

  it.each(['Fetch', 'WebFetch'])(
    'routes %s through the existing network policy',
    async (tool) => {
      expect(
        await authorizeCursorTool(
          payload(tool, { url: 'https://example.com/docs' }),
          context,
        ),
      ).toEqual({ decision: 'allow' });
      expect(check).toHaveBeenCalledWith(
        { kind: 'network', host: 'example.com' },
        expect.anything(),
      );
    },
  );

  it('requires a broad network grant for WebSearch because Cursor cannot enforce domain filters', async () => {
    expect(
      await authorizeCursorTool(
        payload('WebSearch', {
          search_term: 'docs',
          allowed_domains: ['example.com'],
        }),
        context,
      ),
    ).toEqual({ decision: 'allow' });
    expect(check).toHaveBeenCalledWith(
      { kind: 'network', host: '*', isGrant: true },
      expect.anything(),
    );
    check.mockImplementation((requirement) => {
      const result = evaluateApproval(requirement, {
        mode: 'full-access',
        rules: {
          session: [],
          global: [],
          project: [
            {
              id: 'deny-private-host',
              behavior: 'deny',
              target: { kind: 'network', host: 'private.example.com' },
              origin: 'settings',
              createdAt: '2026-09-29T00:00:00Z',
            },
          ],
        },
      });
      return Promise.resolve({
        decision: result.outcome === 'allow' ? 'allow' : 'deny',
      });
    });
    expect(
      await authorizeCursorTool(
        payload('WebSearch', { search_term: 'docs' }),
        context,
      ),
    ).toEqual({ decision: 'deny' });
  });

  it.each([
    ['Grep', {}],
    ['Grep', { pattern: 123 }],
    ['Grep', { pattern: 'x', file_path: 123 }],
    ['Grep', { pattern: 'x', file_path: '/workspace', path: '/outside' }],
    ['Grep', { pattern: 'x', glob: ['*.ts'] }],
    ['Grep', { pattern: 'x', path: '/workspace\u0000hidden' }],
    ['Glob', { glob_pattern: '' }],
    ['Glob', { pattern: '*.ts', target_directory: [] }],
    ['Glob', { pattern: '*.ts', glob_pattern: '../*' }],
    ['List', {}],
    ['ReadLints', { file_path: 'relative' }],
    ['Delete', { file_path: 'relative' }],
    ['Fetch', { url: 'file:///etc/passwd' }],
    ['Fetch', { url: 'invalid' }],
    ['WebSearch', { query: 123 }],
    ['WebSearch', { search_term: 'docs', query: 'different' }],
  ])(
    'denies malformed native %s before asking for approval',
    async (tool, input) => {
      expect(
        await authorizeCursorTool(payload(String(tool), input), context),
      ).toMatchObject({ decision: 'deny' });
      expect(check).not.toHaveBeenCalled();
    },
  );
  it('denies malformed commands and writes, including in full access', async () => {
    for (const request of [
      payload('Shell', {}),
      payload('Write', { file_path: '/workspace/a' }),
      payload('Write', { file_path: 'relative', content: 'a' }),
    ])
      expect(await authorizeCursorTool(request, context)).toEqual({
        decision: 'deny',
      });
    expect(check).not.toHaveBeenCalled();
  });
  it('revokes an allow that resolves after Stop', async () => {
    const abort = new AbortController();
    check.mockImplementation(() => {
      abort.abort();
      return Promise.resolve({ decision: 'allow' });
    });
    expect(
      await authorizeCursorTool(payload('Shell', { command: 'touch result' }), {
        ...context,
        signal: abort.signal,
      }),
    ).toEqual({ decision: 'deny' });
  });
  it('lets an MCP tool call through the hook so the ACP permission request and gates decide', async () => {
    // The pinned CLI runs preToolUse for MCP tools as `MCP:<tool>` with only
    // the arguments; the server is unknown here, and the CLI asks over ACP
    // right after an allow. Denying here would fail the call before that.
    for (const planMode of [false, true]) {
      expect(
        await authorizeCursorTool(
          payload('MCP:slack_send_message', { channel_id: 'U1', message: 'x' }),
          { ...context, planMode },
        ),
      ).toEqual({ decision: 'allow' });
    }
    expect(check).not.toHaveBeenCalled();
  });
  it('enforces read-only plan mode above approval rules', async () => {
    expect(
      await authorizeCursorTool(
        payload('Write', { file_path: '/workspace/a', content: 'a' }),
        { ...context, planMode: true },
      ),
    ).toEqual({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
  });
});

describe('Cursor MCP tool authorization', () => {
  const check = jest.fn<
    ReturnType<ApprovalSessionHandle['check']>,
    Parameters<ApprovalSessionHandle['check']>
  >();
  const approval: ApprovalSessionHandle = {
    check,
    reevaluatePendingApprovals: noPendingApprovalReevaluation(),
    setMode: jest.fn(),
    dispose: jest.fn(),
  };
  beforeEach(() => {
    check.mockReset();
    check.mockResolvedValue({ decision: 'allow' });
  });
  const ns = BRAND.tools.namespace;
  const context = {
    approval,
    toolCallId: 'call-7',
    cwd: '/workspace',
    signal: new AbortController().signal,
  };
  it('permits managed tools only when this host advertises them and applies plan policy', async () => {
    const call = {
      server: ns,
      tool: 'DelegateTask',
      args: { model: 'cursor-default', prompt: 'review' },
    };
    expect(await authorizeCursorMcpTool(call, context)).toMatchObject({
      decision: 'deny',
    });
    const enabled = {
      ...context,
      managedToolNames: ['DelegateTask', 'GetDelegateOutput'],
    };
    expect(await authorizeCursorMcpTool(call, enabled)).toMatchObject({
      decision: 'allow',
    });
    expect(check).toHaveBeenCalledWith(
      { kind: 'mcp', server: ns, tool: 'DelegateTask' },
      expect.anything(),
    );
    check.mockClear();
    expect(
      await authorizeCursorMcpTool(call, { ...enabled, planMode: true }),
    ).toMatchObject({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
    expect(
      await authorizeCursorMcpTool(
        { server: ns, tool: 'GetDelegateOutput', args: {} },
        { ...enabled, planMode: true },
      ),
    ).toMatchObject({ decision: 'allow' });
  });
  it("routes the app's own MCP tools through the checks Claude applies to them", async () => {
    expect(
      await authorizeCursorMcpTool(
        {
          server: ns,
          tool: 'WatchCommand',
          args: { command: 'ls -la', intervalSeconds: 5, maxAttempts: 1 },
        },
        context,
      ),
    ).toEqual({ decision: 'allow' });
    expect(check).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'command',
        command: 'ls -la',
        cwd: '/workspace',
      }),
      expect.objectContaining({
        title: 'Cursor wants to use WatchCommand',
        description:
          'Repeated command in `/workspace`: up to 1 attempt, 5 seconds between attempts, 60-second timeout each.',
        toolUseId: 'call-7',
      }),
    );
    await authorizeCursorMcpTool(
      {
        server: ns,
        tool: 'DispatchAction',
        args: { action: { type: 'pipeline.run' } },
      },
      context,
    );
    expect(check).toHaveBeenLastCalledWith(
      { kind: 'mcp', server: ns, tool: 'DispatchAction' },
      expect.objectContaining({ title: 'Cursor wants to use DispatchAction' }),
    );
    await authorizeCursorMcpTool(
      { server: `${ns}_ui`, tool: 'AskUserQuestion', args: { questions: [] } },
      context,
    );
    expect(check).toHaveBeenLastCalledWith(
      { kind: 'mcp', server: `${ns}_ui`, tool: 'AskUserQuestion' },
      expect.objectContaining({ title: 'Cursor wants to use AskUserQuestion' }),
    );
    expect(check).toHaveBeenCalledTimes(3);
  });
  it('denies a worktree-only app tool on the Cowork surface before prompting', async () => {
    expect(
      await authorizeCursorMcpTool(
        { server: ns, tool: 'SetBaseBranch', args: { baseBranch: 'main' } },
        { ...context, toolSurface: 'cursor-acp-standalone' },
      ),
    ).toEqual({
      decision: 'deny',
      message: 'This tool is not available to Cursor chats.',
    });
    expect(check).not.toHaveBeenCalled();
    await authorizeCursorMcpTool(
      {
        server: ns,
        tool: 'DispatchAction',
        args: { action: { type: 'pipeline.run' } },
      },
      { ...context, toolSurface: 'cursor-acp-standalone' },
    );
    expect(check).toHaveBeenLastCalledWith(
      { kind: 'mcp', server: ns, tool: 'DispatchAction' },
      expect.objectContaining({ title: 'Cursor wants to use DispatchAction' }),
    );
  });
  it('denies a shell-running app tool in read-only plan mode before consulting policy', async () => {
    expect(
      await authorizeCursorMcpTool(
        {
          server: ns,
          tool: 'WatchCommand',
          args: { command: 'ls', intervalSeconds: 5, maxAttempts: 1 },
        },
        { ...context, planMode: true },
      ),
    ).toMatchObject({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
    // A read-only app tool is still checked normally in plan mode.
    expect(
      await authorizeCursorMcpTool(
        { server: ns, tool: 'SearchMemory', args: { query: 'x' } },
        { ...context, planMode: true },
      ),
    ).toEqual({ decision: 'allow' });
    expect(check).toHaveBeenCalledTimes(1);
    // Mutating app tools are denied in plan mode before policy, even when a
    // remembered rule or full access would otherwise allow them silently.
    for (const tool of ['SaveMemory', 'DispatchAction', 'SetBaseBranch']) {
      expect(
        await authorizeCursorMcpTool(
          { server: ns, tool, args: {} },
          { ...context, planMode: true },
        ),
      ).toMatchObject({ decision: 'deny' });
    }
    expect(check).toHaveBeenCalledTimes(1);
    expect(
      await authorizeCursorMcpTool(
        {
          server: `${ns}_ui`,
          tool: 'AskUserQuestion',
          args: { questions: [] },
        },
        { ...context, planMode: true },
      ),
    ).toEqual({ decision: 'allow' });
  });
  it('checks the Ledger tools with the ordinary policy, in plan mode too, as bookkeeping', async () => {
    for (const planMode of [false, true]) {
      for (const tool of [
        'AddFeedEntry',
        'SearchFeedEntries',
        'UpdateFeedEntry',
      ]) {
        check.mockClear();
        expect(
          await authorizeCursorMcpTool(
            { server: ns, tool, args: { title: 'Plan the work' } },
            { ...context, planMode },
          ),
        ).toEqual({ decision: 'allow' });
        expect(check).toHaveBeenCalledWith(
          { kind: 'mcp', server: ns, tool },
          expect.objectContaining({ title: `Cursor wants to use ${tool}` }),
        );
      }
    }
    // Plan mode adds no denial, and no bypass: the policy still decides.
    check.mockResolvedValue({ decision: 'deny', message: 'Denied.' });
    expect(
      await authorizeCursorMcpTool(
        { server: ns, tool: 'AddFeedEntry', args: {} },
        { ...context, planMode: true },
      ),
    ).toEqual({ decision: 'deny', message: 'Denied.' });
  });
  it('denies a WatchCommand without a command before consulting policy', async () => {
    expect(
      await authorizeCursorMcpTool(
        { server: ns, tool: 'WatchCommand', args: {} },
        context,
      ),
    ).toMatchObject({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
  });
  it('OpenCode graph calls retain shared approval and the read-only plan ceiling', async () => {
    const graphContext = {
      ...context,
      providerLabel: 'OpenCode' as const,
      toolSurface: 'opencode-acp' as const,
      planMode: true,
    };
    const call = { server: ns, tool: 'GetCodeGraphContext', args: {} };
    expect(await authorizeCursorMcpTool(call, graphContext)).toEqual({
      decision: 'allow',
    });
    expect(check).toHaveBeenCalledWith(
      { kind: 'mcp', server: ns, tool: call.tool },
      expect.anything(),
    );
    check.mockResolvedValue({ decision: 'deny', message: 'Saved deny.' });
    expect(await authorizeCursorMcpTool(call, graphContext)).toMatchObject({
      decision: 'deny',
    });
    check.mockClear();
    expect(
      await authorizeCursorMcpTool(
        { ...call, tool: 'BuildOrUpdateCodeGraph' },
        graphContext,
      ),
    ).toMatchObject({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
  });
  it("denies a tool the app's servers do not advertise even on the app namespace", async () => {
    expect(
      await authorizeCursorMcpTool(
        { server: ns, tool: 'GetCodeGraphContext' },
        context,
      ),
    ).toEqual({
      decision: 'deny',
      message: 'This tool is not available to Cursor chats.',
    });
    expect(check).not.toHaveBeenCalled();
  });
  it('routes every other server through the shared MCP policy check', async () => {
    const denied = { decision: 'deny' as const, message: 'Blocked.' };
    check.mockResolvedValue(denied);
    expect(
      await authorizeCursorMcpTool(
        { server: 'linear', tool: 'create_issue' },
        {
          approval,
          toolCallId: 'call-7',
          cwd: '/workspace',
          signal: new AbortController().signal,
        },
      ),
    ).toEqual(denied);
    expect(check).toHaveBeenCalledWith(
      { kind: 'mcp', server: 'linear', tool: 'create_issue' },
      {
        title: 'Cursor wants to use create_issue',
        details: { kind: 'mcp', server: 'linear', tool: 'create_issue' },
        suggestedTarget: {
          kind: 'mcp',
          server: 'linear',
          tool: 'create_issue',
        },
        toolUseId: 'call-7',
      },
    );
  });
  it('denies once the turn is gone instead of prompting', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await authorizeCursorMcpTool(
        { server: 'linear', tool: 'create_issue' },
        { ...context, signal: controller.signal },
      ),
    ).toEqual({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
  });
});

describe('Cursor MCP tool authorization in App Advisor mode', () => {
  const ns = BRAND.tools.namespace;
  const advisor = `${ns}_app_advisor`;
  const check = jest.fn<
    ReturnType<ApprovalSessionHandle['check']>,
    Parameters<ApprovalSessionHandle['check']>
  >();
  const approval: ApprovalSessionHandle = {
    check,
    reevaluatePendingApprovals: noPendingApprovalReevaluation(),
    setMode: jest.fn(),
    dispose: jest.fn(),
  };
  const context = {
    approval,
    toolCallId: 'advisor-7',
    cwd: '/advisor-home',
    signal: new AbortController().signal,
    mode: 'app-advisor' as const,
  };
  beforeEach(() => {
    check.mockReset();
    check.mockResolvedValue({ decision: 'allow' });
  });
  it('checks App Advisor tools as their Claude MCP names so rules are shared', async () => {
    expect(
      await authorizeCursorMcpTool(
        {
          server: advisor,
          tool: 'DispatchAction',
          args: { action: { type: 'navigation.open_settings' } },
        },
        context,
      ),
    ).toEqual({ decision: 'allow' });
    expect(check).toHaveBeenLastCalledWith(
      { kind: 'mcp', server: advisor, tool: 'DispatchAction' },
      expect.objectContaining({
        title: 'Cursor wants to use DispatchAction',
        toolUseId: 'advisor-7',
      }),
    );
    await authorizeCursorMcpTool(
      { server: `${ns}_ui`, tool: 'AskUserQuestion', args: { questions: [] } },
      context,
    );
    expect(check).toHaveBeenLastCalledWith(
      { kind: 'mcp', server: `${ns}_ui`, tool: 'AskUserQuestion' },
      expect.objectContaining({ title: 'Cursor wants to use AskUserQuestion' }),
    );
  });
  it('lets the App Advisor runtime own the WatchCommand approval', async () => {
    expect(
      await authorizeCursorMcpTool(
        {
          server: advisor,
          tool: 'WatchCommand',
          args: { command: 'ls', intervalSeconds: 5, maxAttempts: 1 },
        },
        context,
      ),
    ).toEqual({ decision: 'allow' });
    expect(check).not.toHaveBeenCalled();
  });
  it('denies worktree-only and unknown tools on the App Advisor server', async () => {
    for (const tool of ['GetGitPreferences', 'SaveMemory', 'Unknown']) {
      expect(
        await authorizeCursorMcpTool(
          { server: advisor, tool, args: {} },
          context,
        ),
      ).toEqual({
        decision: 'deny',
        message: 'This tool is not available to Cursor chats.',
      });
    }
    expect(check).not.toHaveBeenCalled();
  });
  it.each(['Cursor', 'Copilot'] as const)(
    'denies unverified plugin tools in %s plan mode before Full Access approval',
    async (providerLabel) => {
      await expect(
        authorizeCursorMcpTool(
          {
            server: 'plugin',
            tool: 'write_file',
            args: { path: '/workspace/file', content: 'changed' },
          },
          { ...context, providerLabel, planMode: true },
        ),
      ).resolves.toMatchObject({ decision: 'deny' });
      expect(check).not.toHaveBeenCalled();
    },
  );

  it('still routes plugin servers through the shared MCP check', async () => {
    await authorizeCursorMcpTool(
      { server: 'linear', tool: 'create_issue' },
      context,
    );
    expect(check).toHaveBeenLastCalledWith(
      { kind: 'mcp', server: 'linear', tool: 'create_issue' },
      expect.objectContaining({ title: 'Cursor wants to use create_issue' }),
    );
  });
});

describe('Cursor Pipeline Assistant authorization', () => {
  const check = jest.fn().mockResolvedValue({ decision: 'allow' });
  const approval: ApprovalSessionHandle = {
    check,
    reevaluatePendingApprovals: noPendingApprovalReevaluation(),
    setMode: jest.fn(),
    dispose: jest.fn(),
  };
  const context = {
    approval,
    cwd: '/workspace',
    toolCallId: 'pipeline-call',
    mode: 'pipeline-editor' as const,
    signal: new AbortController().signal,
  };
  beforeEach(() => {
    check.mockClear();
  });
  test.each(['allow', 'deny'])(
    'uses shared plugin policy for a %s decision',
    async (decision) => {
      check.mockResolvedValueOnce({ decision });
      await expect(
        authorizeCursorMcpTool(
          {
            server: 'linear',
            tool: 'create_issue',
            args: { title: 'Reviewed' },
          },
          context,
        ),
      ).resolves.toMatchObject({ decision });
      expect(check).toHaveBeenCalledWith(
        { kind: 'mcp', server: 'linear', tool: 'create_issue' },
        expect.objectContaining({ toolUseId: 'pipeline-call' }),
      );
    },
  );
  test('keeps plugin calls denied in plan mode before shared policy', async () => {
    await expect(
      authorizeCursorMcpTool(
        {
          server: 'linear',
          tool: 'create_issue',
          args: { title: 'Not allowed' },
        },
        { ...context, planMode: true },
      ),
    ).resolves.toMatchObject({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
  });
  test('checks a known Pipeline Assistant tool through shared policy', async () => {
    await expect(
      authorizeCursorMcpTool(
        {
          server: `${BRAND.tools.namespace}_pipeline_editor`,
          tool: 'SetPipelineYaml',
          args: { yaml: 'name: reviewed' },
        },
        context,
      ),
    ).resolves.toMatchObject({ decision: 'allow' });
    expect(check).toHaveBeenCalled();
  });
  test.each([
    'WatchCommand',
    'DispatchAction',
    'LoadDeferredTools',
    'WriteMemory',
  ])('denies unadvertised assistant tool %s', async (tool) => {
    await expect(
      authorizeCursorMcpTool(
        { server: `${BRAND.tools.namespace}_pipeline_editor`, tool },
        context,
      ),
    ).resolves.toMatchObject({ decision: 'deny' });
    expect(check).not.toHaveBeenCalled();
  });
  test('denies a write in plan mode and after cancellation', async () => {
    const call = {
      server: `${BRAND.tools.namespace}_pipeline_editor`,
      tool: 'SetPipelineYaml',
    };
    await expect(
      authorizeCursorMcpTool(call, { ...context, planMode: true }),
    ).resolves.toMatchObject({ decision: 'deny' });
    await expect(
      authorizeCursorMcpTool(call, { ...context, signal: AbortSignal.abort() }),
    ).resolves.toMatchObject({ decision: 'deny' });
  });
});
