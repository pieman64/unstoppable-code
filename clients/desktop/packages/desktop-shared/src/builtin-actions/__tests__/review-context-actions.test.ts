jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resetRunDir } from '../_lib/output';
import { runGitWorkspaceDetailsAction } from '../git-workspace-details/runner';
import { runGithubFetchBranchPrAction } from '../github-fetch-branch-pr/runner';
import { runGithubPostReviewCommentAction } from '../github-post-review-comment/runner';

const mockedExecFile = jest.mocked(execFile);

type ExecFileCallback = (
  error: Error | null,
  result: { stdout: string; stderr: string },
) => void;

interface CommandResult {
  stdout?: string;
  stderr?: string;
  error?: string;
  onCall?: () => void;
}

type CommandResults = CommandResult | CommandResult[];

interface WorkspaceDetailsForTest {
  committedDiffAvailable: boolean;
  head: string | null;
  changedFiles: Array<{ path: string }>;
}

interface InstructionScopeForTest {
  path: string;
  appliesToFiles: string[];
}

interface BaselineClassificationForTest {
  path: string;
  origin: string;
  protectedBaseline: boolean;
  planAuthorized: boolean;
  reviewOrigin: string;
}

interface PrDetailsForTest {
  status: string;
  hasPr: boolean;
  pr: {
    number: number;
    title: string;
  };
}

function readOutputs(filePath: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function readJsonFile(filePath: string): unknown {
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return parsed;
}

function readWorkspaceDetails(filePath: string): WorkspaceDetailsForTest {
  const parsed = readJsonFile(filePath);
  if (
    !isRecord(parsed) ||
    typeof parsed.committedDiffAvailable !== 'boolean' ||
    (parsed.head !== null && typeof parsed.head !== 'string') ||
    !isUnknownArray(parsed.changedFiles)
  ) {
    throw new Error('Invalid project details test fixture output');
  }

  return {
    committedDiffAvailable: parsed.committedDiffAvailable,
    head: parsed.head,
    changedFiles: parsed.changedFiles.map((entry) => {
      if (!isRecord(entry) || typeof entry.path !== 'string') {
        throw new Error('Invalid changed file test fixture output');
      }
      return { path: entry.path };
    }),
  };
}

function readInstructionScopes(filePath: string): InstructionScopeForTest[] {
  const parsed = readJsonFile(filePath);
  if (!isUnknownArray(parsed)) {
    throw new Error('Invalid instruction scope test fixture output');
  }

  return parsed.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      !isUnknownArray(entry.appliesToFiles)
    ) {
      throw new Error('Invalid instruction scope test fixture entry');
    }

    const appliesToFiles = entry.appliesToFiles.map((filePath) => {
      if (typeof filePath !== 'string') {
        throw new Error('Invalid instruction scope applies-to entry');
      }
      return filePath;
    });

    return {
      path: entry.path,
      appliesToFiles,
    };
  });
}

function readBaselineClassifications(
  filePath: string,
): BaselineClassificationForTest[] {
  const parsed = readJsonFile(filePath);
  if (!isUnknownArray(parsed)) {
    throw new Error('Invalid baseline classification fixture output');
  }

  return parsed.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      typeof entry.origin !== 'string' ||
      typeof entry.protectedBaseline !== 'boolean'
    ) {
      throw new Error('Invalid baseline classification test fixture entry');
    }

    return {
      path: entry.path,
      origin: entry.origin,
      protectedBaseline: entry.protectedBaseline,
      planAuthorized:
        typeof entry.planAuthorized === 'boolean'
          ? entry.planAuthorized
          : false,
      reviewOrigin:
        typeof entry.reviewOrigin === 'string' ? entry.reviewOrigin : '',
    };
  });
}

