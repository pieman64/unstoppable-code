import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  getCombinedDiffText,
  getHeadCommitSha,
  getMergeBaseForBranch,
  listUntrackedFiles,
} from './git';
import { isPathInside } from './path-safety';
import { isMultiRepoWorkspace } from './workspace-registry';
import { getWorktreeDir } from './paths';
import { listWorkspaceWorktreeRepoEntries } from './worktree-repo-entries';
import { resolveEffectiveBaseBranchForRepo } from './worktree-base-branches';

export interface ReviewRepoRef {
  repoId: string;
  repoName?: string;
  repoPath: string;
  baseBranch?: string | null;
}

async function resolveReviewRepoRef(params: {
  projectId: string;
  worktreeId: string;
  repoId: string;
  repoName?: string;
  repoPath: string;
}): Promise<ReviewRepoRef> {
  const effectiveBaseBranch = await resolveEffectiveBaseBranchForRepo({
    projectId: params.projectId,
    worktreeId: params.worktreeId,
    repoId: params.repoId,
    repoPath: params.repoPath,
  });

  return {
    repoId: params.repoId,
    ...(params.repoName ? { repoName: params.repoName } : {}),
    repoPath: params.repoPath,
    baseBranch: effectiveBaseBranch.branch,
  };
}

/**
 * Enumerate the repos to review for a worktree. This must mirror exactly
 * what the Changed Files activity panel shows (`getWorkspaceChangedFiles` /
 * `activityChangedFiles` handler in `../ipc/activity-panel.ts`): multi-repo
 * workspaces enumerate child repos plus the synthetic workspace-root repo
 * (when the workspace root itself is a git repo), single-repo projects are
 * just the one worktree directory.
 */
export async function listReviewRepos(
  projectId: string,
  worktreeId: string,
): Promise<ReviewRepoRef[]> {
  const worktreePath = getWorktreeDir(projectId, worktreeId);
  if (isMultiRepoWorkspace(projectId)) {
    const entries = await listWorkspaceWorktreeRepoEntries(
      projectId,
      worktreePath,
    );
    return Promise.all(
      entries.map((entry) =>
        resolveReviewRepoRef({
          projectId,
          worktreeId,
          repoId: entry.repoId,
          repoName: entry.repoName,
          repoPath: entry.repoPath,
        }),
      ),
    );
  }
  return [
    await resolveReviewRepoRef({
      projectId,
      worktreeId,
      repoId: 'default',
      repoPath: worktreePath,
    }),
  ];
}

export async function computeReviewFingerprint(
  repos: ReviewRepoRef[],
): Promise<string> {
  const hash = createHash('sha256');
  const sorted = [...repos].sort((a, b) => a.repoId.localeCompare(b.repoId));
  for (const repo of sorted) {
    const [head, mergeBase, untracked] = await Promise.all([
      getHeadCommitSha(repo.repoPath),
      getMergeBaseForBranch(repo.repoPath, repo.baseBranch ?? undefined),
      listUntrackedFiles(repo.repoPath),
    ]);
    const diffText = await getCombinedDiffText(
      repo.repoPath,
      repo.baseBranch ?? undefined,
      mergeBase,
    );
    hash.update(repo.repoId);
    hash.update('\0');
    hash.update(repo.baseBranch ?? '');
    hash.update('\0');
    hash.update(head ?? '');
    hash.update('\0');
    hash.update(mergeBase ?? '');
    hash.update('\0');
    hash.update(diffText);
    hash.update('\0');
    for (const file of [...untracked].sort()) {
      let signature = `${file}:missing`;
      try {
        const info = await lstat(join(repo.repoPath, file));
        signature = `${file}:${info.size}:${Math.floor(info.mtimeMs)}`;
      } catch {
        // Keep the 'missing' signature — the file vanished mid-scan.
      }
      hash.update(signature);
      hash.update('\n');
    }
  }
  return hash.digest('hex');
}

const MAX_FILE_DIFF_LINES = 400;
const MAX_TOTAL_DIFF_LINES = 8000;
const MAX_UNTRACKED_FILE_LINES = 200;
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;

type SafeUntrackedFile =
  | { status: 'content'; content: string }
  | { status: 'too-large' };

export interface ReviewDiffBundle {
  text: string;
  truncated: boolean;
}

