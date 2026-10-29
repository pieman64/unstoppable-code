import { evaluateApproval } from '@canopy/desktop-shared/lib/approval-engine';
import type { ApprovalSessionHandle } from '../approvals/approval-service';
import { authorizeOpenCodeNativeTool } from '../opencode/tool-approval';

const check = jest.fn<
  ReturnType<ApprovalSessionHandle['check']>,
  Parameters<ApprovalSessionHandle['check']>
>();
const context = {
  cwd: '/workspace',
  approval: { check, setMode: jest.fn(), dispose: jest.fn() },
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
