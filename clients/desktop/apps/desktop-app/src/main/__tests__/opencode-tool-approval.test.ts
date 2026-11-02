import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import type { ApprovalSessionHandle } from '../approvals/approval-service';
import { authorizeOpenCodeNativeTool } from '../opencode/tool-approval';

const check = jest.fn<
  ReturnType<ApprovalSessionHandle['check']>,
  Parameters<ApprovalSessionHandle['check']>
>();
const context = {
  cwd: '/workspace',
  approval: {
    check,
    setMode: jest.fn(),
    reevaluatePendingApprovals: jest.fn<
      Promise<void>,
      Parameters<ApprovalSessionHandle['reevaluatePendingApprovals']>
    >(),
    dispose: jest.fn(),
  },
  planMode: false,
  signal: new AbortController().signal,
  toolUseId: 'search',
};
const input = {
  sessionId: 'session',
  toolCallId: 'search',
  toolName: 'websearch',
  toolArgs: { query: 'fixture', allowed_domains: ['safe.example'] },
};
beforeEach(() => {
  check.mockReset();
  check.mockResolvedValue({ decision: 'allow' });
});
test.each([
  [
    'edit',
    { filePath: 'a', oldString: 'old', newString: 'new' },
    { kind: 'edit', oldText: 'old', newText: 'new' },
  ],
  [
    'write',
    { filePath: 'a', content: 'x'.repeat(20_001) },
    { kind: 'write', content: 'x'.repeat(20_000), truncated: true },
  ],
])(
  'native %s passes bounded request content to shared approval',
  async (toolName, toolArgs, change) => {
    expect(
      await authorizeOpenCodeNativeTool(
        { ...input, toolName, toolArgs },
        context,
      ),
    ).toEqual({ decision: 'allow' });
    expect(check).toHaveBeenCalledWith(
      { kind: 'file-write', path: '/workspace/a' },
      expect.objectContaining({
        details: {
          kind: 'file-write',
          path: '/workspace/a',
          displayPath: 'a',
          change,
        },
      }),
    );
  },
);
test('patch approvals stay path-only instead of showing synthetic empty Write content', async () => {
  expect(
    await authorizeOpenCodeNativeTool(
      {
        ...input,
        toolName: 'apply_patch',
        toolArgs: {
          patchText:
            '*** Begin Patch\n*** Update File: a\n@@\n-old\n+new\n*** End Patch',
        },
      },
      context,
    ),
  ).toEqual({ decision: 'allow' });
  expect(check).toHaveBeenCalledWith(
    { kind: 'file-write', path: '/workspace/a' },
    expect.objectContaining({
      details: { kind: 'file-write', path: '/workspace/a', displayPath: 'a' },
    }),
  );
});
test('native websearch reaches shared broad network approval in Full Access', async () => {
  check.mockImplementation((request) => {
    const result = evaluateApproval(request, {
      mode: 'full-access',
      rules: { session: [], global: [], project: [] },
    });
    return Promise.resolve({
      decision: result.outcome === 'allow' ? 'allow' : 'deny',
    });
  });
  expect(await authorizeOpenCodeNativeTool(input, context)).toEqual({
    decision: 'allow',
  });
  expect(check).toHaveBeenCalledWith(
    { kind: 'network', host: '*', isGrant: true },
    expect.anything(),
  );
});
test('native websearch honors narrower network denials even in Full Access', async () => {
  check.mockImplementation((request) => {
    const result = evaluateApproval(request, {
      mode: 'full-access',
      rules: {
        session: [],
        global: [],
        project: [
          {
            id: 'deny-domain',
            behavior: 'deny',
            target: { kind: 'network', host: 'blocked.example' },
            origin: 'settings',
            createdAt: '2026-10-08T00:00:00Z',
          },
        ],
      },
    });
    return Promise.resolve({
      decision: result.outcome === 'allow' ? 'allow' : 'deny',
    });
  });
  expect(await authorizeOpenCodeNativeTool(input, context)).toMatchObject({
    decision: 'deny',
  });
  expect(check).toHaveBeenCalledTimes(1);
});
test('aborted or malformed websearch never prompts', async () => {
  expect(
    await authorizeOpenCodeNativeTool({ ...input, toolArgs: {} }, context),
  ).toMatchObject({ decision: 'deny' });
  expect(
    await authorizeOpenCodeNativeTool(input, {
      ...context,
      signal: AbortSignal.abort(),
    }),
  ).toMatchObject({ decision: 'deny' });
  expect(check).not.toHaveBeenCalled();
});
