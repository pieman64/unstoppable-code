import {
  capabilityPackageAnalysisResultSchema,
  projectCapabilityPackageAnalysis,
  capabilityRepairSubjectSchema,
  capabilityRepairAnalysisContextSchema,
  sanitizeCapabilityRepairText,
} from '..';

it('projects an exhausted text budget without failing on an empty dismissal token', () => {
  const result = projectCapabilityPackageAnalysis({
    analysisId: 'temporary',
    pipelineContentHash: '',
    expiresAt: '',
    state: 'blocked',
    blockers: Array.from({ length: 25 }, () => ({
      code: 'UNRESOLVED_INVOCATION',
      message: 'x'.repeat(2048),
      occurrences: [],
      dismissal: { provider: 'claude', token: '/missing' },
    })),
  });
  expect(result.state).toBe('blocked');
  expect(result.truncated).toBe(true);
  expect(
    result.blockers.every(
      (row) => row.dismissal === undefined || row.dismissal.token.length > 0,
    ),
  ).toBe(true);
});
it('rejects a failed result without a useful error', () => {
  const result = projectCapabilityPackageAnalysis({
    analysisId: '',
    pipelineContentHash: '',
    expiresAt: '',
    state: 'ready',
    blockers: [],
  });
  expect(
    capabilityPackageAnalysisResultSchema.safeParse({
      ...result,
      state: 'failed',
    }).success,
  ).toBe(false);
});

it.each([
  'sk-abcdefghijklmnopqrstuvwxyz',
  'ghp_abcdefghijklmnopqrstuvwxyz',
  'xoxb-abcdefghijklmnopqrstuvwxyz',
  'eyJabcdefghijk.abcdefghijk.abcdefghijk',
])('redacts secret signatures and rejects sensitive locators %s', (secret) => {
  expect(sanitizeCapabilityRepairText(`Value: ${secret}`)).not.toContain(
    secret,
  );
  expect(
    capabilityRepairSubjectSchema.safeParse({
      kind: 'user-pipeline',
      pipelineId: secret,
    }).success,
  ).toBe(false);
  expect(
    capabilityRepairAnalysisContextSchema.safeParse({
      dismissedInvocations: [{ provider: 'claude', token: secret }],
    }).success,
  ).toBe(false);
});
it('rejects a result that exceeds the total contract bound even with individually valid fields', () => {
  const base = projectCapabilityPackageAnalysis({
    analysisId: '',
    pipelineContentHash: '',
    expiresAt: '',
    state: 'blocked',
    blockers: [],
  });
  const large = {
    ...base,
    blockers: Array.from({ length: 25 }, () => ({
      code: 'CODE',
      message: 'x'.repeat(2048),
      subject: 'y'.repeat(512),
      occurrences: [],
      omittedOccurrences: 0,
    })),
  };
  expect(capabilityPackageAnalysisResultSchema.safeParse(large).success).toBe(
    false,
  );
});
