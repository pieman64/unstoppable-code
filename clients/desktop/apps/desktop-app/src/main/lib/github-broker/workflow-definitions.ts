import type {
  GitHubWorkflowDefinitionGraph,
  GitHubWorkflowDefinitionSource,
} from '@canopy/desktop-shared/types';
import {
  buildGitHubWorkflowDefinitionGraph,
  listGitHubWorkflowCalls,
  MAX_GITHUB_WORKFLOW_CALLED_FILES,
} from '@canopy/desktop-shared/lib/github-workflow-definition-graph';
import { normalizeGitHubRepositoryReference } from '@canopy/desktop-shared/lib/github-workflow-run-references';
import {
  getGitHubBroker,
  GitHubBrokerError,
  type GitHubRawResponse,
} from './index';

/** Workflow files larger than this are not read; the graph stays unavailable. */
export const MAX_WORKFLOW_DEFINITION_BYTES = 256 * 1024;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

interface WorkflowFileText {
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCachedWorkflowFileText(value: unknown): value is WorkflowFileText {
  return isRecord(value) && typeof value.text === 'string';
}

/** Decode GitHub's contents response for one file into its UTF-8 text. */
export function normalizeGitHubWorkflowFile(value: unknown): WorkflowFileText {
  if (
    !isRecord(value) ||
    value.type !== 'file' ||
    typeof value.content !== 'string' ||
    (value.encoding !== undefined && value.encoding !== 'base64') ||
    (typeof value.size === 'number' &&
      value.size > MAX_WORKFLOW_DEFINITION_BYTES)
  ) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow file response was malformed.',
    );
  }
  const buffer = Buffer.from(value.content, 'base64');
  if (buffer.byteLength > MAX_WORKFLOW_DEFINITION_BYTES) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow file is too large to read.',
    );
  }
  return { text: buffer.toString('utf8') };
}

interface WorkflowFileLocator {
  repository: string;
  path: string;
  sha: string;
}

/**
 * Resolve a `uses:` value to a pinned file. Local calls (`./path`) read the
 * same repository at the run's commit; remote calls (`owner/repo/path@ref`)
 * use the commit GitHub recorded in `referenced_workflows`, or the ref itself
 * when it already is a commit. Anything else stays unresolved so the caller
 * collapses into one dynamic node instead of reading a guessed file.
 */
export function resolveGitHubWorkflowCall(
  uses: string,
  repository: string,
  source: GitHubWorkflowDefinitionSource,
): WorkflowFileLocator | null {
  const trimmed = uses.trim();
  if (trimmed.startsWith('./')) {
    const path = trimmed.slice(2);
    if (path.length === 0 || path.includes('..')) return null;
    const pinned = source.referenced.find(
      (entry) => entry.repository === repository && entry.path === path,
    );
    return { repository, path, sha: pinned?.sha ?? source.sha };
  }
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return null;
  const ref = trimmed.slice(at + 1);
  const [owner, name, ...rest] = trimmed.slice(0, at).split('/');
  const remoteRepository = normalizeGitHubRepositoryReference(
    `${owner ?? ''}/${name ?? ''}`,
  );
  const path = rest.join('/');
  if (!remoteRepository || path.length === 0 || path.includes('..')) {
    return null;
  }
  const pinned = source.referenced.find(
    (entry) => entry.repository === remoteRepository && entry.path === path,
  );
  const sha = pinned?.sha ?? (COMMIT_SHA_PATTERN.test(ref) ? ref : undefined);
  return sha ? { repository: remoteRepository, path, sha } : null;
}

async function fetchWorkflowFile(
  locator: WorkflowFileLocator,
  options: {
    priority: 'interactive' | 'watcher';
    signal?: AbortSignal;
    timeoutMs?: number;
    caller?: string;
  },
): Promise<string> {
  const [owner, repository] = locator.repository.split('/');
  if (!owner || !repository) {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow file request was malformed.',
    );
  }
  const result = await getGitHubBroker().execute<WorkflowFileText>(
    async (
      octokit,
      conditionalHeaders,
    ): Promise<GitHubRawResponse<WorkflowFileText>> => {
      const route: string = 'GET /repos/{owner}/{repo}/contents/{path}';
      const response = await octokit.request(route, {
        owner,
        repo: repository,
        path: locator.path,
        ref: locator.sha,
        headers: conditionalHeaders,
      });
      return {
        status: response.status,
        headers: response.headers,
        data: normalizeGitHubWorkflowFile(response.data),
      };
    },
    {
      priority: options.priority,
      ...(options.caller ? { caller: options.caller } : {}),
      operation: 'read',
      idempotency: 'safe',
      // Pinned to a commit, so the cached body never goes stale.
      resourceKey: `workflow-definition:${locator.repository}/${locator.path}@${locator.sha}`,
      conditional: true,
      isCachedData: isCachedWorkflowFileText,
      timeoutMs: options.timeoutMs ?? 20_000,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (result.kind !== 'read') {
    throw new GitHubBrokerError(
      'invalid_response',
      'GitHub workflow file read returned a mutation result.',
    );
  }
  return result.data.text;
}

/**
 * Read the run's workflow file and every reusable workflow it calls, pinned
 * to the commits GitHub recorded, and build the bounded job graph. The root
 * file must be readable; a called file that cannot be read collapses its
 * caller into one dynamic node. Returns null when the definition yields no
 * usable graph, so callers fall back to timestamp-inferred tiers.
 */
export async function fetchGitHubWorkflowDefinitionGraph(options: {
  repository: string;
  source: GitHubWorkflowDefinitionSource;
  priority: 'interactive' | 'watcher';
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Spend-summary label for the broker. */
  caller?: string;
}): Promise<GitHubWorkflowDefinitionGraph | null> {
  const root = await fetchWorkflowFile(
    {
      repository: options.repository,
      path: options.source.path,
      sha: options.source.sha,
    },
    options,
  );
  const called = new Map<string, string>();
  const calls = listGitHubWorkflowCalls(root).slice(
    0,
    MAX_GITHUB_WORKFLOW_CALLED_FILES,
  );
  for (const uses of calls) {
    const locator = resolveGitHubWorkflowCall(
      uses,
      options.repository,
      options.source,
    );
    if (!locator) continue;
    try {
      called.set(uses, await fetchWorkflowFile(locator, options));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // Best-effort: the caller collapses into a dynamic node.
    }
  }
  return buildGitHubWorkflowDefinitionGraph({
    sha: options.source.sha,
    observedAt: new Date().toISOString(),
    root,
    called,
  });
}
