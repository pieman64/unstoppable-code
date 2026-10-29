import { matchCandidatePaths } from '../lib/detected-plan-matcher';
import type { ResolvedPlanDetectionRules } from '@canopy/desktop-shared/plan-detection';

const rules: ResolvedPlanDetectionRules = {
  includes: [
    {
      id: 'i',
      label: 'i',
      kind: 'include',
      pattern: 'docs/superpowers/specs/*.md',
      enabled: true,
    },
  ],
  excludes: [
    {
      id: 'e',
      label: 'e',
      kind: 'exclude',
      pattern: 'docs/superpowers/specs/*-design.md',
      enabled: true,
    },
  ],
};
const repos = [{ repoId: 'repo-a', repoPath: '/wt/repos/repo-a' }];

it('matches an absolute path inside a repo, repo-relative', () => {
  const out = matchCandidatePaths({
    candidatePaths: ['/wt/repos/repo-a/docs/superpowers/specs/plan.md'],
    repos,
    rules,
  });
  expect(out).toEqual([
    {
      sourceRepoId: 'repo-a',
      sourceFilePath: 'docs/superpowers/specs/plan.md',
    },
  ]);
});

it('matches a repo-relative candidate', () => {
  const out = matchCandidatePaths({
    candidatePaths: ['docs/superpowers/specs/plan.md'],
    repos,
    rules,
  });
  expect(out).toEqual([
    {
      sourceRepoId: 'repo-a',
      sourceFilePath: 'docs/superpowers/specs/plan.md',
    },
  ]);
});

it('does not attribute ambiguous relative candidates to the first child repo', () => {
  const out = matchCandidatePaths({
    candidatePaths: ['docs/superpowers/specs/plan.md'],
    repos: [
      { repoId: 'repo-a', repoPath: '/wt/repos/repo-a' },
      { repoId: 'repo-b', repoPath: '/wt/repos/repo-b' },
    ],
    rules,
  });

  expect(out).toEqual([]);
});

it('matches relative candidates against the project root when available', () => {
  const out = matchCandidatePaths({
    candidatePaths: ['docs/superpowers/specs/plan.md'],
    repos: [
      { repoId: '__workspace_root__', repoPath: '/wt' },
      { repoId: 'repo-a', repoPath: '/wt/repos/repo-a' },
    ],
    rules,
  });

  expect(out).toEqual([
    {
      sourceRepoId: '__workspace_root__',
      sourceFilePath: 'docs/superpowers/specs/plan.md',
    },
  ]);
});

it('exclude wins', () => {
  const out = matchCandidatePaths({
    candidatePaths: ['docs/superpowers/specs/plan-design.md'],
    repos,
    rules,
  });
  expect(out).toEqual([]);
});

it('drops candidates matching no include', () => {
  const out = matchCandidatePaths({
    candidatePaths: ['src/x.ts'],
    repos,
    rules,
  });
  expect(out).toEqual([]);
});

it('dedupes the same repo-relative path seen twice', () => {
  const out = matchCandidatePaths({
    candidatePaths: [
      'docs/superpowers/specs/plan.md',
      '/wt/repos/repo-a/docs/superpowers/specs/plan.md',
    ],
    repos,
    rules,
  });
  expect(out).toHaveLength(1);
});

it('prefers nested child repos over the project root for absolute candidates', () => {
  const out = matchCandidatePaths({
    candidatePaths: ['/wt/repos/repo-a/docs/superpowers/specs/plan.md'],
    repos: [
      { repoId: '__workspace_root__', repoPath: '/wt' },
      { repoId: 'repo-a', repoPath: '/wt/repos/repo-a' },
    ],
    rules,
  });

  expect(out).toEqual([
    {
      sourceRepoId: 'repo-a',
      sourceFilePath: 'docs/superpowers/specs/plan.md',
    },
  ]);
});
