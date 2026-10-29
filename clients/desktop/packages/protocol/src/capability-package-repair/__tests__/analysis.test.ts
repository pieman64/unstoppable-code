import {
  CAPABILITY_REPAIR_LIMITS,
  failedCapabilityPackageAnalysis,
  projectCapabilityPackageAnalysis,
  sanitizeCapabilityRepairText,
} from '..';
import type { PipelinePackageAnalysisSummary } from '../../pipelines';

const summary: PipelinePackageAnalysisSummary = {
  analysisId: 'private-analysis-id',
  state: 'ready',
  pipelineContentHash: 'hash',
  blockers: [],
  expiresAt: '',
};
describe('portable capability repair analysis', () => {
  it('marks a bounded failure message as truncated without reporting readiness', () => {
    const result = failedCapabilityPackageAnalysis(
      new Error('failure '.repeat(1000)),
    );
    expect(result).toMatchObject({ state: 'failed', truncated: true });
    expect(result.error?.length).toBeLessThanOrEqual(
      CAPABILITY_REPAIR_LIMITS.message,
    );
  });
  it.each([
    'read /Users/alice/private/SKILL.md: failed',
    'read C:\\Users\\alice\\private\\SKILL.md: failed',
    'read \\\\server\\share\\private\\SKILL.md: failed',
    'read file:///home/alice/private/SKILL.md: failed',
    'error=/home/alice/private/SKILL.md',
    'failed [/Users/alice/private/SKILL.md]',
    'read "/Users/alice smith/private/SKILL.md": failed',
    'read "C:\\Users\\alice smith\\private\\SKILL.md": failed',
    'read "\\\\server\\my share\\private\\SKILL.md": failed',
  ])('redacts embedded host paths: %s', (message) => {
    const safe = sanitizeCapabilityRepairText(message);
    expect(safe).toContain('[redacted host path]');
    expect(safe).not.toMatch(/alice|server|private|smith|my share/);
  });
  it.each([
    'API_KEY=very-secret',
    'token: "very-secret"',
    '{"api_key":"very-secret"}',
    'password=very-secret',
    'Authorization: Bearer very-secret',
    'https://user:very-secret@example.com',
    '-----BEGIN PRIVATE KEY-----\nvery-secret\n-----END PRIVATE KEY-----',
  ])('redacts secrets: %s', (message) => {
    expect(sanitizeCapabilityRepairText(message)).not.toContain('very-secret');
  });
  it('preserves safe exact diagnostics and relative locations', () => {
    const result = projectCapabilityPackageAnalysis({
      ...summary,
      state: 'blocked',
      blockers: [
        {
          code: 'UNRESOLVED_INVOCATION',
          subject: '/missing',
          message: 'Run /missing in step "review".',
          relativePath: 'scripts/check.ts',
          occurrences: [{ jobId: 'build', stepId: 'review' }],
        },
      ],
    });
    expect(result).toMatchObject({
      state: 'blocked',
      blockers: [
        {
          subject: '/missing',
          message: 'Run /missing in step "review".',
          relativePath: 'scripts/check.ts',
          occurrences: [{ jobId: 'build', stepId: 'review' }],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private-analysis-id');
  });
  it('uses analyzer state as well as blocker presence', () => {
    expect(
      projectCapabilityPackageAnalysis({ ...summary, state: 'blocked' }).state,
    ).toBe('blocked');
    expect(
      projectCapabilityPackageAnalysis({
        ...summary,
        blockers: [
          { code: 'INVALID_PACKAGE', message: 'bad', occurrences: [] },
        ],
      }).state,
    ).toBe('blocked');
  });
  it('bounds rows, individual fields, occurrences and total serialized size without changing readiness', () => {
    const result = projectCapabilityPackageAnalysis({
      ...summary,
      blockers: Array.from({ length: 100 }, () => ({
        code: 'INVALID_PACKAGE' as const,
        subject: '\\'.repeat(10000),
        message: '"'.repeat(10000),
        dismissal: { provider: 'claude', token: '/ignore' },
        occurrences: Array.from({ length: 50 }, () => ({
          jobId: 'job'.repeat(1000),
          stepId: 'step'.repeat(1000),
        })),
      })),
    });
    expect(result.state).toBe('blocked');
    expect(result.truncated).toBe(true);
    expect(result.omitted.blockers).toBeGreaterThanOrEqual(75);
    expect(result.blockers[0]?.message.length).toBeLessThanOrEqual(2048);
    expect(result.blockers[0]?.omittedOccurrences).toBe(40);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      CAPABILITY_REPAIR_LIMITS.result,
    );
  });
});
