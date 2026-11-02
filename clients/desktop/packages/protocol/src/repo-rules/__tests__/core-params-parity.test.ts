import { z } from 'zod';
import {
  CoreWorkspaceRepoRulesApplyParamsSchema,
  CoreWorkspaceRepoRulesPreviewParamsSchema,
  CoreWorkspaceRepoRulesScanParamsSchema,
  CoreWorkspaceRepoRulesStatusParamsSchema,
} from '../../canopy-core';
import {
  repoRulesApplyRequestSchema,
  repoRulesPreviewRequestSchema,
  repoRulesScanRequestSchema,
} from '..';

// The repo-rules IPC projection parses with the desktop request schema and
// then dispatches the same object, so the core params must accept exactly
// what the request schema accepts.
const PAIRS: Array<[string, z.ZodType, z.ZodType, unknown[]]> = [
  [
    'scan',
    repoRulesScanRequestSchema,
    CoreWorkspaceRepoRulesScanParamsSchema,
    [
      { workspaceId: 'w' },
      { workspaceId: 'w', worktreeId: 'feature-1' },
      { workspaceId: 'w', worktreeId: undefined },
      { workspaceId: '' },
      { workspaceId: 'Bad_Id' },
      { workspaceId: 'a'.repeat(129) },
      { workspaceId: 'w', root: '/tmp' },
      undefined,
    ],
  ],
  [
    'status',
    repoRulesScanRequestSchema.pick({ workspaceId: true }),
    CoreWorkspaceRepoRulesStatusParamsSchema,
    [{ workspaceId: 'w' }, { workspaceId: 'w', worktreeId: 'x' }, {}],
  ],
  [
    'preview',
    repoRulesPreviewRequestSchema,
    CoreWorkspaceRepoRulesPreviewParamsSchema,
    [
      {
        workspaceId: 'w',
        scanId: '12345678-1234-4234-8234-123456789abc',
        ruleId: 'r',
      },
      { workspaceId: 'w', scanId: 'not-a-uuid', ruleId: 'r' },
      {
        workspaceId: 'w',
        scanId: '12345678-1234-4234-8234-123456789abc',
        ruleId: 'r'.repeat(4097),
      },
    ],
  ],
  [
    'apply',
    repoRulesApplyRequestSchema,
    CoreWorkspaceRepoRulesApplyParamsSchema,
    [
      { workspaceId: 'w', enabled: false },
      {
        workspaceId: 'w',
        enabled: true,
        scanId: '12345678-1234-4234-8234-123456789abc',
        disabledRuleIds: ['r'],
      },
      { workspaceId: 'w' },
      { workspaceId: 'w', enabled: true, disabledRuleIds: ['r'.repeat(4097)] },
      {
        workspaceId: 'w',
        enabled: true,
        disabledRuleIds: Array.from({ length: 201 }, (_, i) => `r${i}`),
      },
    ],
  ],
];

describe('core.workspace.repoRules params mirror the desktop request schemas', () => {
  it.each(PAIRS)('%s', (_name, request, params, fixtures) => {
    expect(z.toJSONSchema(params)).toEqual(z.toJSONSchema(request));
    for (const fixture of fixtures) {
      const legacy = request.safeParse(fixture);
      const core = params.safeParse(fixture);
      expect(core.success).toBe(legacy.success);
      if (legacy.success && core.success)
        expect(core.data).toEqual(legacy.data);
    }
  });
});
