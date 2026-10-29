import { isAbsolute, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import type { ResolvedPlanDetectionRules } from '@canopy/desktop-shared/plan-detection';
import {
  WORKSPACE_ROOT_REPO_ID,
  type PlanDetectionRule,
} from '@canopy/desktop-shared/types';

export interface CandidateMatch {
  sourceRepoId: string;
  sourceFilePath: string;
}

interface RepoRef {
  repoId: string;
  repoPath: string;
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

/**
 * Normalize a candidate path to repo-relative POSIX for the given repo, or null
 * if the candidate escapes the repo root.
 */
function toRepoRelative(candidate: string, repoPath: string): string | null {
  const abs = isAbsolute(candidate) ? candidate : resolve(repoPath, candidate);
  const rel = toPosix(relative(repoPath, abs));
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    return null;
  }
  return rel;
}

function isRootRepo(repoId: string): boolean {
  return repoId === WORKSPACE_ROOT_REPO_ID || repoId === '__worktree__';
}

function candidateRepos(candidate: string, repos: RepoRef[]): RepoRef[] {
  const reposBySpecificity = [...repos].sort(
    (a, b) => resolve(b.repoPath).length - resolve(a.repoPath).length,
  );
  if (isAbsolute(candidate)) {
    return reposBySpecificity;
  }
  if (repos.length === 1) {
    return repos;
  }
  return repos.filter((repo) => isRootRepo(repo.repoId));
}

export function matchCandidatePaths(args: {
  candidatePaths: string[];
  repos: RepoRef[];
  rules: ResolvedPlanDetectionRules;
}): CandidateMatch[] {
  const { candidatePaths, repos, rules } = args;
  if (rules.includes.length === 0) {
    return [];
  }
  const isIncluded = picomatch(
    rules.includes.map((rule: PlanDetectionRule) => rule.pattern),
    { dot: true },
  );
  const isExcluded = picomatch(
    rules.excludes.map((rule: PlanDetectionRule) => rule.pattern),
    { dot: true },
  );
  const seen = new Set<string>();
  const matches: CandidateMatch[] = [];
  for (const candidate of candidatePaths) {
    for (const repo of candidateRepos(candidate, repos)) {
      const rel = toRepoRelative(candidate, repo.repoPath);
      if (rel === null) {
        continue;
      }
      if (!isIncluded(rel) || isExcluded(rel)) {
        continue;
      }
      const key = `${repo.repoId}::${rel}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      matches.push({ sourceRepoId: repo.repoId, sourceFilePath: rel });
      break; // most specific containing repo wins
    }
  }
  return matches;
}
