import type { ApprovalSessionHandle } from '../approvals/approval-service';
import { authorizeCopilotNativeTool } from '../copilot/tool-approval';

const check = jest.fn<
  ReturnType<ApprovalSessionHandle['check']>,
  Parameters<ApprovalSessionHandle['check']>
>();
const context = {
  cwd: '/workspace',
  approval: {
    check,
    setMode: jest.fn(),
    dispose: jest.fn(),
    reevaluatePendingApprovals: jest.fn(),
  },
  planMode: false,
  signal: new AbortController().signal,
  toolUseId: 'file-change',
};

beforeEach(() => {
  check.mockReset();
  check.mockResolvedValue({ decision: 'allow' });
});

test.each([
  [
    'edit',
    { path: 'a', old_str: 'old', new_str: '' },
    { kind: 'edit', oldText: 'old', newText: '' },
  ],
  [
    'create',
    { path: 'a', file_text: 'x'.repeat(20_001) },
    { kind: 'write', content: 'x'.repeat(20_000), truncated: true },
  ],
])(
  'native %s preserves bounded preview details without changing the rule target',
  async (toolName, toolArgs, change) => {
    expect(
      await authorizeCopilotNativeTool(
        {
          toolName,
          toolArgs,
          timestamp: new Date(1),
          sessionId: 'session',
          workingDirectory: '/workspace',
        },
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
        suggestedTarget: { kind: 'file-write', path: '/workspace/a' },
        toolUseId: 'file-change',
      }),
    );
  },
);
