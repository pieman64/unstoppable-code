/* eslint-disable @typescript-eslint/no-explicit-any */
jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/lib/git', () => ({
  getCommitLog: jest.fn(),
  getCurrentBranch: jest.fn(),
  getFullDiff: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  hasRemoteTrackingBranch: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  pushBranch: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/lib/github-pr-generator', () => ({
  generatePrContentWithUsage: jest.fn(),
}));

jest.mock('../_lib/repo-discovery', () => ({
  discoverWorkspaceRepos: jest.fn(),
}));

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getCommitLog,
  getCurrentBranch,
  getFullDiff,
  getRemoteDefaultBranch,
  hasRemoteTrackingBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  pushBranch,
} from '@canopy/desktop-shared/lib/git';
import { generatePrContentWithUsage } from '@canopy/desktop-shared/lib/github-pr-generator';
import { resetRunDir } from '../_lib/output';
import { discoverWorkspaceRepos } from '../_lib/repo-discovery';
import { runGitHubCreatePrAction } from '../github-create-pr/runner';

const mockedExecFile = jest.mocked(execFile);
const mockedDiscoverWorkspaceRepos = jest.mocked(discoverWorkspaceRepos);
const mockedGetCommitLog = jest.mocked(getCommitLog);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetFullDiff = jest.mocked(getFullDiff);
const mockedGetRemoteDefaultBranch = jest.mocked(getRemoteDefaultBranch);
const mockedHasRemoteTrackingBranch = jest.mocked(hasRemoteTrackingBranch);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedHasUnpushedCommits = jest.mocked(hasUnpushedCommits);
const mockedPushBranch = jest.mocked(pushBranch);
const mockedGeneratePrContentWithUsage = jest.mocked(
  generatePrContentWithUsage,
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

function mockPrCreation(
  url: string = 'https://github.com/org/repo/pull/13\n',
): void {
  mockedExecFile.mockImplementation((...callArgs: any[]) => {
    const args = callArgs[1] as readonly string[];
    const callback = callArgs[3] as
      | ((
          error: Error | null,
          result?: { stdout: string; stderr: string },
        ) => void)
      | undefined;
    if (!callback) {
      return {} as never;
    }

    const joinedArgs = args.join(' ');
    if (joinedArgs.includes('repo view')) {
      callback(null, {
        stdout: '{"defaultBranchRef":{"name":"main"}}',
        stderr: '',
      });
      return {} as never;
    }

    if (joinedArgs.includes('pr list') && !joinedArgs.includes('create')) {
      callback(null, { stdout: '[]', stderr: '' });
      return {} as never;
    }

    if (joinedArgs.includes('pr create')) {
      callback(null, { stdout: url, stderr: '' });
      return {} as never;
    }

    callback(new Error(`unexpected gh command: ${joinedArgs}`));
    return {} as never;
  });
}

describe('github-create-pr action', () => {
  let tempDir: string;
  let outputFile: string;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-create-pr-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    delete process.env.CANOPY_BASE_BRANCH;
    delete process.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE;
    delete process.env.CANOPY_BASE_BRANCH_BY_REPO;
    delete process.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO;

    mockedDiscoverWorkspaceRepos.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'repo-a',
        repoPath: '/workspace/repo-a',
        relativePath: '.',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValue('feature/test');
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedGetFullDiff.mockResolvedValue('diff content');
    mockedGetCommitLog.mockResolvedValue('abc123 feat: change');
    mockedGetRemoteDefaultBranch.mockResolvedValue('main');
    mockedHasRemoteTrackingBranch.mockResolvedValue(true);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedPushBranch.mockResolvedValue();
    mockedGeneratePrContentWithUsage.mockResolvedValue({
      content: {
        title: 'Test PR',
        body: 'Body content',
      },
      usage: {},
      source: 'model',
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an existing PR without creating a new one', async () => {
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list')) {
        callback(null, {
          stdout:
            '[{"number":12,"title":"Existing PR","url":"https://github.com/org/repo/pull/12","baseRefName":"main","headRefName":"feature/test","isDraft":false}]',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({ CANOPY_OUTPUT: outputFile });

    expect(mockedGeneratePrContentWithUsage).not.toHaveBeenCalled();

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      status: string;
      prNumber: number;
      title: string;
    }>;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'existing',
      prNumber: 12,
      title: 'Existing PR',
    });
  });

  it('creates a PR when none exists', async () => {
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list') && !joinedArgs.includes('create')) {
        callback(null, {
          stdout:
            joinedArgs.includes('--state open') && joinedArgs.includes('--json')
              ? '[]'
              : '[]',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr create')) {
        callback(null, {
          stdout: 'https://github.com/org/repo/pull/13\n',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({ CANOPY_OUTPUT: outputFile });

    expect(mockedGeneratePrContentWithUsage).toHaveBeenCalledWith({
      repoPath: '/workspace/repo-a',
      branchName: 'feature/test',
      baseBranch: 'main',
      diff: 'diff content',
      commitLog: 'abc123 feat: change',
      model: 'sonnet',
      thinkingLevel: 'high',
      instructions: '',
      instructionMode: 'append',
      // No PREF_LOCAL_MEMORY_ENABLED env var in this test: local memory is
      // opt-in and treated as OFF (CAN-1969).
      localMemoryEnabled: false,
    });

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      status: string;
      prUrl: string;
      title: string;
    }>;

    expect(results[0].status).toBe('created');
    expect(results[0].title).toBe('Test PR');
    expect(results[0].prUrl).toBe('https://github.com/org/repo/pull/13');
  });

  it('redacts a configured secret value the model echoes into the generated PR title', async () => {
    // generatePrContentWithUsage invokes the configured model with this
    // subprocess's own env, which inherits `secretEnv` alongside every
    // other var — the model CAN read a pipeline secret, and if it echoes
    // one into the PR title, results_json/results_file/summary_file all
    // write straight to disk, bypassing the parent process's stdout-level
    // `SecretValueRedactor` entirely.
    const secret = 'sekret-pr-value-99001';
    let bodyFileContent = '';
    let capturedTitleArg = '';
    mockedGeneratePrContentWithUsage.mockResolvedValue({
      content: {
        title: `Test PR using ${secret}`,
        body: `Body content mentioning ${secret}`,
      },
      usage: {},
      source: 'model',
    });
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list') && !joinedArgs.includes('create')) {
        callback(null, { stdout: '[]', stderr: '' });
        return {} as never;
      }

      if (joinedArgs.includes('pr create')) {
        // Independent-review regression: redacting only the LOCAL report
        // copy while posting the raw title/body leaves the actual
        // exfiltration wide open one step earlier — the secret would still
        // land on the real, possibly shared or public PR even though the
        // pipeline report says "***". Capture exactly what `gh pr create`
        // was actually invoked with, the same way the real CLI would see it.
        const titleIndex = args.indexOf('--title');
        capturedTitleArg = titleIndex >= 0 ? (args[titleIndex + 1] ?? '') : '';
        const bodyFileIndex = args.indexOf('--body-file');
        const bodyFilePath =
          bodyFileIndex >= 0 ? args[bodyFileIndex + 1] : undefined;
        if (bodyFilePath) {
          bodyFileContent = fs.readFileSync(bodyFilePath, 'utf8');
        }
        callback(null, {
          stdout: 'https://github.com/org/repo/pull/13\n',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });

    expect(capturedTitleArg).not.toContain(secret);
    expect(bodyFileContent).not.toContain(secret);
    const outputs = readOutputMap(outputFile);
    expect(outputs.results_json).not.toContain(secret);
    const resultsFile = fs.readFileSync(outputs.results_file, 'utf8');
    expect(resultsFile).not.toContain(secret);
    const summaryFile = fs.readFileSync(outputs.summary_file, 'utf8');
    expect(summaryFile).not.toContain(secret);
  });

  it('redacts a single-line configured secret from the actual gh pr create title whose internal whitespace differs from the raw echo', async () => {
    // Independent-review regression: `title` used plain `redactValues`
    // instead of `redactNormalizedText` (a PR title is single-line by
    // convention, so normalizing is safe, unlike `body`), so a secret
    // whose internal whitespace the model reformatted while echoing it
    // into the title was never redacted — on the ACTUAL `gh pr create`
    // call, not just the local report.
    const secret = 'correct horse battery staple';
    let capturedTitleArg = '';
    mockedGeneratePrContentWithUsage.mockResolvedValue({
      content: {
        title: 'Fix issue: correct horse\nbattery staple',
        body: 'Body content',
      },
      usage: {},
      source: 'model',
    });
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list') && !joinedArgs.includes('create')) {
        callback(null, { stdout: '[]', stderr: '' });
        return {} as never;
      }

      if (joinedArgs.includes('pr create')) {
        const titleIndex = args.indexOf('--title');
        capturedTitleArg = titleIndex >= 0 ? (args[titleIndex + 1] ?? '') : '';
        callback(null, {
          stdout: 'https://github.com/org/repo/pull/13\n',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });

    expect(capturedTitleArg).not.toContain(secret);
    expect(capturedTitleArg).not.toContain('correct horse');
    expect(capturedTitleArg).not.toContain('battery staple');
  });

  it('accepts max and empty PR thinking levels explicitly', async () => {
    mockPrCreation();

    await runGitHubCreatePrAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_THINKING_LEVEL: 'max',
    });

    expect(mockedGeneratePrContentWithUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinkingLevel: 'max' }),
    );

    mockedGeneratePrContentWithUsage.mockClear();
    await runGitHubCreatePrAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_THINKING_LEVEL: '',
    });

    expect(mockedGeneratePrContentWithUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ thinkingLevel: 'high' }),
    );
  });

  it('rejects legacy auto PR thinking levels', async () => {
    await expect(
      runGitHubCreatePrAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PR_THINKING_LEVEL: 'auto',
      }),
    ).rejects.toThrow(
      /pr_thinking_level must be one of: off, low, medium, high, xhigh, max/,
    );
    expect(mockedDiscoverWorkspaceRepos).not.toHaveBeenCalled();
  });

  it('uses a remote-backed configured base branch for PR creation', async () => {
    process.env.CANOPY_BASE_BRANCH = 'develop';
    process.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE = 'true';

    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list')) {
        callback(null, {
          stdout: '[]',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr create')) {
        callback(null, {
          stdout: 'https://github.com/org/repo/pull/22\n',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({ CANOPY_OUTPUT: outputFile });

    expect(mockedGeneratePrContentWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'develop',
      }),
    );
    expect(
      mockedExecFile.mock.calls.some((call) =>
        (call[1] as readonly string[])
          .join(' ')
          .includes('pr create --base develop'),
      ),
    ).toBe(true);
  });

  it('falls back to the default branch when the configured base is local-only', async () => {
    process.env.CANOPY_BASE_BRANCH = 'release/1.2';
    process.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE = 'false';

    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list')) {
        callback(null, {
          stdout: '[]',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr create')) {
        callback(null, {
          stdout: 'https://github.com/org/repo/pull/23\n',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({ CANOPY_OUTPUT: outputFile });

    expect(mockedGeneratePrContentWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'main',
      }),
    );
  });

  it('prefers repo-scoped base-branch env over singular vars', async () => {
    process.env.CANOPY_BASE_BRANCH = 'main';
    process.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE = 'true';
    process.env.CANOPY_BASE_BRANCH_BY_REPO = JSON.stringify({
      'repo-a': 'develop',
    });
    process.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE_BY_REPO = JSON.stringify({
      'repo-a': 'true',
    });

    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list')) {
        callback(null, {
          stdout: '[]',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr create')) {
        callback(null, {
          stdout: 'https://github.com/org/repo/pull/24\n',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({ CANOPY_OUTPUT: outputFile });

    expect(mockedGeneratePrContentWithUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'develop',
      }),
    );
  });

  it('keeps the existing PR base branch even when env prefers another base', async () => {
    process.env.CANOPY_BASE_BRANCH = 'develop';
    process.env.CANOPY_BASE_BRANCH_EXISTS_IN_REMOTE = 'true';

    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list')) {
        callback(null, {
          stdout:
            '[{"number":12,"title":"Existing PR","url":"https://github.com/org/repo/pull/12","baseRefName":"main","headRefName":"feature/test","isDraft":false}]',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({ CANOPY_OUTPUT: outputFile });

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      status: string;
      baseBranch: string;
    }>;

    expect(results[0].status).toBe('existing');
    expect(results[0].baseBranch).toBe('main');
  });

  it('creates a new PR when only a closed PR exists for the branch', async () => {
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (
        joinedArgs.includes('repo view') &&
        joinedArgs.includes('defaultBranchRef')
      ) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (
        joinedArgs.includes('pr list') &&
        joinedArgs.includes('--state open')
      ) {
        callback(null, {
          stdout: '[]',
          stderr: '',
        });
        return {} as never;
      }

      if (
        joinedArgs.includes('pr list') &&
        joinedArgs.includes('--state closed')
      ) {
        callback(null, {
          stdout:
            '[{"number":11,"title":"Old Closed PR","url":"https://github.com/org/repo/pull/11","baseRefName":"main","headRefName":"feature/test","isDraft":false}]',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr create')) {
        callback(new Error('a pull request already exists for feature/test'));
        return {} as never;
      }

      if (
        joinedArgs.includes('repo view') &&
        joinedArgs.includes('nameWithOwner')
      ) {
        callback(null, {
          stdout: '{"nameWithOwner":"org/repo"}',
          stderr: '',
        });
        return {} as never;
      }

      if (
        joinedArgs.includes('api repos/org/repo/pulls') &&
        joinedArgs.includes('--method POST')
      ) {
        callback(null, {
          stdout:
            '{"number":13,"title":"Test PR","html_url":"https://github.com/org/repo/pull/13","head":{"ref":"feature/test"},"base":{"ref":"main"},"draft":false}',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({ CANOPY_OUTPUT: outputFile });

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      status: string;
      prNumber: number;
      prUrl: string;
      title: string;
    }>;

    expect(results[0]).toMatchObject({
      status: 'created',
      prNumber: 13,
      prUrl: 'https://github.com/org/repo/pull/13',
      title: 'Test PR',
    });
  });

  it('fails when PR content generation falls back', async () => {
    mockedGeneratePrContentWithUsage.mockResolvedValue({
      content: {
        title: 'Feature test',
        body: '',
      },
      usage: {},
      source: 'fallback',
    });

    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list') && !joinedArgs.includes('create')) {
        callback(null, {
          stdout: '[]',
          stderr: '',
        });
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({ CANOPY_OUTPUT: outputFile });

    const outputs = readOutputMap(outputFile);
    const results = JSON.parse(outputs.results_json) as Array<{
      status: string;
      error: string;
    }>;

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: 'failed',
      error:
        'PR content generation returned fallback content instead of model output.',
    });
    expect(
      mockedExecFile.mock.calls.some((call) =>
        (call[1] as readonly string[]).join(' ').includes('pr create'),
      ),
    ).toBe(false);
  });

  it('controller truncation regression: masks malformed gh output before creating a truncated diagnostic', async () => {
    const secret = 'sk-live-abcdef0123456789XYZ';
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      callback?.(null, { stdout: 'X'.repeat(190) + secret, stderr: '' });
      return {} as never;
    });
    await runGitHubCreatePrAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });
    const outputs = readOutputMap(outputFile);
    expect(outputs.results_json).not.toContain(secret.slice(0, 10));
  });

  it('normalizes the posted PR title but not the body, with no secrets configured', async () => {
    // Both are unconditional: `redactNormalizedText` normalizes even when the
    // value list is empty. The title collapsing is intended (single-line by
    // convention, and it leaves the machine); the body keeping its structure is
    // equally intended. Pinned because neither is obvious from the call site.
    mockedGeneratePrContentWithUsage.mockResolvedValue({
      content: {
        title: 'Fix\tthe   thing',
        body: '# Heading\n\n- one\n- two\n\n```\ncode  block\n```\n',
      },
      usage: {},
      source: 'model',
    });
    let postedTitle: string | undefined;
    let postedBodyFile: string | undefined;
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) return {} as never;
      const joined = args.join(' ');
      if (joined.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }
      if (joined.includes('pr list') && !joined.includes('create')) {
        callback(null, { stdout: '[]', stderr: '' });
        return {} as never;
      }
      if (joined.includes('pr create')) {
        const titleAt = args.indexOf('--title');
        const bodyAt = args.indexOf('--body-file');
        postedTitle = titleAt === -1 ? undefined : args[titleAt + 1];
        // Read it HERE: the temp body file is removed once the action returns.
        postedBodyFile =
          bodyAt === -1
            ? undefined
            : fs.readFileSync(String(args[bodyAt + 1]), 'utf8');
        callback(null, {
          stdout: 'https://github.com/o/r/pull/1',
          stderr: '',
        });
        return {} as never;
      }
      callback(null, { stdout: '', stderr: '' });
      return {} as never;
    });

    // No CANOPY_AGENT_SECRET_VALUES at all.
    await runGitHubCreatePrAction({ CANOPY_OUTPUT: outputFile });

    expect(postedTitle).toBe('Fix the thing');
    expect(postedBodyFile).toBeDefined();
    // The body keeps every newline and its run of spaces.
    expect(postedBodyFile).toContain('# Heading\n\n- one\n- two');
    expect(postedBodyFile).toContain('code  block');
  });

  it("does not carry the parser's own input excerpt into the diagnostic", async () => {
    // V8's `JSON.parse` message embeds a SHORTENED excerpt of the input:
    // `Unexpected token 's', "{"a":sk-live-ab"... is not valid JSON`. That
    // 10-character fragment is not an exact match for the configured value, so
    // masking the message could not recognise it and it reached `results_json`,
    // `results_file` and `summary_file`. Masking the raw payload separately does
    // not help — the excerpt is already a different, shorter string.
    const secret = 'sk-live-abcdef0123456789XYZ';
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      callback?.(null, { stdout: `{"a":${secret}}`, stderr: '' });
      return {} as never;
    });
    await runGitHubCreatePrAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });
    const outputs = readOutputMap(outputFile);
    for (const field of [
      outputs.results_json,
      fs.readFileSync(outputs.results_file, 'utf8'),
      fs.readFileSync(outputs.summary_file, 'utf8'),
    ]) {
      expect(field).not.toContain('sk-live-ab');
      // The failure is still described, from the parser's category rather than
      // its excerpt. (This V8 variant is the one that carries no position; the
      // positional variants are covered below.)
      expect(field).toContain('invalid JSON: unexpected token');
    }
  });

  it('keeps the parser location facts when V8 reports them', async () => {
    // The positional variants describe the input's SHAPE (how far the parse
    // got), not its content, so they stay in the diagnostic.
    const secret = 'sk-live-abcdef0123456789XYZ';
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      // Unterminated string: `... in JSON at position N (line 1 column N+1)`.
      callback?.(null, { stdout: `{"a":"${secret}`, stderr: '' });
      return {} as never;
    });
    await runGitHubCreatePrAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });
    const outputs = readOutputMap(outputFile);
    expect(outputs.results_json).not.toContain('sk-live-ab');
    expect(outputs.results_json).toContain('invalid JSON at line 1 column');
  });

  it('masks a configured value whose whitespace gh reformatted, before truncating', async () => {
    // The preview was masked with
    // verbatim-only matching and THEN cut at 200 characters, so a value
    // echoed with a newline where the value has a space survived as a
    // cleartext prefix that the later normalized pass could no longer match.
    const secret = 'BEGIN PRIVATE KEY ZZZZZ ALPHA BRAVO CHARLIE';
    const echoed = `${'x'.repeat(170)}BEGIN PRIVATE KEY\nZZZZZ ALPHA BRAVO CHARLIE trailing junk`;
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      callback?.(null, { stdout: echoed, stderr: '' });
      return {} as never;
    });
    await runGitHubCreatePrAction({
      CANOPY_OUTPUT: outputFile,
      CANOPY_AGENT_SECRET_VALUES: JSON.stringify([secret]),
    });
    const outputs = readOutputMap(outputFile);
    expect(outputs.results_json).not.toContain('BEGIN PRIVATE KEY');
    expect(outputs.results_json).not.toContain('ZZZZZ');
  });

  it('redacts a multi-line configured secret from a PR creation failure message even after single-line normalization', async () => {
    // Independent-review regression: the `error` field is single-line
    // normalized (`.replace(/\s+/g, ' ')`) before being reported. If
    // redaction ran AFTER that normalization, a multi-line configured
    // secret (e.g. a PEM key) echoed verbatim by a failing `gh` command
    // would have its internal newlines collapsed FIRST, breaking the
    // exact-string match before redaction ever gets a chance to find it.
    const secret = 'BEGIN-FAKE-KEY\nline2-abcdef\nEND-FAKE-KEY';
    mockedGeneratePrContentWithUsage.mockResolvedValue({
      content: { title: 'Test PR', body: 'Body content' },
      usage: {},
      source: 'model',
    });
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list') && !joinedArgs.includes('create')) {
        callback(null, { stdout: '[]', stderr: '' });
        return {} as never;
      }

      if (joinedArgs.includes('pr create')) {
        callback(new Error(`Command failed: found secret ${secret} in body`));
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({
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
    // secret whose internal whitespace the failing `gh` command's output
    // reformatted (e.g. a newline where the secret has a plain space) — the
    // raw text does not exact-match the secret, so redaction leaves it
    // untouched, and normalizing afterward then reconstitutes the exact
    // secret string. Only a redact pass AFTER normalizing (or the
    // equivalent single-pass expanded-value match) catches this.
    const secret = 'correct horse battery staple';
    mockedGeneratePrContentWithUsage.mockResolvedValue({
      content: { title: 'Test PR', body: 'Body content' },
      usage: {},
      source: 'model',
    });
    mockedExecFile.mockImplementation((...callArgs: any[]) => {
      const args = callArgs[1] as readonly string[];
      const callback = callArgs[3] as
        | ((
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void)
        | undefined;
      if (!callback) {
        return {} as never;
      }

      const joinedArgs = args.join(' ');
      if (joinedArgs.includes('repo view')) {
        callback(null, {
          stdout: '{"defaultBranchRef":{"name":"main"}}',
          stderr: '',
        });
        return {} as never;
      }

      if (joinedArgs.includes('pr list') && !joinedArgs.includes('create')) {
        callback(null, { stdout: '[]', stderr: '' });
        return {} as never;
      }

      if (joinedArgs.includes('pr create')) {
        callback(
          new Error(
            'Command failed: found secret correct horse\nbattery staple in body',
          ),
        );
        return {} as never;
      }

      callback(new Error(`unexpected gh command: ${joinedArgs}`));
      return {} as never;
    });

    await runGitHubCreatePrAction({
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
});