function readPrDetails(filePath: string): PrDetailsForTest {
  const parsed = readJsonFile(filePath);
  if (
    !isRecord(parsed) ||
    typeof parsed.status !== 'string' ||
    typeof parsed.hasPr !== 'boolean' ||
    !isRecord(parsed.pr) ||
    typeof parsed.pr.number !== 'number' ||
    typeof parsed.pr.title !== 'string'
  ) {
    throw new Error('Invalid PR details test fixture output');
  }

  return {
    status: parsed.status,
    hasPr: parsed.hasPr,
    pr: {
      number: parsed.pr.number,
      title: parsed.pr.title,
    },
  };
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function installExecFileMock(results: Record<string, CommandResults>): void {
  const remainingResults = new Map<string, CommandResult[]>();
  for (const [key, value] of Object.entries(results)) {
    if (Array.isArray(value)) {
      remainingResults.set(key, [...value]);
    }
  }
  mockedExecFile.mockImplementation(((
    command: string,
    args: string[],
    options: unknown,
    callback?: ExecFileCallback,
  ) => {
    const commandKey = `${command} ${args.join(' ')}`;
    const cwd =
      options &&
      typeof options === 'object' &&
      'cwd' in options &&
      typeof options.cwd === 'string'
        ? options.cwd
        : '';
    const realCwd = cwd ? fs.realpathSync.native(cwd) : '';
    const scopedKey = cwd ? `${cwd}::${commandKey}` : commandKey;
    const realScopedKey = realCwd ? `${realCwd}::${commandKey}` : commandKey;
    const matchingKey = results[scopedKey]
      ? scopedKey
      : results[realScopedKey]
        ? realScopedKey
        : commandKey;
    const configuredResult = results[matchingKey];
    const result =
      (Array.isArray(configuredResult)
        ? remainingResults.get(matchingKey)?.shift()
        : configuredResult) ??
      (commandKey.match(
        /^gh api repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews\?per_page=100 --paginate --slurp$/,
      )
        ? { stdout: '[[]]\n' }
        : commandKey.match(
              /^gh api repos\/[^/]+\/[^/]+\/pulls\/\d+ --jq \.head\.sha$/,
            )
          ? { stdout: 'head-sha\n' }
          : undefined);

    if (!result) {
      callback?.(new Error(`Unexpected command: ${scopedKey}`), {
        stdout: '',
        stderr: '',
      });
      return;
    }

    result.onCall?.();

    if (result.error) {
      const error = Object.assign(new Error(result.error), {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      });
      callback?.(error, {
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      });
      return;
    }

    callback?.(null, {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
  }) as typeof execFile);
}

describe('review context builtin actions', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let outputFile: string;

  beforeEach(() => {
    resetRunDir();
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-review-context-actions-'),
    );
    outputFile = path.join(tempDir, 'canopy-output.txt');
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('gathers git project details, instruction scopes, and diff artifacts', async () => {
    fs.mkdirSync(path.join(tempDir, 'src', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'CLAUDE.md'), '# root rules\n', 'utf8');
    fs.writeFileSync(
      path.join(tempDir, 'AGENTS.md'),
      '# root agents\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'src', 'feature', 'CLAUDE.md'),
      '# feature rules\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(tempDir, 'notes.txt'),
      'todo\nnext step\n',
      'utf8',
    );

    installExecFileMock({
      'git rev-parse --show-toplevel': { stdout: `${tempDir}\n` },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/review\n' },
      'git rev-parse HEAD': { stdout: 'head123\n' },
      'git ls-remote --symref origin HEAD': {
        stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
      },
      'git merge-base origin/main HEAD': { stdout: 'abc123\n' },
      'git status --porcelain --untracked-files=normal': {
        stdout: ' M src/feature/file.ts\n?? notes.txt\n',
      },
      'git diff abc123 --name-status --find-renames --find-copies': {
        stdout: 'M\tsrc/feature/file.ts\nA\tsrc/new.ts\n',
      },
      'git diff abc123 --numstat --find-renames --find-copies': {
        stdout: '12\t3\tsrc/feature/file.ts\n4\t0\tsrc/new.ts\n',
      },
      'git diff abc123..HEAD': {
        stdout:
          'diff --git a/src/feature/file.ts b/src/feature/file.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n',
      },
      'git diff HEAD': {
        stdout:
          'diff --git a/src/feature/file.ts b/src/feature/file.ts\n@@ -10,1 +10,2 @@\n-old\n+newer\n',
      },
      'git ls-files --others --exclude-standard': { stdout: 'notes.txt\n' },
    });

    await runGitWorkspaceDetailsAction({
      CANOPY_OUTPUT: outputFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.current_branch).toBe('feature/review');
    expect(outputs.base_branch).toBe('main');
    expect(outputs.merge_base).toBe('abc123');
    expect(outputs.has_uncommitted_changes).toBe('true');
    expect(outputs.changed_file_count).toBe('3');
    expect(outputs.review_changed_file_count).toBe('3');
    expect(outputs.protected_drift_file_count).toBe('0');
    expect(outputs.instruction_file_count).toBe('3');

    const details = readWorkspaceDetails(outputs.workspace_details_file);
    expect(details.committedDiffAvailable).toBe(true);
    expect(details.head).toBe('head123');
    expect(details.changedFiles.map((entry) => entry.path)).toEqual([
      'notes.txt',
      'src/feature/file.ts',
      'src/new.ts',
    ]);

    const instructionScopes = readInstructionScopes(
      outputs.instruction_scopes_file,
    );
    expect(instructionScopes.map((entry) => entry.path)).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      'src/feature/CLAUDE.md',
    ]);

    const diffArtifact = fs.readFileSync(outputs.diff_file, 'utf8');
    expect(diffArtifact).toContain('=== COMMITTED DIFF (abc123..HEAD) ===');
    expect(diffArtifact).toContain(
      '=== UNCOMMITTED DIFF (HEAD -> working tree) ===',
    );
    expect(diffArtifact).toContain('diff --git a/notes.txt b/notes.txt');

    const reviewDiffArtifact = fs.readFileSync(
      outputs.review_diff_file,
      'utf8',
    );
    expect(reviewDiffArtifact).toBe(diffArtifact);
  });

  it('resolves branch and changed-file metadata from a plain nested repo cwd', async () => {
    const repoPath = path.join(tempDir, 'services', 'api');
    fs.mkdirSync(repoPath, { recursive: true });
    const realRepoPath = fs.realpathSync.native(repoPath);
    fs.mkdirSync(path.join(realRepoPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(realRepoPath, 'src', 'handler.ts'),
      'export const handler = true;\n',
      'utf8',
    );
    process.chdir(realRepoPath);

    installExecFileMock({
      [`${realRepoPath}::git rev-parse --show-toplevel`]: {
        stdout: `${realRepoPath}\n`,
      },
      [`${realRepoPath}::git rev-parse --abbrev-ref HEAD`]: {
        stdout: 'feature/nested-review\n',
      },
      [`${realRepoPath}::git rev-parse HEAD`]: { stdout: 'head123\n' },
      [`${realRepoPath}::git merge-base origin/main HEAD`]: {
        stdout: 'base123\n',
      },
      [`${realRepoPath}::git status --porcelain --untracked-files=normal`]: {
        stdout: ' M src/handler.ts\n',
      },
      [`${realRepoPath}::git diff base123 --name-status --find-renames --find-copies`]:
        { stdout: 'M\tsrc/handler.ts\n' },
      [`${realRepoPath}::git diff base123 --numstat --find-renames --find-copies`]:
        { stdout: '1\t0\tsrc/handler.ts\n' },
      [`${realRepoPath}::git diff base123..HEAD`]: {
        stdout:
          'diff --git a/src/handler.ts b/src/handler.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      },
      [`${realRepoPath}::git diff HEAD`]: { stdout: '' },
      [`${realRepoPath}::git ls-files --others --exclude-standard`]: {
        stdout: '',
      },
    });

    await runGitWorkspaceDetailsAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_BASE_BRANCH: 'main',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.repo_root).toBe(realRepoPath);
    expect(outputs.current_branch).toBe('feature/nested-review');
    expect(outputs.base_branch).toBe('main');
    expect(outputs.changed_file_count).toBe('1');
    expect(outputs.review_changed_file_count).toBe('1');
  });

  it('classifies current changes against a pipeline-start checkpoint', async () => {
    const portfinderPackage = '{ "name": "portfinder" }\n';
    const readmeContent = '# Updated\n';
    const workspaceDoctorPackage = '{ "name": "workspace-doctor" }\n';
    fs.mkdirSync(path.join(tempDir, 'packages', 'portfinder'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(tempDir, 'packages', 'workspace-doctor'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(tempDir, 'packages', 'portfinder', 'package.json'),
      portfinderPackage,
      'utf8',
    );
    fs.writeFileSync(path.join(tempDir, 'README.md'), readmeContent, 'utf8');
    fs.writeFileSync(
      path.join(tempDir, 'packages', 'workspace-doctor', 'package.json'),
      workspaceDoctorPackage,
      'utf8',
    );

    const checkpointFile = path.join(tempDir, 'checkpoint.json');
    fs.writeFileSync(
      checkpointFile,
      `${JSON.stringify(
        {
          version: 1,
          changedFiles: [
            {
              path: 'package.json',
              status: 'modified',
              insertions: 1,
              deletions: 0,
              exists: true,
              contentHash: hashText(
                '{ "devDependencies": { "portfinder": "file:packages/portfinder" } }\n',
              ),
            },
            {
              path: 'packages/portfinder/package.json',
              status: 'added',
              insertions: 1,
              deletions: 0,
              exists: true,
              contentHash: hashText(portfinderPackage),
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    installExecFileMock({
      'git rev-parse --show-toplevel': { stdout: `${tempDir}\n` },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/review\n' },
      'git rev-parse HEAD': { stdout: 'head123\n' },
      'git ls-remote --symref origin HEAD': {
        stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
      },
      'git merge-base origin/main HEAD': { stdout: 'abc123\n' },
      'git status --porcelain --untracked-files=normal': {
        stdout: ' M README.md\n?? packages/workspace-doctor/package.json\n',
      },
      'git diff abc123 --name-status --find-renames --find-copies': {
        stdout: 'M\tREADME.md\nA\tpackages/portfinder/package.json\n',
      },
      'git diff abc123 --numstat --find-renames --find-copies': {
        stdout: '1\t0\tREADME.md\n1\t0\tpackages/portfinder/package.json\n',
      },
      'git diff abc123..HEAD': { stdout: '' },
      'git diff HEAD': {
        stdout:
          'diff --git a/README.md b/README.md\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      },
      'git ls-files --others --exclude-standard': {
        stdout: 'packages/workspace-doctor/package.json\n',
      },
    });

    await runGitWorkspaceDetailsAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_CHECKPOINT_FILE: checkpointFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.changed_file_count).toBe('3');
    expect(outputs.pipeline_changed_file_count).toBe('3');
    expect(outputs.review_changed_file_count).toBe('2');
    expect(outputs.protected_drift_file_count).toBe('1');
    expect(outputs.protected_changed_file_count).toBe('2');
    expect(outputs.workspace_checkpoint_file).toBeTruthy();

    const baselineClassifications = readBaselineClassifications(
      outputs.baseline_classification_file,
    );
    expect(baselineClassifications).toEqual([
      {
        path: 'package.json',
        origin: 'pipeline_reverted_pre_existing',
        protectedBaseline: true,
        planAuthorized: false,
        reviewOrigin: 'protected_drift',
      },
      {
        path: 'packages/portfinder/package.json',
        origin: 'pre_existing_unchanged',
        protectedBaseline: true,
        planAuthorized: false,
        reviewOrigin: 'pre_existing_unchanged',
      },
      {
        path: 'packages/workspace-doctor/package.json',
        origin: 'pipeline_changed',
        protectedBaseline: false,
        planAuthorized: false,
        reviewOrigin: 'pipeline_changed',
      },
      {
        path: 'README.md',
        origin: 'pipeline_changed',
        protectedBaseline: false,
        planAuthorized: false,
        reviewOrigin: 'pipeline_changed',
      },
    ]);

    const pipelineChangedFiles = readBaselineClassifications(
      outputs.pipeline_changed_files_file,
    );
    expect(pipelineChangedFiles.map((entry) => entry.path)).toEqual([
      'package.json',
      'packages/workspace-doctor/package.json',
      'README.md',
    ]);

    const reviewChangedFiles = readBaselineClassifications(
      outputs.review_changed_files_file,
    );
    expect(reviewChangedFiles.map((entry) => entry.path)).toEqual([
      'packages/workspace-doctor/package.json',
      'README.md',
    ]);

    const protectedDriftFiles = readBaselineClassifications(
      outputs.protected_drift_file,
    );
    expect(protectedDriftFiles.map((entry) => entry.path)).toEqual([
      'package.json',
    ]);

    const reviewDiffArtifact = fs.readFileSync(
      outputs.review_diff_file,
      'utf8',
    );
    expect(reviewDiffArtifact).toContain('README.md');
    expect(reviewDiffArtifact).not.toContain('diff --git a/package.json');

    const workspaceSummary = fs.readFileSync(
      outputs.workspace_summary_file,
      'utf8',
    );
    expect(workspaceSummary).toContain(
      '## Baseline-Aware Change Classification (4)',
    );
    expect(workspaceSummary).toContain(
      'pre_existing_unchanged protected: packages/portfinder/package.json',
    );
    expect(workspaceSummary).toContain(
      'pipeline_reverted_pre_existing protected: package.json',
    );
  });

  it('treats modified pre-existing files as reviewable when plan scope authorizes the path', async () => {
    const currentPackageJson = '{ "scripts": { "test": "jest" } }\n';
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      currentPackageJson,
      'utf8',
    );

    const checkpointFile = path.join(tempDir, 'checkpoint.json');
    fs.writeFileSync(
      checkpointFile,
      `${JSON.stringify(
        {
          version: 1,
          changedFiles: [
            {
              path: 'package.json',
              status: 'modified',
              insertions: 1,
              deletions: 0,
              exists: true,
              contentHash: hashText('{ "scripts": {} }\n'),
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const planScopeFile = path.join(tempDir, 'plan-scope.json');
    fs.writeFileSync(
      planScopeFile,
      `${JSON.stringify(
        {
          version: 1,
          allowedExactPaths: [
            {
              path: 'package.json',
              requirementIds: ['REQ-001'],
              reason: 'Package script updates are required by the plan.',
            },
          ],
          allowedPathPrefixes: [],
          broadAreas: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    installExecFileMock({
      'git rev-parse --show-toplevel': { stdout: `${tempDir}\n` },
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/review\n' },
      'git rev-parse HEAD': { stdout: 'head123\n' },
      'git ls-remote --symref origin HEAD': {
        stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
      },
      'git merge-base origin/main HEAD': { stdout: 'abc123\n' },
      'git status --porcelain --untracked-files=normal': {
        stdout: ' M package.json\n',
      },
      'git diff abc123 --name-status --find-renames --find-copies': {
        stdout: 'M\tpackage.json\n',
      },
      'git diff abc123 --numstat --find-renames --find-copies': {
        stdout: '1\t0\tpackage.json\n',
      },
      'git diff abc123..HEAD': { stdout: '' },
      'git diff HEAD': {
        stdout:
          'diff --git a/package.json b/package.json\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      },
      'git ls-files --others --exclude-standard': { stdout: '' },
    });

    await runGitWorkspaceDetailsAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_CHECKPOINT_FILE: checkpointFile,
      INPUT_PLAN_SCOPE_FILE: planScopeFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.review_changed_file_count).toBe('1');
    expect(outputs.protected_drift_file_count).toBe('0');

    const baselineClassifications = readBaselineClassifications(
      outputs.baseline_classification_file,
    );
    expect(baselineClassifications).toEqual([
      {
        path: 'package.json',
        origin: 'pipeline_modified_pre_existing',
        protectedBaseline: true,
        planAuthorized: true,
        reviewOrigin: 'plan_authorized_pre_existing',
      },
    ]);

    const reviewDiffArtifact = fs.readFileSync(
      outputs.review_diff_file,
      'utf8',
    );
    expect(reviewDiffArtifact).toContain('diff --git a/package.json');
  }, 15_000);

  it('gathers workspace-root and child repo changes for multi-repo projects', async () => {
    const workspaceRoot = fs.realpathSync.native(tempDir);
    const childRepoPath = path.join(workspaceRoot, 'repos', 'app');
    fs.mkdirSync(path.join(childRepoPath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, 'canopy.json'),
      JSON.stringify({ version: 1, repos: [{ id: 'app', url: 'git@app' }] }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(workspaceRoot, 'CLAUDE.md'),
      '# root rules\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(childRepoPath, 'AGENTS.md'),
      '# app rules\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(childRepoPath, 'notes.md'),
      'child note\n',
      'utf8',
    );

    installExecFileMock({
      [`${workspaceRoot}::git rev-parse --show-toplevel`]: {
        stdout: `${workspaceRoot}\n`,
      },
      [`${workspaceRoot}::git rev-parse --abbrev-ref HEAD`]: {
        stdout: 'workspace-branch\n',
      },
      'git rev-parse HEAD': { stdout: 'workspace-head\n' },
      [`${workspaceRoot}::git ls-remote --symref origin HEAD`]: {
        stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
      },
      [`${workspaceRoot}::git merge-base origin/main HEAD`]: {
        stdout: 'rootbase\n',
      },
      [`${workspaceRoot}::git status --porcelain --untracked-files=normal`]: {
        stdout: ' M canopy.json\n',
      },
      [`${workspaceRoot}::git diff rootbase --name-status --find-renames --find-copies`]:
        {
          stdout: 'M\tcanopy.json\n',
        },
      [`${workspaceRoot}::git diff rootbase --numstat --find-renames --find-copies`]:
        {
          stdout: '2\t1\tcanopy.json\n',
        },
      [`${workspaceRoot}::git diff rootbase..HEAD`]: {
        stdout:
          'diff --git a/canopy.json b/canopy.json\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      },
      [`${workspaceRoot}::git diff HEAD`]: { stdout: '' },
      [`${workspaceRoot}::git ls-files --others --exclude-standard`]: {
        stdout: '',
      },
      [`${childRepoPath}::git rev-parse --show-toplevel`]: {
        stdout: `${childRepoPath}\n`,
      },
      [`${childRepoPath}::git rev-parse --abbrev-ref HEAD`]: {
        stdout: 'workspace-branch\n',
      },
      [`${childRepoPath}::git ls-remote --symref origin HEAD`]: {
        stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
      },
      [`${childRepoPath}::git merge-base origin/main HEAD`]: {
        stdout: 'childbase\n',
      },
      [`${childRepoPath}::git status --porcelain --untracked-files=normal`]: {
        stdout: ' M src/app.ts\n?? notes.md\n',
      },
      [`${childRepoPath}::git diff childbase --name-status --find-renames --find-copies`]:
        {
          stdout: 'M\tsrc/app.ts\n',
        },
      [`${childRepoPath}::git diff childbase --numstat --find-renames --find-copies`]:
        {
          stdout: '5\t2\tsrc/app.ts\n',
        },
      [`${childRepoPath}::git diff childbase..HEAD`]: {
        stdout:
          'diff --git a/src/app.ts b/src/app.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      },
      [`${childRepoPath}::git diff HEAD`]: {
        stdout:
          'diff --git a/src/app.ts b/src/app.ts\n@@ -2,1 +2,1 @@\n-old\n+working\n',
      },
      [`${childRepoPath}::git ls-files --others --exclude-standard`]: {
        stdout: 'notes.md\n',
      },
    });

    await runGitWorkspaceDetailsAction({
      CANOPY_OUTPUT: outputFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.current_branch).toBe('workspace-branch');
    expect(outputs.base_branch).toBe('main');
    expect(outputs.merge_base).toBe('');
    expect(outputs.has_uncommitted_changes).toBe('true');
    expect(outputs.changed_file_count).toBe('3');

    const details = readWorkspaceDetails(outputs.workspace_details_file);
    expect(details.committedDiffAvailable).toBe(true);
    expect(details.head).toBeNull();
    expect(details.changedFiles.map((entry) => entry.path)).toEqual([
      'canopy.json',
      'repos/app/notes.md',
      'repos/app/src/app.ts',
    ]);

    const instructionScopes = readInstructionScopes(
      outputs.instruction_scopes_file,
    );
    expect(instructionScopes).toEqual([
      {
        path: 'CLAUDE.md',
        appliesToFiles: [
          'canopy.json',
          'repos/app/notes.md',
          'repos/app/src/app.ts',
        ],
      },
      {
        path: 'repos/app/AGENTS.md',
        appliesToFiles: ['repos/app/notes.md', 'repos/app/src/app.ts'],
      },
    ]);

    const diffArtifact = fs.readFileSync(outputs.diff_file, 'utf8');
    expect(diffArtifact).toContain(
      '=== COMMITTED DIFF (per-repo merge base..HEAD) ===',
    );
    expect(diffArtifact).toContain(
      'diff --git a/repos/app/src/app.ts b/repos/app/src/app.ts',
    );
    expect(diffArtifact).toContain(
      '=== UNCOMMITTED DIFF (per-repo HEAD -> working tree) ===',
    );
    expect(diffArtifact).toContain(
      'diff --git a/repos/app/notes.md b/repos/app/notes.md',
    );
  });

  it('ignores repos subdirectories that resolve to the project root repo', async () => {
    const workspaceRoot = tempDir;
    const realWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const pseudoChildRepoPath = path.join(workspaceRoot, 'repos', 'app');
    fs.mkdirSync(pseudoChildRepoPath, { recursive: true });
    const realPseudoChildRepoPath = fs.realpathSync.native(pseudoChildRepoPath);
    fs.writeFileSync(
      path.join(workspaceRoot, 'canopy.json'),
      JSON.stringify({ version: 1, repos: [{ id: 'app', url: 'git@app' }] }),
      'utf8',
    );

    installExecFileMock({
      [`${realWorkspaceRoot}::git rev-parse --show-toplevel`]: {
        stdout: `${workspaceRoot}\n`,
      },
      [`${realWorkspaceRoot}::git rev-parse --abbrev-ref HEAD`]: {
        stdout: 'workspace-branch\n',
      },
      'git rev-parse HEAD': { stdout: 'workspace-head\n' },
      [`${realWorkspaceRoot}::git ls-remote --symref origin HEAD`]: {
        stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
      },
      [`${realWorkspaceRoot}::git merge-base origin/main HEAD`]: {
        stdout: 'rootbase\n',
      },
      [`${realWorkspaceRoot}::git status --porcelain --untracked-files=normal`]:
        {
          stdout: ' M canopy.json\n',
        },
      [`${realWorkspaceRoot}::git diff rootbase --name-status --find-renames --find-copies`]:
        {
          stdout: 'M\tcanopy.json\n',
        },
      [`${realWorkspaceRoot}::git diff rootbase --numstat --find-renames --find-copies`]:
        {
          stdout: '2\t1\tcanopy.json\n',
        },
      [`${realWorkspaceRoot}::git diff rootbase..HEAD`]: {
        stdout:
          'diff --git a/canopy.json b/canopy.json\n@@ -1,1 +1,1 @@\n-old\n+new\n',
      },
      [`${realWorkspaceRoot}::git diff HEAD`]: { stdout: '' },
      [`${realWorkspaceRoot}::git ls-files --others --exclude-standard`]: {
        stdout: '',
      },
      [`${realPseudoChildRepoPath}::git rev-parse --show-toplevel`]: {
        stdout: `${workspaceRoot}\n`,
      },
    });

    await runGitWorkspaceDetailsAction({
      CANOPY_OUTPUT: outputFile,
    });

    const outputs = readOutputs(outputFile);
    const details = readWorkspaceDetails(outputs.workspace_details_file);
    expect(details.changedFiles.map((entry) => entry.path)).toEqual([
      'canopy.json',
    ]);

    const diffArtifact = fs.readFileSync(outputs.diff_file, 'utf8');
    expect(diffArtifact).not.toContain('repos/app/');
  }, 15_000);

  it('looks up a PR by branch from a plain nested repo cwd', async () => {
    const repoPath = path.join(tempDir, 'services', 'api');
    fs.mkdirSync(repoPath, { recursive: true });
    const realRepoPath = fs.realpathSync.native(repoPath);
    process.chdir(realRepoPath);

    installExecFileMock({
      [`${realRepoPath}::git rev-parse --abbrev-ref HEAD`]: {
        stdout: 'feature/review\n',
      },
      [`${realRepoPath}::gh pr view feature/review --json number,title,body,url,state,isDraft,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,reviewDecision,updatedAt`]:
        {
          stdout: JSON.stringify({
            number: 42,
            title: 'Add code review pipeline',
            body: 'This adds a new review flow.',
            url: 'https://github.com/example/repo/pull/42',
            state: 'OPEN',
            isDraft: false,
            baseRefName: 'main',
            headRefName: 'feature/review',
            headRefOid: 'abc123def456',
            additions: 120,
            deletions: 8,
            changedFiles: 7,
            reviewDecision: 'REVIEW_REQUIRED',
            updatedAt: '2026-03-19T12:00:00Z',
          }),
        },
    });

    await runGithubFetchBranchPrAction({
      CANOPY_OUTPUT: outputFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('found');
    expect(outputs.has_pr).toBe('true');
    expect(outputs.pr_number).toBe('42');
    expect(outputs.base_branch).toBe('main');
    expect(outputs.head_branch).toBe('feature/review');
    expect(outputs.commit_sha).toBe('abc123def456');
    expect(outputs.title).toBe('Add code review pipeline');

    const details = readPrDetails(outputs.details_json_file);
    expect(details.status).toBe('found');
    expect(details.hasPr).toBe(true);
    expect(details.pr.number).toBe(42);
    expect(details.pr.title).toBe('Add code review pipeline');
  });

  it('gracefully reports when no pull request exists for the current branch', async () => {
    installExecFileMock({
      'git rev-parse --abbrev-ref HEAD': { stdout: 'feature/review\n' },
      'gh pr view feature/review --json number,title,body,url,state,isDraft,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,reviewDecision,updatedAt':
        {
          error: 'no pull requests found',
          stderr: 'no pull requests found for branch "feature/review"\n',
        },
    });

    await runGithubFetchBranchPrAction({
      CANOPY_OUTPUT: outputFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('not_found');
    expect(outputs.has_pr).toBe('false');
    expect(outputs.pr_number).toBe('');
    expect(outputs.error_message).toContain('no pull requests found');

    const summary = fs.readFileSync(outputs.summary_file, 'utf8');
    expect(summary).toContain(
      'No open pull request is associated with the current branch.',
    );
  });

  it('fails fast without deleting an existing pending review when requested', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({ body: 'Automated review body', comments: [] }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        {
          stdout: JSON.stringify([
            [
              {
                id: 77,
                state: 'PENDING',
                body: 'Human draft review',
                commit_id: 'draft-sha',
                user: { login: 'reviewer' },
              },
            ],
          ]),
        },
    });

    await expect(
      runGithubPostReviewCommentAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PR_IDENTIFIER: 'example/repo#42',
        INPUT_REVIEW_JSON_FILE: reviewFile,
        INPUT_FAIL_ON_EXISTING_PENDING_REVIEW: 'true',
      }),
    ).rejects.toThrow(
      'Existing pending GitHub review 77 by reviewer was left unchanged',
    );

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('failed');
    expect(outputs.failure_mode).toBe('existing_pending_review');
    expect(outputs.error_message).toContain(
      'fail_on_existing_pending_review is enabled',
    );
    expect(outputs.pending_review_escrow_file).toBeUndefined();
    expect(
      mockedExecFile.mock.calls.some(([, args]) => args.includes('DELETE')),
    ).toBe(false);
  });

  it('cleans up a stale automated pending review when fail-fast mode is enabled', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({ body: 'Automated review body', comments: [] }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        {
          stdout: JSON.stringify([
            [
              {
                id: 77,
                state: 'PENDING',
                body: '[//]: # (ud-ai-review)\nStale automated review',
                commit_id: 'draft-sha',
                user: { login: 'reviewer' },
              },
            ],
          ]),
        },
      'gh api repos/example/repo/pulls/42/reviews/77/comments?per_page=100 --paginate --slurp':
        { stdout: '[[]]\n' },
      'gh api repos/example/repo/pulls/42/reviews/77 --method DELETE': {
        stdout: '{"id":77}\n',
      },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: { stdout: '98765\n' },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
      INPUT_FAIL_ON_EXISTING_PENDING_REVIEW: 'true',
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.error_message).toContain(
      'Removed stale automated pending review 77',
    );
    expect(readJsonFile(outputs.pending_review_escrow_file)).toMatchObject({
      entries: [
        {
          originalReviewId: 77,
          classification: 'pre_existing_automated',
          status: 'deleted_not_restored',
        },
      ],
    });
  });

  it('leaves a human pending review untouched when it contains draft replies', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({ body: 'Automated review body', comments: [] }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":77,"state":"PENDING","body":"Human draft review","commit_id":"draft-sha","user":{"login":"reviewer"}}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/77/comments?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":701,"path":"src/human.ts","body":"Draft reply","line":9,"side":"RIGHT","in_reply_to_id":700}]]',
        },
    });

    await expect(
      runGithubPostReviewCommentAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PR_IDENTIFIER: 'example/repo#42',
        INPUT_REVIEW_JSON_FILE: reviewFile,
      }),
    ).rejects.toThrow(
      'contains a draft reply that cannot be restored without losing its thread association',
    );

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('failed');
    expect(outputs.failure_mode).toBe('pending_review_escrow_failed');
    expect(outputs.pending_review_escrow_file).toBeUndefined();
    expect(
      mockedExecFile.mock.calls.some(([, args]) => args.includes('DELETE')),
    ).toBe(false);
  });

  it('escrows, deletes, and restores a human pending review around the automated review', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\nAutomated review body',
        comments: [],
      }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        {
          stdout: JSON.stringify([
            [
              {
                id: 77,
                state: 'PENDING',
                body: 'Human draft review',
                commit_id: 'draft-sha',
                user: { login: 'reviewer' },
              },
            ],
          ]),
        },
      'gh api repos/example/repo/pulls/42/reviews/77/comments?per_page=100 --paginate --slurp':
        {
          stdout: JSON.stringify([
            [
              {
                id: 701,
                path: 'src/human.ts',
                body: 'Human draft comment',
                line: 9,
                side: 'RIGHT',
                start_line: null,
                start_side: null,
                commit_id: 'draft-sha',
              },
            ],
          ]),
        },
      'gh api repos/example/repo/pulls/42/reviews/77 --method DELETE': {
        stdout: '{"id":77,"state":"PENDING"}\n',
      },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: { stdout: '98765\n' },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-pending-review-77-restore.json',
      )} --jq [.id, .node_id] | @tsv`]: {
        stdout: '88\tPRR_restored_review\n',
      },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.review_id).toBe('98765');
    expect(outputs.pending_review_restoration_status).toBe('restored');
    expect(outputs.pending_review_escrow_file).toBeTruthy();
    expect(
      fs.statSync(path.dirname(outputs.pending_review_escrow_file)).mode &
        0o777,
    ).toBe(0o700);
    expect(fs.statSync(outputs.pending_review_escrow_file).mode & 0o777).toBe(
      0o600,
    );

    const escrow = readJsonFile(outputs.pending_review_escrow_file);
    expect(escrow).toMatchObject({
      version: 1,
      durable: true,
      entries: [
        {
          originalReviewId: 77,
          classification: 'pre_existing_human',
          status: 'restored',
          restoredReviewId: '88',
          review: { body: 'Human draft review', commit_id: 'draft-sha' },
          comments: [{ id: 701, body: 'Human draft comment' }],
        },
      ],
    });

    const restorePayload = readJsonFile(
      path.join(tempDir, '0', 'github-pending-review-77-restore.json'),
    );
    expect(
      fs.statSync(
        path.join(tempDir, '0', 'github-pending-review-77-restore.json'),
      ).mode & 0o777,
    ).toBe(0o600);
    expect(restorePayload).toEqual({
      body: 'Human draft review',
      commit_id: 'draft-sha',
      comments: [
        {
          path: 'src/human.ts',
          body: 'Human draft comment',
          line: 9,
          side: 'RIGHT',
        },
      ],
    });
  });

  it('restores a deleted human review when its escrow transition cannot be persisted', async () => {
    let writesUnavailable = false;
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({ body: 'Automated review body', comments: [] }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":77,"state":"PENDING","body":"Human draft review","commit_id":"draft-sha","user":{"login":"reviewer"}}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/77/comments?per_page=100 --paginate --slurp':
        { stdout: '[[]]\n' },
      'gh api repos/example/repo/pulls/42/reviews/77 --method DELETE': {
        stdout: '{"id":77}\n',
        onCall: () => {
          writesUnavailable = true;
        },
      },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-pending-review-77-restore.json',
      )} --jq [.id, .node_id] | @tsv`]: {
        stdout: '88\tPRR_restored_review\n',
      },
    });

    await expect(
      runGithubPostReviewCommentAction(
        {
          CANOPY_OUTPUT: outputFile,
          INPUT_PR_IDENTIFIER: 'example/repo#42',
          INPUT_REVIEW_JSON_FILE: reviewFile,
        },
        {
          writeUtf8File: (filePath, content) => {
            if (writesUnavailable) {
              throw new Error('disk full');
            }
            fs.writeFileSync(filePath, content, 'utf8');
          },
          renameFile: (oldPath, newPath) => {
            if (writesUnavailable) {
              throw new Error('disk full');
            }
            fs.renameSync(oldPath, newPath);
          },
        },
      ),
    ).rejects.toThrow('Pending review 77 was restored from durable escrow');

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('failed');
    expect(outputs.failure_mode).toBe('pending_review_cleanup_failed');
    expect(outputs.pending_review_restoration_status).toBe('restored');
    expect(outputs.error_message).toContain('disk full');
    expect(
      mockedExecFile.mock.calls.some(([, args]) =>
        args.some((arg) =>
          arg.endsWith('github-pending-review-77-restore.json'),
        ),
      ),
    ).toBe(true);
    expect(readJsonFile(outputs.pending_review_escrow_file)).toMatchObject({
      entries: [
        {
          originalReviewId: 77,
          status: 'captured',
        },
      ],
    });
  });

  it('restores file-level draft comments into the pending review', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({ body: 'Automated review body', comments: [] }),
      'utf8',
    );
    const restorePayloadFile = path.join(
      tempDir,
      '0',
      'github-pending-review-77-restore.json',
    );
    const restoreFileThreadMutation =
      'mutation($pullRequestReviewId: ID!, $path: String!, $body: String!) { addPullRequestReviewThread(input: {pullRequestReviewId: $pullRequestReviewId, path: $path, body: $body, subjectType: FILE}) { thread { id } } }';

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":77,"state":"PENDING","body":"Human draft review","commit_id":"draft-sha","user":{"login":"reviewer"}}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/77/comments?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":701,"path":"src/human.ts","body":"File draft","subject_type":"file","commit_id":"draft-sha"}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/77 --method DELETE': {
        stdout: '{"id":77}\n',
      },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: { stdout: '98765\n' },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${restorePayloadFile} --jq [.id, .node_id] | @tsv`]:
        { stdout: '88\tPRR_restored_review\n' },
      [`gh api graphql -f query=${restoreFileThreadMutation} -f pullRequestReviewId=PRR_restored_review -f path=src/human.ts -f body=File draft`]:
        {
          stdout:
            '{"data":{"addPullRequestReviewThread":{"thread":{"id":"PRRT_restored_thread"}}}}\n',
        },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    expect(readJsonFile(restorePayloadFile)).toEqual({
      body: 'Human draft review',
      commit_id: 'draft-sha',
      comments: [],
    });
    expect(readOutputs(outputFile).pending_review_restoration_status).toBe(
      'restored',
    );
  });

  it('fails clearly while retaining durable escrow when a human pending review cannot be restored', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({ body: 'Automated review body', comments: [] }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        {
          stdout: JSON.stringify([
            [
              {
                id: 77,
                state: 'PENDING',
                body: 'Human draft review',
                commit_id: 'draft-sha',
                user: { login: 'reviewer' },
              },
            ],
          ]),
        },
      'gh api repos/example/repo/pulls/42/reviews/77/comments?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":701,"path":"src/human.ts","body":"Draft","line":9,"side":"RIGHT","commit_id":"draft-sha"}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/77 --method DELETE': {
        stdout: '{"id":77}\n',
      },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: { stdout: '98765\n' },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-pending-review-77-restore.json',
      )} --jq [.id, .node_id] | @tsv`]: {
        error: 'gh: Validation Failed (HTTP 422)',
        stderr: 'gh: Validation Failed (HTTP 422)\n',
      },
    });

    await expect(
      runGithubPostReviewCommentAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PR_IDENTIFIER: 'example/repo#42',
        INPUT_REVIEW_JSON_FILE: reviewFile,
      }),
    ).rejects.toThrow(
      'Automated GitHub review 98765 was posted, but pending review 77 could not be restored',
    );

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('failed');
    expect(outputs.review_id).toBe('98765');
    expect(outputs.failure_mode).toBe('pending_review_restore_failed');
    expect(outputs.pending_review_restoration_status).toBe('restore_failed');
    expect(outputs.error_message).toContain('durable escrow remains at');
    expect(fs.existsSync(outputs.pending_review_escrow_file)).toBe(true);
    const escrowText = fs.readFileSync(
      outputs.pending_review_escrow_file,
      'utf8',
    );
    expect(escrowText).toContain('HTTP 422');
    const parsedEscrow: unknown = JSON.parse(escrowText);
    expect(parsedEscrow).toMatchObject({
      durable: true,
      entries: [
        {
          originalReviewId: 77,
          status: 'restore_failed',
        },
      ],
    });
  });

  it('restores the human pending review when automated review posting fails', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({ body: 'Automated review body', comments: [] }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":77,"state":"PENDING","body":"Human draft review","commit_id":"draft-sha","user":{"login":"reviewer"}}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/77/comments?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":701,"path":"src/human.ts","body":"Draft","line":9,"side":"RIGHT","commit_id":"draft-sha"}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/77 --method DELETE': {
        stdout: '{"id":77}\n',
      },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Forbidden (HTTP 403)',
        stderr: 'gh: Forbidden (HTTP 403)\n',
      },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-pending-review-77-restore.json',
      )} --jq [.id, .node_id] | @tsv`]: {
        stdout: '88\tPRR_restored_review\n',
      },
    });

    await expect(
      runGithubPostReviewCommentAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PR_IDENTIFIER: 'example/repo#42',
        INPUT_REVIEW_JSON_FILE: reviewFile,
      }),
    ).rejects.toThrow('Pending review 77 was restored from durable escrow');

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('failed');
    expect(outputs.failure_mode).toBe('review_post_failed_pending_restored');
    expect(outputs.pending_review_restoration_status).toBe('restored');
    expect(outputs.error_message).toContain('gh: Forbidden (HTTP 403)');
    expect(readJsonFile(outputs.pending_review_escrow_file)).toMatchObject({
      entries: [
        {
          originalReviewId: 77,
          status: 'restored',
          restoredReviewId: '88',
        },
      ],
    });
  });

  it('escrows and removes a new partial pending review left by a 422 before retrying', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\nAutomated review body',
        comments: [{ path: 'src/app.ts', line: 12, body: 'Check this line.' }],
      }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        [
          { stdout: '[[]]\n' },
          {
            stdout: JSON.stringify([
              [
                {
                  id: 79,
                  state: 'PENDING',
                  body: '',
                  commit_id: 'head-sha',
                  user: { login: 'reviewer' },
                },
              ],
            ]),
          },
        ],
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Validation Failed (HTTP 422)',
        stderr: 'gh: Validation Failed (HTTP 422)\n',
      },
      'gh api repos/example/repo/pulls/42/reviews/79/comments?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":791,"path":"src/app.ts","body":"Check this line.","line":12,"side":"RIGHT","commit_id":"head-sha"}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/79 --method DELETE': {
        stdout: '{"id":79}\n',
      },
      'gh api repos/example/repo/pulls/42 -H Accept: application/vnd.github.v3.diff':
        {
          stdout: [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -10,2 +10,3 @@',
            ' context',
            '+added',
            ' context',
          ].join('\n'),
        },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload-valid-inline-comments.json',
      )} --jq .id`]: { stdout: '98767\n' },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.review_id).toBe('98767');
    expect(outputs.error_message).toContain(
      'removed partial pending review 79 after GitHub returned HTTP 422',
    );
    expect(readJsonFile(outputs.pending_review_escrow_file)).toMatchObject({
      durable: true,
      entries: [
        {
          originalReviewId: 79,
          classification: 'new_automated_partial',
          status: 'deleted_not_restored',
        },
      ],
    });
  });

  it('restores a concurrent human draft whose comments overlap the rejected attempt', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\nAutomated review body',
        commit_id: 'head-sha',
        comments: [
          { path: 'src/app.ts', line: 12, body: 'Shared comment.' },
          { path: 'src/other.ts', line: 20, body: 'Other comment.' },
        ],
      }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        [
          { stdout: '[[]]\n' },
          {
            stdout:
              '[[{"id":79,"state":"PENDING","body":"","commit_id":"human-sha","user":{"login":"reviewer"}}]]',
          },
        ],
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Validation Failed (HTTP 422)',
        stderr: 'gh: Validation Failed (HTTP 422)\n',
      },
      'gh api repos/example/repo/pulls/42/reviews/79/comments?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":791,"path":"src/app.ts","body":"Shared comment.","line":99,"side":"LEFT","commit_id":"human-sha"},{"id":792,"path":"src/other.ts","body":"Other comment.","line":88,"side":"LEFT","commit_id":"human-sha"}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/79 --method DELETE': {
        stdout: '{"id":79}\n',
      },
      'gh api repos/example/repo/pulls/42 -H Accept: application/vnd.github.v3.diff':
        { stdout: '' },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload-no-inline-comments.json',
      )} --jq .id`]: { stdout: '98768\n' },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-pending-review-79-restore.json',
      )} --jq [.id, .node_id] | @tsv`]: {
        stdout: '89\tPRR_restored_human_review\n',
      },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.pending_review_restoration_status).toBe('restored');
    expect(readJsonFile(outputs.pending_review_escrow_file)).toMatchObject({
      entries: [
        {
          originalReviewId: 79,
          classification: 'pre_existing_human',
          status: 'restored',
          restoredReviewId: '89',
        },
      ],
    });
  });

  it('restores a matching human draft when it targets a different commit', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\nAutomated review body',
        comments: [{ path: 'src/app.ts', line: 12, body: 'Shared comment.' }],
      }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        [
          { stdout: '[[]]\n' },
          {
            stdout:
              '[[{"id":79,"state":"PENDING","body":"","commit_id":"human-sha","user":{"login":"reviewer"}}]]',
          },
        ],
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Validation Failed (HTTP 422)',
        stderr: 'gh: Validation Failed (HTTP 422)\n',
      },
      'gh api repos/example/repo/pulls/42/reviews/79/comments?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":791,"path":"src/app.ts","body":"Shared comment.","line":12,"side":"RIGHT","commit_id":"human-sha"}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/79 --method DELETE': {
        stdout: '{"id":79}\n',
      },
      'gh api repos/example/repo/pulls/42 -H Accept: application/vnd.github.v3.diff':
        { stdout: '' },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload-no-inline-comments.json',
      )} --jq .id`]: { stdout: '98769\n' },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-pending-review-79-restore.json',
      )} --jq [.id, .node_id] | @tsv`]: {
        stdout: '89\tPRR_restored_human_review\n',
      },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.pending_review_restoration_status).toBe('restored');
    expect(readJsonFile(outputs.pending_review_escrow_file)).toMatchObject({
      entries: [
        {
          originalReviewId: 79,
          classification: 'pre_existing_human',
          status: 'restored',
        },
      ],
    });
  });

  it('classifies an initial pending-review inspection outage before posting', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({ body: 'Automated review body', comments: [] }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        {
          error: 'gh: Service Unavailable (HTTP 503)',
          stderr: 'gh: Service Unavailable (HTTP 503)\n',
        },
    });

    await expect(
      runGithubPostReviewCommentAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PR_IDENTIFIER: 'example/repo#42',
        INPUT_REVIEW_JSON_FILE: reviewFile,
      }),
    ).rejects.toThrow('No review was posted or deleted');

    const outputs = readOutputs(outputFile);
    expect(outputs.failure_mode).toBe('pending_review_inspection_failed');
    expect(outputs.review_id).toBe('');
    expect(
      mockedExecFile.mock.calls.some(([, args]) => args.includes('POST')),
    ).toBe(false);
    expect(
      mockedExecFile.mock.calls.some(([, args]) => args.includes('DELETE')),
    ).toBe(false);
  });

  it('classifies a stale automated pending review found after a 422 separately', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\nNew automated review',
        comments: [{ path: 'src/app.ts', line: 12, body: 'New comment.' }],
      }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        [
          { stdout: '[[]]\n' },
          {
            stdout:
              '[[{"id":79,"state":"PENDING","body":"[//]: # (ud-ai-review)\\nStale automated review","commit_id":"head-sha","user":{"login":"reviewer"}}]]',
          },
        ],
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Validation Failed (HTTP 422)',
        stderr: 'gh: Validation Failed (HTTP 422)\n',
      },
      'gh api repos/example/repo/pulls/42/reviews/79/comments?per_page=100 --paginate --slurp':
        { stdout: '[[]]\n' },
      'gh api repos/example/repo/pulls/42/reviews/79 --method DELETE': {
        stdout: '{"id":79}\n',
      },
      'gh api repos/example/repo/pulls/42 -H Accept: application/vnd.github.v3.diff':
        { stdout: '' },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload-no-inline-comments.json',
      )} --jq .id`]: { stdout: '98767\n' },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.error_message).toContain(
      'removed stale automated pending review 79',
    );
    expect(readJsonFile(outputs.pending_review_escrow_file)).toMatchObject({
      entries: [
        {
          originalReviewId: 79,
          classification: 'pre_existing_automated',
          status: 'deleted_not_restored',
        },
      ],
    });
  });

  it('fails clearly with durable escrow when a new partial pending review cannot be removed', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\nAutomated review body',
        comments: [{ path: 'src/app.ts', line: 12, body: 'Check this line.' }],
      }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        [
          { stdout: '[[]]\n' },
          {
            stdout:
              '[[{"id":79,"state":"PENDING","body":"[//]: # (ud-ai-review)\\nAutomated review body","commit_id":"head-sha","user":{"login":"reviewer"}}]]',
          },
        ],
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Validation Failed (HTTP 422)',
        stderr: 'gh: Validation Failed (HTTP 422)\n',
      },
      'gh api repos/example/repo/pulls/42/reviews/79/comments?per_page=100 --paginate --slurp':
        {
          stdout:
            '[[{"id":791,"path":"src/app.ts","body":"Check this line.","line":12,"side":"RIGHT","commit_id":"head-sha"}]]',
        },
      'gh api repos/example/repo/pulls/42/reviews/79 --method DELETE': {
        error: 'gh: Server Error (HTTP 500)',
        stderr: 'gh: Server Error (HTTP 500)\n',
      },
    });

    await expect(
      runGithubPostReviewCommentAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PR_IDENTIFIER: 'example/repo#42',
        INPUT_REVIEW_JSON_FILE: reviewFile,
      }),
    ).rejects.toThrow(
      'GitHub left partial pending review 79 after rejecting the automated review, and it could not be deleted',
    );

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('failed');
    expect(outputs.failure_mode).toBe('pending_review_cleanup_failed');
    expect(outputs.error_message).toContain('durable escrow remains at');
    expect(fs.existsSync(outputs.pending_review_escrow_file)).toBe(true);
    const escrowText = fs.readFileSync(
      outputs.pending_review_escrow_file,
      'utf8',
    );
    expect(escrowText).toContain('HTTP 500');
    const parsedEscrow: unknown = JSON.parse(escrowText);
    expect(parsedEscrow).toMatchObject({
      entries: [
        {
          originalReviewId: 79,
          status: 'delete_failed',
        },
      ],
    });
  });

  it('reports when pending reviews cannot be inspected after a 422', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: 'Automated review body',
        comments: [{ path: 'src/app.ts', line: 12, body: 'Check this line.' }],
      }),
      'utf8',
    );

    installExecFileMock({
      'gh api repos/example/repo/pulls/42/reviews?per_page=100 --paginate --slurp':
        [
          { stdout: '[[]]\n' },
          {
            error: 'gh: Service Unavailable (HTTP 503)',
            stderr: 'gh: Service Unavailable (HTTP 503)\n',
          },
        ],
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Validation Failed (HTTP 422)',
        stderr: 'gh: Validation Failed (HTTP 422)\n',
      },
    });

    await expect(
      runGithubPostReviewCommentAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_PR_IDENTIFIER: 'example/repo#42',
        INPUT_REVIEW_JSON_FILE: reviewFile,
      }),
    ).rejects.toThrow('pending reviews could not be inspected safely');

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('failed');
    expect(outputs.failure_mode).toBe('pending_review_inspection_failed');
    expect(outputs.error_message).toContain('No pending review was deleted');
    expect(outputs.error_message).toContain('HTTP 503');
  });

  it('posts a GitHub review with inline comments and threaded replies', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: 'Automated review body',
        comments: [
          {
            path: 'src/app.ts',
            line: 12,
            start_line: 14,
            body: 'Please check this branch.',
          },
        ],
        replies: [
          {
            comment_id: 12345,
            thread_id: 'PRRT_example',
            body: 'This has been rechecked.',
            resolve: true,
          },
        ],
      }),
      'utf8',
    );

    installExecFileMock({
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: { stdout: '98765\n' },
      'gh api repos/example/repo/pulls/42/comments/12345/replies --method POST -f body=This has been rechecked.':
        { stdout: '{"id":222}\n' },
      'gh api graphql -f query=mutation($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } } -f threadId=PRRT_example':
        {
          stdout:
            '{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_example","isResolved":true}}}}\n',
        },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'https://github.com/example/repo/pull/42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.review_id).toBe('98765');
    expect(outputs.review_comment_id).toBe('98765');
    expect(outputs.review_url).toBe(
      'https://github.com/example/repo/pull/42#pullrequestreview-98765',
    );
    expect(outputs.inline_comment_count).toBe('1');
    expect(outputs.file_level_comment_count).toBe('0');
    expect(outputs.thread_reply_count).toBe('1');
    expect(outputs.thread_resolve_count).toBe('1');

    const payload = readJsonFile(outputs.payload_file);
    expect(payload).toMatchObject({
      body: 'Automated review body',
      event: 'COMMENT',
      comments: [
        {
          path: 'src/app.ts',
          line: 14,
          start_line: 12,
          body: 'Please check this branch.',
        },
      ],
    });
  });

  it('falls back to a body-only GitHub review when inline comments are rejected', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\n## AI Code Review\n\n<!-- AI_REVIEW_DATA: {"attempt":1,"score":5} -->\n',
        comments: [
          {
            path: 'src/app.ts',
            line: 120,
            start_line: 1,
            body: '**[Important]**: Invalid broad range',
          },
        ],
      }),
      'utf8',
    );

    installExecFileMock({
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Unprocessable Entity (HTTP 422)',
        stderr: 'gh: Unprocessable Entity (HTTP 422)\n',
      },
      'gh api repos/example/repo/pulls/42 -H Accept: application/vnd.github.v3.diff':
        {
          stdout: [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -10,3 +10,3 @@',
            ' unchanged',
            '+added',
            ' unchanged',
          ].join('\n'),
        },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload-valid-inline-comments.json',
      )} --jq .id`]: {
        error: 'gh: Unprocessable Entity (HTTP 422)',
        stderr: 'gh: Unprocessable Entity (HTTP 422)\n',
      },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload-no-inline-comments.json',
      )} --jq .id`]: { stdout: '98766\n' },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.review_id).toBe('98766');
    expect(outputs.inline_comment_count).toBe('0');
    expect(outputs.omitted_inline_comment_count).toBe('1');
    expect(outputs.error_message).toContain(
      'GitHub rejected inline review comment coordinates',
    );

    const fallbackPayload = readJsonFile(outputs.fallback_payload_file);
    expect(fallbackPayload).toMatchObject({
      event: 'COMMENT',
      comments: [],
    });
    expect(fallbackPayload.body).toContain(
      '<summary>Inline comments omitted from GitHub review (1)</summary>',
    );
    expect(fallbackPayload.body).toContain(
      'GitHub rejected these inline comment coordinates.',
    );
    expect(fallbackPayload.body).toContain('"path": "src/app.ts"');
    expect(fallbackPayload.body).toMatch(
      /<\/details>\n<!-- AI_REVIEW_DATA: \{"attempt":1,"score":5\} -->\n?$/,
    );
  });

  it('retries valid inline comments and posts invalid ranges as file-level comments', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\n## AI Code Review\n',
        commit_id: 'abc123',
        comments: [
          {
            path: 'src/app.ts',
            line: 12,
            start_line: 10,
            body: '**[Important]**: Valid hunk range',
          },
          {
            path: 'src/app.ts',
            line: 120,
            start_line: 1,
            body: '**[Important]**: Invalid broad range',
          },
        ],
      }),
      'utf8',
    );

    installExecFileMock({
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Unprocessable Entity (HTTP 422)',
        stderr: 'gh: Unprocessable Entity (HTTP 422)\n',
      },
      'gh api repos/example/repo/pulls/42 -H Accept: application/vnd.github.v3.diff':
        {
          stdout: [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -10,3 +10,3 @@',
            ' unchanged',
            '+added',
            ' unchanged',
          ].join('\n'),
        },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload-valid-inline-comments.json',
      )} --jq .id`]: { stdout: '98767\n' },
      [`gh api repos/example/repo/pulls/42/comments --method POST --input ${path.join(
        tempDir,
        '0',
        'github-file-level-comment-1.json',
      )} --jq .id`]: { stdout: '43210\n' },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.review_id).toBe('98767');
    expect(outputs.inline_comment_count).toBe('1');
    expect(outputs.file_level_comment_count).toBe('1');
    expect(outputs.file_level_failed_count).toBe('0');
    expect(outputs.omitted_inline_comment_count).toBe('0');
    expect(outputs.error_message).toContain(
      'retried with 1 valid inline comment(s) and posted 1 invalid comment(s) as file-level comments',
    );

    const adjustedPayload = readJsonFile(outputs.adjusted_payload_file);
    expect(adjustedPayload).toMatchObject({
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/app.ts',
          line: 12,
          start_line: 10,
          body: '**[Important]**: Valid hunk range',
        },
      ],
    });

    const fileLevelComments = readJsonFile(outputs.file_level_comments_file);
    expect(fileLevelComments).toMatchObject([
      {
        path: 'src/app.ts',
        subject_type: 'file',
        body: '**[Important]**: Invalid broad range (Lines: 1 to 120)',
      },
    ]);

    const fileLevelPayload = readJsonFile(
      path.join(tempDir, '0', 'github-file-level-comment-1.json'),
    );
    expect(fileLevelPayload).toMatchObject({
      path: 'src/app.ts',
      subject_type: 'file',
      commit_id: 'abc123',
      body: '**[Important]**: Invalid broad range (Lines: 1 to 120)',
    });
  });

  it('prefilters inline comments with a local diff file before posting', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    const diffFile = path.join(tempDir, 'review.diff');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\n## AI Code Review\n',
        commit_id: 'abc123',
        comments: [
          {
            path: 'src/app.ts',
            line: 12,
            start_line: 10,
            body: '**[Important]**: Valid hunk range',
          },
          {
            path: 'src/app.ts',
            line: 120,
            start_line: 1,
            body: '**[Important]**: Invalid broad range',
          },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(
      diffFile,
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -10,3 +10,3 @@',
        ' unchanged',
        '+added',
        ' unchanged',
      ].join('\n'),
      'utf8',
    );

    installExecFileMock({
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: { stdout: '98768\n' },
      [`gh api repos/example/repo/pulls/42/comments --method POST --input ${path.join(
        tempDir,
        '0',
        'github-file-level-comment-1.json',
      )} --jq .id`]: { stdout: '43211\n' },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
      INPUT_DIFF_FILE: diffFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.review_id).toBe('98768');
    expect(outputs.inline_comment_count).toBe('1');
    expect(outputs.file_level_comment_count).toBe('1');
    expect(outputs.omitted_inline_comment_count).toBe('0');
    expect(outputs.error_message).toContain(
      'Filtered 1 inline comment(s) against the local diff before posting',
    );

    const payload = readJsonFile(outputs.payload_file);
    expect(payload).toMatchObject({
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/app.ts',
          line: 12,
          start_line: 10,
          body: '**[Important]**: Valid hunk range',
        },
      ],
    });
    const fileLevelComments = readJsonFile(outputs.file_level_comments_file);
    expect(fileLevelComments).toMatchObject([
      {
        path: 'src/app.ts',
        subject_type: 'file',
        body: '**[Important]**: Invalid broad range (Lines: 1 to 120)',
      },
    ]);
  });

  it('falls back to GitHub diff retry when the local diff file is unreadable', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    const missingDiffFile = path.join(tempDir, 'missing-review.diff');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\n## AI Code Review\n',
        commit_id: 'abc123',
        comments: [
          {
            path: 'src/app.ts',
            line: 12,
            start_line: 10,
            body: '**[Important]**: Valid hunk range',
          },
          {
            path: 'src/app.ts',
            line: 120,
            start_line: 1,
            body: '**[Important]**: Invalid broad range',
          },
        ],
      }),
      'utf8',
    );

    installExecFileMock({
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Unprocessable Entity (HTTP 422)',
        stderr: 'gh: Unprocessable Entity (HTTP 422)\n',
      },
      'gh api repos/example/repo/pulls/42 -H Accept: application/vnd.github.v3.diff':
        {
          stdout: [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -10,3 +10,3 @@',
            ' unchanged',
            '+added',
            ' unchanged',
          ].join('\n'),
        },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload-valid-inline-comments.json',
      )} --jq .id`]: { stdout: '98769\n' },
      [`gh api repos/example/repo/pulls/42/comments --method POST --input ${path.join(
        tempDir,
        '0',
        'github-file-level-comment-1.json',
      )} --jq .id`]: { stdout: '43212\n' },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
      INPUT_DIFF_FILE: missingDiffFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.review_id).toBe('98769');
    expect(outputs.inline_comment_count).toBe('1');
    expect(outputs.file_level_comment_count).toBe('1');
    expect(outputs.error_message).toContain(
      'retried with 1 valid inline comment(s) and posted 1 invalid comment(s) as file-level comments',
    );
  });

  it('skips local prefiltering when the parsed diff has no line entries', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    const diffFile = path.join(tempDir, 'empty-review.diff');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\n## AI Code Review\n',
        commit_id: 'abc123',
        comments: [
          {
            path: 'src/app.ts',
            line: 12,
            start_line: 10,
            body: '**[Important]**: Valid hunk range',
          },
          {
            path: 'src/app.ts',
            line: 120,
            start_line: 1,
            body: '**[Important]**: Preserved inline range',
          },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(diffFile, '', 'utf8');

    installExecFileMock({
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: { stdout: '98770\n' },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
      INPUT_DIFF_FILE: diffFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.review_id).toBe('98770');
    expect(outputs.inline_comment_count).toBe('2');
    expect(outputs.file_level_comment_count).toBe('0');
    expect(outputs.adjusted_payload_file).toBeUndefined();
    expect(outputs.error_message).toBe('');

    const payload = readJsonFile(outputs.payload_file);
    expect(payload).toMatchObject({
      commit_id: 'abc123',
      comments: [
        {
          path: 'src/app.ts',
          line: 12,
          start_line: 10,
          body: '**[Important]**: Valid hunk range',
        },
        {
          path: 'src/app.ts',
          line: 120,
          start_line: 1,
          body: '**[Important]**: Preserved inline range',
        },
      ],
    });
  });

  it('writes multiline file-level posting errors as single-line outputs', async () => {
    const reviewFile = path.join(tempDir, 'review.json');
    fs.writeFileSync(
      reviewFile,
      JSON.stringify({
        body: '[//]: # (ud-ai-review)\n## AI Code Review\n',
        comments: [
          {
            path: 'src/app.ts',
            line: 120,
            start_line: 1,
            body: '**[Important]**: Invalid broad range',
          },
        ],
      }),
      'utf8',
    );

    installExecFileMock({
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload.json',
      )} --jq .id`]: {
        error: 'gh: Unprocessable Entity (HTTP 422)',
        stderr: 'gh: Unprocessable Entity (HTTP 422)\n',
      },
      'gh api repos/example/repo/pulls/42 -H Accept: application/vnd.github.v3.diff':
        {
          stdout: [
            'diff --git a/src/app.ts b/src/app.ts',
            '--- a/src/app.ts',
            '+++ b/src/app.ts',
            '@@ -10,3 +10,3 @@',
            ' unchanged',
            '+added',
            ' unchanged',
          ].join('\n'),
        },
      [`gh api repos/example/repo/pulls/42/reviews --method POST --input ${path.join(
        tempDir,
        '0',
        'github-review-payload-valid-inline-comments.json',
      )} --jq .id`]: { stdout: '98767\n' },
      [`gh api repos/example/repo/pulls/42/comments --method POST --input ${path.join(
        tempDir,
        '0',
        'github-file-level-comment-1.json',
      )} --jq .id`]: {
        error: 'failed to post comment',
        stderr: 'first error line\nsecond error line\n',
      },
    });

    await runGithubPostReviewCommentAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_PR_IDENTIFIER: 'example/repo#42',
      INPUT_REVIEW_JSON_FILE: reviewFile,
    });

    const outputs = readOutputs(outputFile);
    expect(outputs.status).toBe('posted');
    expect(outputs.file_level_failed_count).toBe('1');
    expect(outputs.error_message).toContain(
      'first error line second error line',
    );
    expect(outputs.error_message).not.toContain('\n');

    const result = readJsonFile(outputs.result_json_file);
    if (!isRecord(result) || typeof result.errorMessage !== 'string') {
      throw new Error('Invalid post review result test fixture output');
    }
    expect(result.errorMessage).toContain(
      'first error line\nsecond error line',
    );
  });
});