export function truncateUnifiedDiff(
  text: string,
  maxFileLines: number,
  maxTotalLines: number,
): { text: string; truncated: boolean } {
  if (text.length === 0) {
    return { text, truncated: false };
  }
  const lines = text.split('\n');
  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      sections.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    sections.push(current);
  }
  const out: string[] = [];
  let truncated = false;
  for (const section of sections) {
    const perFileTruncated = section.length > maxFileLines;
    const cappedSection = perFileTruncated
      ? [...section.slice(0, maxFileLines), '[diff truncated]']
      : section;

    // Check against the remaining budget (not just whether the cap was
    // already hit) so a section that would push the running total past
    // maxTotalLines is omitted rather than appended in full.
    const remainingBudget = maxTotalLines - out.length;
    if (remainingBudget <= 0 || cappedSection.length > remainingBudget) {
      out.push('[remaining file diffs omitted]');
      truncated = true;
      break;
    }

    if (perFileTruncated) {
      truncated = true;
    }
    out.push(...cappedSection);
  }
  const joined = out.join('\n');
  return { text: joined, truncated: truncated || joined !== text };
}

function looksBinary(content: string): boolean {
  return content.includes('\0');
}

function lineCount(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

async function readSafeUntrackedFile(
  repoPath: string,
  file: string,
): Promise<SafeUntrackedFile | null> {
  const candidate = resolve(repoPath, file);
  if (!isPathInside(repoPath, candidate)) {
    return null;
  }

  try {
    const info = await lstat(candidate);
    if (!info.isFile()) {
      return null;
    }
    const [repoRealPath, candidateRealPath] = await Promise.all([
      realpath(repoPath),
      realpath(candidate),
    ]);
    if (!isPathInside(repoRealPath, candidateRealPath)) {
      return null;
    }
    if (info.size > MAX_UNTRACKED_FILE_BYTES) {
      return { status: 'too-large' };
    }
    return { status: 'content', content: await readFile(candidate, 'utf8') };
  } catch {
    return null;
  }
}

export async function buildReviewDiffBundle(
  repos: ReviewRepoRef[],
): Promise<ReviewDiffBundle> {
  const parts: string[] = [];
  let truncated = false;
  let remainingDiffLineBudget = MAX_TOTAL_DIFF_LINES;
  const sorted = [...repos].sort((a, b) => a.repoId.localeCompare(b.repoId));
  for (const repo of sorted) {
    const [diffText, untracked] = await Promise.all([
      getCombinedDiffText(repo.repoPath, repo.baseBranch ?? undefined),
      listUntrackedFiles(repo.repoPath),
    ]);
    const sectionParts: string[] = [];
    if (diffText.trim().length > 0) {
      if (remainingDiffLineBudget <= 0) {
        truncated = true;
      } else {
        const capped = truncateUnifiedDiff(
          diffText,
          MAX_FILE_DIFF_LINES,
          remainingDiffLineBudget,
        );
        truncated = truncated || capped.truncated;
        remainingDiffLineBudget = capped.text.includes(
          '[remaining file diffs omitted]',
        )
          ? 0
          : remainingDiffLineBudget - lineCount(capped.text);
        sectionParts.push(capped.text);
      }
    }
    for (const file of [...untracked].sort()) {
      const safeFile = await readSafeUntrackedFile(repo.repoPath, file);
      if (safeFile === null) {
        continue;
      }
      if (safeFile.status === 'too-large') {
        sectionParts.push(`## New file (too large, contents omitted): ${file}`);
        truncated = true;
        continue;
      }
      const { content } = safeFile;
      if (looksBinary(content)) {
        sectionParts.push(`## New file (binary, contents omitted): ${file}`);
        continue;
      }
      const fileLines = content.split('\n');
      const capped = fileLines.slice(0, MAX_UNTRACKED_FILE_LINES);
      truncated = truncated || capped.length < fileLines.length;
      sectionParts.push(
        [
          `## New file: ${file}`,
          '```',
          ...capped,
          ...(capped.length < fileLines.length ? ['[file truncated]'] : []),
          '```',
        ].join('\n'),
      );
    }
    if (sectionParts.length > 0) {
      parts.push(
        [
          `# Repo: ${repo.repoName ?? repo.repoId} (id: ${repo.repoId})`,
          ...sectionParts,
        ].join('\n\n'),
      );
    }
  }
  return { text: parts.join('\n\n'), truncated };
}
