import {
  codexApprovalPolicyFor,
  codexSandboxModeFor,
  codexSandboxPolicyFor,
} from '../codex/approval-policy';

describe('Codex approval policy', () => {
  it('routes granular Ask and Auto approvals through Canopy', () => {
    for (const mode of ['ask', 'auto'] as const) {
      expect(codexApprovalPolicyFor(mode)).toEqual({
        granular: {
          sandbox_approval: true,
          rules: true,
          skill_approval: true,
          request_permissions: true,
          mcp_elicitations: true,
        },
      });
    }
  });

  it('preserves unrestricted Full Access behavior', () => {
    expect(codexApprovalPolicyFor('full-access')).toBe('never');
    expect(codexSandboxModeFor('full-access')).toBe('danger-full-access');
    expect(codexSandboxPolicyFor('full-access', '/repo')).toEqual({
      type: 'dangerFullAccess',
    });
  });

  it('forces Ask and Auto mutations through sandbox approval', () => {
    for (const mode of ['ask', 'auto'] as const) {
      expect(codexSandboxModeFor(mode)).toBe('read-only');
      expect(codexSandboxPolicyFor(mode, '/repo')).toEqual({
        type: 'readOnly',
        networkAccess: false,
      });
    }
  });
});
