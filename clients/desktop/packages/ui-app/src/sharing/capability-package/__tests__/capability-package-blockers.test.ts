import type { PipelinePackageAnalysisBlocker } from '@canopy/protocol/pipelines';
import {
  buildCapabilityPackageProblems,
  DISMISSIBLE_BLOCKER_CODES,
  slugifyProblemPart,
} from '../capability-package-blockers';

function blocker(
  overrides: Partial<PipelinePackageAnalysisBlocker> &
    Pick<PipelinePackageAnalysisBlocker, 'code'>,
): PipelinePackageAnalysisBlocker {
  return {
    message: 'Required invocation /collect.py could not be resolved.',
    occurrences: [],
    ...overrides,
  };
}

describe('buildCapabilityPackageProblems', () => {
  it('formats an unresolved invocation from its code and subject', () => {
    const [problem] = buildCapabilityPackageProblems([
      blocker({
        code: 'UNRESOLVED_INVOCATION',
        subject: '/collect.py',
        origin: 'direct',
        dismissal: { provider: 'claude', token: '/collect.py' },
      }),
    ]);

    expect(problem?.title).toBe('/collect.py was not found');
    expect(problem?.detail).toBe(
      'Install it, or mark it as not a command if the prompt only mentions it.',
    );
    // The main-process prose survives as technical detail, never as the lead.
    expect(problem?.message).toContain('could not be resolved');
    expect(problem?.dismissible).toBe(true);
  });

  it('asks the author to share again after an invalid package', () => {
    const [problem] = buildCapabilityPackageProblems([
      blocker({ code: 'INVALID_PACKAGE' }),
    ]);
    expect(problem?.detail).toBe('Close this and share again to recheck.');
  });

  it('tells a transitive reference apart from a direct one', () => {
    const [problem] = buildCapabilityPackageProblems([
      blocker({
        code: 'UNRESOLVED_INVOCATION',
        subject: '$review:gone',
        origin: 'transitive',
        dismissal: { provider: 'codex', token: '$review:gone' },
      }),
    ]);

    expect(problem?.detail).toBe(
      'A packaged dependency references it. Install it, or mark it as not a command.',
    );
  });

  it('does not offer dismissal copy for a structured transitive reference', () => {
    const [problem] = buildCapabilityPackageProblems([
      blocker({
        code: 'UNRESOLVED_INVOCATION',
        subject: '$review:gone',
        origin: 'transitive',
      }),
    ]);

    expect(problem?.detail).toBe(
      'A packaged dependency references it. Install it.',
    );
    expect(problem?.dismissible).toBe(false);
  });

  it.each([
    ['file_size', 'big-skill/model.bin is larger than 4 MB'],
    ['file_count', 'big-skill/notes/1025.md goes past the 1,024-file limit'],
    ['total_size', 'big-skill/model.bin pushes the share past 32 MB'],
  ] as const)(
    'names the file to leave out when a %s limit is hit',
    (limit, title) => {
      const subject =
        limit === 'file_count'
          ? 'big-skill/notes/1025.md'
          : 'big-skill/model.bin';
      const [problem] = buildCapabilityPackageProblems([
        blocker({ code: 'PACKAGE_LIMIT_EXCEEDED', limit, subject }),
      ]);

      expect(problem?.title).toBe(title);
      expect(problem?.detail).toBe('Move it out of the shared folder.');
      expect(problem?.dismissible).toBe(false);
    },
  );

  it('ranks security findings above unresolved tokens', () => {
    const problems = buildCapabilityPackageProblems([
      blocker({ code: 'INVALID_PACKAGE' }),
      blocker({ code: 'UNRESOLVED_INVOCATION', subject: '/collect.py' }),
      blocker({ code: 'AMBIGUOUS_INVOCATION', subject: '/review-multi' }),
      blocker({
        code: 'EXPORT_DENIED_FILE',
        subject: '.git/config',
        relativePath: '.git/config',
      }),
      blocker({
        code: 'SUSPECTED_SECRET',
        subject: 'skills/deploy/SKILL.md',
      }),
    ]);

    expect(problems.map((problem) => problem.code)).toEqual([
      'SUSPECTED_SECRET',
      'EXPORT_DENIED_FILE',
      'AMBIGUOUS_INVOCATION',
      'UNRESOLVED_INVOCATION',
      'INVALID_PACKAGE',
    ]);
  });

  it('derives a slug from identity, not list position', () => {
    const first = buildCapabilityPackageProblems([
      blocker({ code: 'UNRESOLVED_INVOCATION', subject: '/collect.py' }),
      blocker({ code: 'AMBIGUOUS_INVOCATION', subject: '/review-multi' }),
    ]);
    const reordered = buildCapabilityPackageProblems([
      blocker({ code: 'AMBIGUOUS_INVOCATION', subject: '/review-multi' }),
      blocker({ code: 'UNRESOLVED_INVOCATION', subject: '/collect.py' }),
    ]);

    expect(first.map((problem) => problem.slug)).toEqual(
      reordered.map((problem) => problem.slug),
    );
    expect(first[1]?.slug).toBe('unresolved-invocation-collect-py');
  });

  it('keeps colliding normalized slugs stable when input order changes', () => {
    const first = buildCapabilityPackageProblems([
      blocker({ code: 'UNRESOLVED_INVOCATION', subject: '/review+a' }),
      blocker({ code: 'UNRESOLVED_INVOCATION', subject: '/review a' }),
    ]);
    const reordered = buildCapabilityPackageProblems([
      blocker({ code: 'UNRESOLVED_INVOCATION', subject: '/review a' }),
      blocker({ code: 'UNRESOLVED_INVOCATION', subject: '/review+a' }),
    ]);
    const bySubject = (problems: typeof first): Record<string, string> =>
      Object.fromEntries(
        problems.map((problem) => [problem.subject ?? '', problem.slug]),
      );

    expect(bySubject(first)).toEqual(bySubject(reordered));
    expect(new Set(first.map((problem) => problem.slug)).size).toBe(2);
  });

  it('keeps same-token provider problems as distinct rows', () => {
    const problems = buildCapabilityPackageProblems([
      blocker({
        code: 'UNRESOLVED_INVOCATION',
        subject: '/shared-token',
        dismissal: { provider: 'claude', token: '/shared-token' },
      }),
      blocker({
        code: 'UNRESOLVED_INVOCATION',
        subject: '/shared-token',
        dismissal: { provider: 'codex', token: '/shared-token' },
      }),
    ]);

    expect(new Set(problems.map((problem) => problem.slug)).size).toBe(2);
    expect(problems.map((problem) => problem.dismissal?.provider)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('falls back to the legacy message when a subject is absent', () => {
    const [problem] = buildCapabilityPackageProblems([
      blocker({
        code: 'UNRESOLVED_INVOCATION',
        message: 'Required invocation could not be resolved.',
      }),
    ]);

    expect(problem?.title).toBe('Required invocation could not be resolved.');
  });

  it('never marks a security finding dismissible, even with a dismissal hint', () => {
    const [problem] = buildCapabilityPackageProblems([
      blocker({
        code: 'SUSPECTED_SECRET',
        subject: 'skills/deploy/SKILL.md',
        dismissal: { provider: 'claude', token: '/deploy' },
      }),
    ]);

    expect(problem?.dismissible).toBe(false);
    expect(DISMISSIBLE_BLOCKER_CODES.has('SUSPECTED_SECRET')).toBe(false);
    expect(DISMISSIBLE_BLOCKER_CODES.size).toBe(1);
  });

  it('slugifies tokens into stable testid fragments', () => {
    expect(slugifyProblemPart('/quality-control-structural-v2.json')).toBe(
      'quality-control-structural-v2-json',
    );
    expect(slugifyProblemPart('$review:gone')).toBe('review-gone');
    expect(slugifyProblemPart('///')).toBe('item');
  });
});
