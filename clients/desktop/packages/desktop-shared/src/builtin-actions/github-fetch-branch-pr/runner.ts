import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getGitExecutableCommand } from '../../lib/git-executable';
import { setOutput, writeOutputFile } from '../_lib/output';
import { runWithActionEnvironment } from '../_lib/action-env';

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 1024 * 1024 * 16;

interface PullRequestDetails {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  updatedAt: string;
}

interface PullRequestLookupResult {
  generatedAt: string;
  status: 'found' | 'not_found' | 'error';
  hasPr: boolean;
  currentBranch: string;
  errorMessage: string;
  pr: PullRequestDetails | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(
  record: Record<string, unknown>,
  fieldName: string,
  defaultValue = '',
): string {
  const value = record[fieldName];
  return typeof value === 'string' ? value : defaultValue;
}

function readBooleanField(
  record: Record<string, unknown>,
  fieldName: string,
): boolean {
  const value = record[fieldName];
  return typeof value === 'boolean' ? value : false;
}

function readNumberField(
  record: Record<string, unknown>,
  fieldName: string,
): number {
  const value = record[fieldName];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function parsePullRequestDetails(raw: string): PullRequestDetails {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'github-fetch-branch-pr received invalid JSON from gh pr view',
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      'github-fetch-branch-pr received a non-object response from gh pr view',
    );
  }

  return {
    number: readNumberField(parsed, 'number'),
    title: readStringField(parsed, 'title'),
    body: readStringField(parsed, 'body'),
    url: readStringField(parsed, 'url'),
    state: readStringField(parsed, 'state'),
    isDraft: readBooleanField(parsed, 'isDraft'),
    baseRefName: readStringField(parsed, 'baseRefName'),
    headRefName: readStringField(parsed, 'headRefName'),
    headRefOid: readStringField(parsed, 'headRefOid'),
    additions: readNumberField(parsed, 'additions'),
    deletions: readNumberField(parsed, 'deletions'),
    changedFiles: readNumberField(parsed, 'changedFiles'),
    reviewDecision: readStringField(parsed, 'reviewDecision'),
    updatedAt: readStringField(parsed, 'updatedAt'),
  };
}

function normalizeTitle(rawTitle: string): string {
  return rawTitle.replace(/\s+/g, ' ').trim();
}

function readErrorProperty(error: unknown, fieldName: string): string {
  if (!isRecord(error)) {
    return '';
  }

  for (const [key, value] of Object.entries(error)) {
    if (key === fieldName && typeof value === 'string') {
      return value;
    }
  }

  return '';
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const result = await execFileAsync(command, args, {
    cwd,
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: process.platform === 'win32',
  });
  return result.stdout.trim();
}

function renderSummary(details: PullRequestLookupResult): string {
  if (details.status === 'found' && details.pr) {
    return [
      '# Pull Request Context',
      '',
      `- Current branch: ${details.currentBranch}`,
      `- PR: #${String(details.pr.number)} ${details.pr.title}`,
      `- URL: ${details.pr.url}`,
      `- State: ${details.pr.state}`,
      `- Draft: ${String(details.pr.isDraft)}`,
      `- Base branch: ${details.pr.baseRefName}`,
      `- Head branch: ${details.pr.headRefName}`,
      `- Head SHA: ${details.pr.headRefOid || '(unknown)'}`,
      `- Changed files: ${String(details.pr.changedFiles)}`,
      `- Additions: ${String(details.pr.additions)}`,
      `- Deletions: ${String(details.pr.deletions)}`,
      `- Review decision: ${details.pr.reviewDecision || '(none)'}`,
      `- Updated at: ${details.pr.updatedAt || '(unknown)'}`,
      '',
      '## Body',
      details.pr.body.trim().length > 0 ? details.pr.body : '(empty)',
      '',
    ].join('\n');
  }

  const header =
    details.status === 'not_found'
      ? '# Pull Request Context\n\nNo open pull request is associated with the current branch.\n'
      : '# Pull Request Context\n\nUnable to load pull request details.\n';

  const extraLines = [
    '',
    `- Current branch: ${details.currentBranch}`,
    `- Status: ${details.status}`,
    ...(details.errorMessage ? [`- Error: ${details.errorMessage}`] : []),
    '',
  ];

  return `${header}${extraLines.join('\n')}`;
}

export async function runGithubFetchBranchPrAction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await runWithActionEnvironment(env, async () => {
    const cwd = process.cwd();
    const currentBranch =
      env.INPUT_BRANCH?.trim() ||
      (await runCommand(
        getGitExecutableCommand(process.env),
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        cwd,
      ));

    let result: PullRequestLookupResult;

    try {
      const raw = await runCommand(
        'gh',
        [
          'pr',
          'view',
          currentBranch,
          '--json',
          'number,title,body,url,state,isDraft,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,reviewDecision,updatedAt',
        ],
        cwd,
      );
      const prDetails = parsePullRequestDetails(raw);
      result = {
        generatedAt: new Date().toISOString(),
        status: 'found',
        hasPr: true,
        currentBranch,
        errorMessage: '',
        pr: prDetails,
      };
    } catch (error) {
      const stderr = readErrorProperty(error, 'stderr');
      const errorMessage =
        stderr.trim().length > 0
          ? stderr.trim()
          : error instanceof Error
            ? error.message
            : String(error);

      const status = /no pull requests? found/i.test(errorMessage)
        ? 'not_found'
        : 'error';

      result = {
        generatedAt: new Date().toISOString(),
        status,
        hasPr: false,
        currentBranch,
        errorMessage,
        pr: null,
      };
    }

    const detailsJsonFile = writeOutputFile(
      'details_json_file',
      'github-fetch-branch-pr.json',
      `${JSON.stringify(result, null, 2)}\n`,
    );
    const summaryFile = writeOutputFile(
      'summary_file',
      'github-fetch-branch-pr.md',
      renderSummary(result),
    );

    void detailsJsonFile;
    void summaryFile;

    setOutput('status', result.status);
    setOutput('has_pr', String(result.hasPr));
    setOutput('current_branch', currentBranch);
    setOutput('pr_number', result.pr ? String(result.pr.number) : '');
    setOutput('pr_url', result.pr?.url ?? '');
    setOutput('title', result.pr ? normalizeTitle(result.pr.title) : '');
    setOutput('base_branch', result.pr?.baseRefName ?? '');
    setOutput('head_branch', result.pr?.headRefName ?? '');
    setOutput('commit_sha', result.pr?.headRefOid ?? '');
    setOutput('error_message', result.errorMessage.replace(/\s+/g, ' ').trim());
  });
}
