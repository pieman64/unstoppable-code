jest.mock('@canopy/desktop-shared/lib/git', () => ({
  hasRemoteTrackingBranch: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  getCurrentBranch: jest.fn(),
  getUncommittedDiff: jest.fn(),
  stageAllChanges: jest.fn(),
  commitWithMessage: jest.fn(),
  pushBranch: jest.fn(),
}));

jest.mock('../_lib/repo-discovery', () => ({
  discoverWorkspaceRepos: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/lib/commit-message-generator', () => ({
  generateCommitMessageWithUsage: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  hasRemoteTrackingBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  getCurrentBranch,
  getUncommittedDiff,
  stageAllChanges,
  commitWithMessage,
  pushBranch,
} from '@canopy/desktop-shared/lib/git';
import { generateCommitMessageWithUsage } from '@canopy/desktop-shared/lib/commit-message-generator';
import { resetRunDir } from '../_lib/output';
import { discoverWorkspaceRepos } from '../_lib/repo-discovery';
import { runGitCommitPushAction } from '../git-commit-push/runner';

const mockedDiscoverWorkspaceRepos = jest.mocked(discoverWorkspaceRepos);
const mockedHasRemoteTrackingBranch = jest.mocked(hasRemoteTrackingBranch);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedHasUnpushedCommits = jest.mocked(hasUnpushedCommits);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetUncommittedDiff = jest.mocked(getUncommittedDiff);
const mockedStageAllChanges = jest.mocked(stageAllChanges);
const mockedCommitWithMessage = jest.mocked(commitWithMessage);
const mockedPushBranch = jest.mocked(pushBranch);
const mockedGenerateCommitMessageWithUsage = jest.mocked(
  generateCommitMessageWithUsage,
);

function readOutputMap(outputFile: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(outputFile, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
}

describe('git-commit-push action', () => {
  let tempDir: string;
  let outputFile: string;
  let repoPath: string;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-commit-push-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    repoPath = path.join(tempDir, 'repo-a');
    fs.mkdirSync(repoPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates a commit message, commits, and pushes when the repo is dirty', async () => {
    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath,
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetUncommittedDiff.mockResolvedValue('diff content');
    mockedCommitWithMessage.mockResolvedValue('abc123');
    mockedStageAllChanges.mockResolvedValue();
    mockedPushBranch.mockResolvedValue();
    mockedGenerateCommitMessageWithUsage.mockResolvedValue({
      message: 'feat: generated commit',
      usage: {},
      source: 'model',
    });

    await runGitCommitPushAction({ CANOPY_OUTPUT: outputFile });

    expect(mockedGenerateCommitMessageWithUsage).toHaveBeenCalledWith({
      repoPath,
      branchName: 'feature/test',
      diff: 'diff content',
      model: 'haiku',
      thinkingLevel: 'off',
      instructions:
        'Write a concise conventional-commit style commit message. Subject line under 72 characters. Include a body only when the changes are complex enough to warrant explanation.',
      instructionMode: 'replace',
      // No PREF_LOCAL_MEMORY_ENABLED env var in this test: local memory is
      // opt-in and treated as OFF (CAN-1969).
      localMemoryEnabled: false,
    });
    expect(mockedCommitWithMessage).toHaveBeenCalledWith(
      repoPath,
      'feat: generated commit',
    );
    expect(mockedPushBranch).toHaveBeenCalledWith(repoPath);

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      status: string;
      commitHash: string;
      commitMessage: string;
    }>;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'committed_and_pushed',
      commitHash: 'abc123',
      commitMessage: 'feat: generated commit',
    });
  });

  it('redacts a configured secret value the model echoes into the generated commit message', async () => {
    // generateCommitMessageWithUsage invokes the configured model with this
    // subprocess's own env, which inherits `secretEnv` alongside every
    // other var — the model CAN read a pipeline secret, and if it echoes
    // one into the commit message, results_json/results_file/summary_file
    // all write straight to disk, bypassing the parent process's
    // stdout-level `SecretValueRedactor` entirely.
    const secret = 'sekret-commit-value-77889';
    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath,
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetUncommittedDiff.mockResolvedValue('diff content');
    mockedCommitWithMessage.mockResolvedValue('abc123');
    mockedStageAllChanges.mockResolvedValue();
    mockedPushBranch.mockResolvedValue();
    mockedGenerateCommitMessageWithUsage.mockResolvedValue({
      message: `feat: uses ${secret} internally`,
      usage: {},
      source: 'model',
    });

    await runGitCommitPushAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });

    const outputs = readOutputMap(outputFile);
    expect(outputs.results_json).not.toContain(secret);
    const resultsFile = fs.readFileSync(outputs.results_file, 'utf8');
    expect(resultsFile).not.toContain(secret);
    const summaryFile = fs.readFileSync(outputs.summary_file, 'utf8');
    expect(summaryFile).not.toContain(secret);
    // Independent-review regression: redacting only the LOCAL report copy
    // while committing the raw message leaves the actual exfiltration wide
    // open one step earlier — the secret would still land in real, pushed
    // git history even though the pipeline report says "***". The commit
    // that actually gets made (and the subsequent push) must receive the
    // redacted message too.
    expect(mockedCommitWithMessage).toHaveBeenCalledWith(
      repoPath,
      expect.not.stringContaining(secret),
    );
  });

  it('accepts max and empty commit thinking levels explicitly', async () => {
    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath,
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetUncommittedDiff.mockResolvedValue('diff content');
    mockedCommitWithMessage.mockResolvedValue('abc123');
    mockedStageAllChanges.mockResolvedValue();
    mockedPushBranch.mockResolvedValue();
    mockedGenerateCommitMessageWithUsage.mockResolvedValue({
      message: 'feat: generated commit',
      usage: {},
      source: 'model',
    });

    await runGitCommitPushAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_COMMIT_THINKING_LEVEL: 'max',
    });

    expect(mockedGenerateCommitMessageWithUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinkingLevel: 'max' }),
    );

    mockedGenerateCommitMessageWithUsage.mockClear();
    await runGitCommitPushAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_COMMIT_THINKING_LEVEL: '',
    });

    expect(mockedGenerateCommitMessageWithUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinkingLevel: 'off' }),
    );
  });

  it('rejects legacy auto commit thinking levels', async () => {
    await expect(
      runGitCommitPushAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_COMMIT_THINKING_LEVEL: 'auto',
      }),
    ).rejects.toThrow(
      /commit_thinking_level must be one of: off, low, medium, high, xhigh, max/,
    );
    expect(mockedDiscoverWorkspaceRepos).not.toHaveBeenCalled();
  });

  it('fails when commit message generation falls back', async () => {
    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath,
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetUncommittedDiff.mockResolvedValue('diff content');
    mockedGenerateCommitMessageWithUsage.mockResolvedValue({
      message: 'Feature test',
      usage: {},
      source: 'fallback',
    });

    await runGitCommitPushAction({ CANOPY_OUTPUT: outputFile });

    expect(mockedStageAllChanges).not.toHaveBeenCalled();
    expect(mockedCommitWithMessage).not.toHaveBeenCalled();
    expect(mockedPushBranch).not.toHaveBeenCalled();

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      status: string;
      error: string;
    }>;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'failed',
      error:
        'Commit message generation returned fallback content instead of model output.',
    });
  });

  it('marks commit failures so desktop pipeline runs can fire failure hooks', async () => {
    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath,
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetUncommittedDiff.mockResolvedValue('diff content');
    mockedStageAllChanges.mockResolvedValue();
    mockedCommitWithMessage.mockRejectedValue(
      Object.assign(new Error('Command failed: git commit'), {
        stderr: 'pre-commit hook failed\n',
      }),
    );
    mockedGenerateCommitMessageWithUsage.mockResolvedValue({
      message: 'feat: generated commit',
      usage: {},
      source: 'model',
    });

    await runGitCommitPushAction({ CANOPY_OUTPUT: outputFile });

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      status: string;
      error: string;
      failurePhase?: string;
      precommitFailureError?: string;
    }>;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'failed',
      error: 'Command failed: git commit',
      failurePhase: 'commit',
      precommitFailureError: 'pre-commit hook failed',
    });
    expect(mockedPushBranch).not.toHaveBeenCalled();
  });

  it('redacts a multi-line configured secret from a commit failure message even after single-line normalization', async () => {
    // Independent-review regression: the `error` field is single-line
    // normalized (`.replace(/\s+/g, ' ')`) before being reported. If
    // redaction ran AFTER that normalization, a multi-line configured
    // secret (e.g. a PEM key) echoed verbatim by a failing pre-commit hook
    // would have its internal newlines collapsed FIRST, breaking the
    // exact-string match before redaction ever gets a chance to find it.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath,
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetUncommittedDiff.mockResolvedValue('diff content');
    mockedStageAllChanges.mockResolvedValue();
    mockedCommitWithMessage.mockRejectedValue(
      new Error(`Command failed: found secret ${secret} in staged file`),
    );
    mockedGenerateCommitMessageWithUsage.mockResolvedValue({
      message: 'feat: generated commit',
      usage: {},
      source: 'model',
    });

    await runGitCommitPushAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      error: string;
    }>;
    expect(results[0]?.error).not.toContain('BEGIN-FAKE-KEY');
    expect(results[0]?.error).not.toContain('abcdef');
  });

  it('redacts a single-line configured secret whose internal whitespace differs from the raw echo', async () => {
    // Independent-review regression: redacting BEFORE normalizing (the fix
    // for the multi-line case above) alone still misses a single-line
    // secret whose internal whitespace the failing command's output
    // reformatted (e.g. a newline where the secret has a plain space) — the
    // raw text does not exact-match the secret, so redaction leaves it
    // untouched, and normalizing afterward then reconstitutes the exact
    // secret string. Only a redact pass AFTER normalizing (or the
    // equivalent single-pass expanded-value match) catches this.
    const secret = 'correct horse battery staple';
    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath,
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetUncommittedDiff.mockResolvedValue('diff content');
    mockedStageAllChanges.mockResolvedValue();
    mockedCommitWithMessage.mockRejectedValue(
      new Error(
        `Command failed: found secret correct horse\nbattery staple in staged file`,
      ),
    );
    mockedGenerateCommitMessageWithUsage.mockResolvedValue({
      message: 'feat: generated commit',
      usage: {},
      source: 'model',
    });

    await runGitCommitPushAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      error: string;
    }>;
    expect(results[0]?.error).not.toContain(secret);
    expect(results[0]?.error).not.toContain('correct horse');
    expect(results[0]?.error).not.toContain('battery staple');
  });

  it('redacts a multi-line configured secret from precommitFailureError even when echoed verbatim', async () => {
    // precommitFailureError (the raw `error.stderr` via
    // `getUnderlyingErrorText`) protects a verbatim (byte-exact) occurrence
    // of a configured secret through `redactNormalizedPreservingFormat`,
    // which also keeps the stderr's own line structure.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath,
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetUncommittedDiff.mockResolvedValue('diff content');
    mockedStageAllChanges.mockResolvedValue();
    mockedCommitWithMessage.mockRejectedValue(
      Object.assign(new Error('Command failed: git commit'), {
        stderr: `pre-commit hook rejected:\n${secret}\n`,
      }),
    );
    mockedGenerateCommitMessageWithUsage.mockResolvedValue({
      message: 'feat: generated commit',
      usage: {},
      source: 'model',
    });

    await runGitCommitPushAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      precommitFailureError?: string;
    }>;
    expect(results[0]?.precommitFailureError).not.toContain('BEGIN-FAKE-KEY');
    expect(results[0]?.precommitFailureError).not.toContain('line2-abcdef');
    expect(results[0]?.precommitFailureError).not.toContain('END-FAKE-KEY');
  });

  it('preserves multi-line hook output structure in precommitFailureError instead of collapsing it to a single line', async () => {
    // Independent-review regression: `redactNormalizedText` unconditionally
    // whitespace-collapses its ENTIRE input (not just around a matched
    // secret), including when no secret is configured at all.
    // `precommitFailureError` is exported as
    // `CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR` for user-authored hook
    // scripts and agent prompts, which can depend on its multi-line
    // structure (e.g. a lint report with one finding per line) — collapsing
    // it to one line on every run, secrets or not, would be a real,
    // unconditional fidelity regression, not a security improvement.
    const lintReport = [
      'src/a.ts 12:3 error Unexpected console statement no-console',
      'src/b.ts 7:9 error Missing return type explicit-function-return-type',
      '2 problems (2 errors, 0 warnings)',
    ].join('\n');
    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath,
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(true);
    mockedHasRemoteTrackingBranch.mockResolvedValue(false);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedGetUncommittedDiff.mockResolvedValue('diff content');
    mockedStageAllChanges.mockResolvedValue();
    mockedCommitWithMessage.mockRejectedValue(
      Object.assign(new Error('Command failed: git commit'), {
        stderr: lintReport,
      }),
    );
    mockedGenerateCommitMessageWithUsage.mockResolvedValue({
      message: 'feat: generated commit',
      usage: {},
      source: 'model',
    });

    await runGitCommitPushAction({ CANOPY_OUTPUT: outputFile });

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      precommitFailureError?: string;
    }>;
    expect(results[0]?.precommitFailureError).toBe(lintReport);
  });
});
