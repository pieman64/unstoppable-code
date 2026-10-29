/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
const execute = jest.fn();
jest.mock('../lib/github-broker', () => ({
  getGitHubBroker: () => ({ execute }),
  GitHubBrokerError: class GitHubBrokerError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

import {
  fetchGitHubWorkflowRun,
  fetchGitHubWorkflowRunJobs,
  normalizeGitHubWorkflowRun,
  normalizeGitHubWorkflowRunState,
  resolveGitHubWorkflowRunJob,
} from '../lib/github-broker/workflow-runs';

describe('GitHub workflow-run normalization', () => {
  it.each(['requested', 'queued', 'pending', 'waiting', 'in_progress'])(
    'normalizes known intermediate status %s',
    (status) => {
      expect(normalizeGitHubWorkflowRunState(status, null)).toEqual({
        kind: 'intermediate',
        status,
      });
    },
  );

  it.each([
    'action_required',
    'cancelled',
    'failure',
    'neutral',
    'skipped',
    'stale',
    'startup_failure',
    'success',
    'timed_out',
  ])('normalizes known terminal conclusion %s', (conclusion) => {
    expect(normalizeGitHubWorkflowRunState('completed', conclusion)).toEqual({
      kind: 'terminal',
      conclusion,
    });
  });

  it('keeps unknown values in the unsupported state', () => {
    expect(normalizeGitHubWorkflowRunState('scheduled', null)).toEqual({
      kind: 'unsupported',
      status: 'scheduled',
      conclusion: null,
      terminal: false,
    });
    expect(normalizeGitHubWorkflowRunState('completed', 'new_result')).toEqual({
      kind: 'unsupported',
      status: 'completed',
      conclusion: 'new_result',
      terminal: true,
    });
    expect(
      normalizeGitHubWorkflowRunState(`future_${'x'.repeat(100)}`, null),
    ).toEqual({
      kind: 'unsupported',
      status: `future_${'x'.repeat(57)}`,
      conclusion: null,
      terminal: false,
    });
  });

  it('rejects malformed run attempts, urls, and run numbers', () => {
    expect(() =>
      normalizeGitHubWorkflowRun({
        status: 'queued',
        conclusion: null,
        run_attempt: 0,
        html_url: 'https://github.com/acme/api/actions/runs/1',
      }),
    ).toThrow('malformed');
    expect(() =>
      normalizeGitHubWorkflowRun({
        status: 'queued',
        conclusion: null,
        run_attempt: 1,
        html_url: '',
      }),
    ).toThrow('malformed');
  });

  it('caps workflow names before returning a persisted snapshot', () => {
    const snapshot = normalizeGitHubWorkflowRun({
      status: 'queued',
      conclusion: null,
      run_attempt: 1,
      html_url: 'https://github.com/acme/api/actions/runs/1',
      name: 'x'.repeat(200),
      run_number: 12,
    });
    expect(snapshot.workflowName).toHaveLength(120);
    expect(snapshot.runNumber).toBe(12);
  });

  it('keeps a well-formed definition source and drops malformed pieces', () => {
    const base = {
      status: 'in_progress',
      conclusion: null,
      run_attempt: 1,
      html_url: 'https://github.com/acme/api/actions/runs/1',
      name: 'CI',
      run_number: 12,
    };
    const sha = 'f'.repeat(40);
    const source = normalizeGitHubWorkflowRun({
      ...base,
      path: '.github/workflows/internal-release.yml@main',
      head_sha: sha,
      referenced_workflows: [
        {
          path: `acme/api/.github/workflows/ui-automation.yml@${sha}`,
          sha,
          ref: 'refs/heads/develop',
        },
        { path: 'not a locator', sha },
        { path: `acme/api/.github/workflows/x.yml@${sha}`, sha: 'short' },
        { path: `acme/api/../escape.yml@${sha}`, sha },
      ],
    }).definitionSource;
    expect(source).toEqual({
      path: '.github/workflows/internal-release.yml',
      sha,
      referenced: [
        {
          repository: 'acme/api',
          path: '.github/workflows/ui-automation.yml',
          sha,
        },
      ],
    });
    expect(
      normalizeGitHubWorkflowRun({
        ...base,
        path: '/etc/passwd',
        head_sha: sha,
      }),
    ).not.toHaveProperty('definitionSource');
    expect(
      normalizeGitHubWorkflowRun({
        ...base,
        path: '.github/workflows/ci.yml',
        head_sha: 'develop',
      }),
    ).not.toHaveProperty('definitionSource');
    expect(normalizeGitHubWorkflowRun(base)).not.toHaveProperty(
      'definitionSource',
    );
  });

  it('keeps a valid run_started_at and drops a malformed one', () => {
    const base = {
      status: 'in_progress',
      conclusion: null,
      run_attempt: 1,
      html_url: 'https://github.com/acme/api/actions/runs/1',
      name: 'CI',
      run_number: 12,
    };
    expect(
      normalizeGitHubWorkflowRun({
        ...base,
        run_started_at: '2026-07-20T00:00:00Z',
      }).startedAt,
    ).toBe('2026-07-20T00:00:00.000Z');
    expect(
      normalizeGitHubWorkflowRun({ ...base, run_started_at: 'yesterday' })
        .startedAt,
    ).toBeUndefined();
    expect(normalizeGitHubWorkflowRun(base)).not.toHaveProperty('startedAt');
  });
});

describe('fetchGitHubWorkflowRun', () => {
  beforeEach(() => execute.mockReset());

  it('uses a conditional watcher read and returns cached 304 data unchanged', async () => {
    execute.mockImplementation(async (request, options) => {
      expect(options).toMatchObject({
        priority: 'watcher',
        operation: 'read',
        idempotency: 'safe',
        conditional: true,
        resourceKey: 'workflow-run:acme/api/123/current',
      });
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: {
            status: 'waiting',
            conclusion: null,
            run_attempt: 1,
            html_url: 'https://github.com/acme/api/actions/runs/123',
            name: 'CI',
            run_number: 8,
          },
        }),
      };
      await request(octokit, { 'if-none-match': '"etag"' });
      expect(octokit.request).toHaveBeenCalledWith(
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
        expect.objectContaining({
          owner: 'acme',
          repo: 'api',
          run_id: '123',
          headers: { 'if-none-match': '"etag"' },
        }),
      );
      return {
        kind: 'read',
        changed: false,
        status: 304,
        rateLimit: {},
        pollIntervalMs: 9000,
        data: normalizeGitHubWorkflowRun({
          status: 'waiting',
          conclusion: null,
          run_attempt: 1,
          html_url: 'https://github.com/acme/api/actions/runs/123',
          name: 'CI',
          run_number: 8,
        }),
      };
    });

    await expect(
      fetchGitHubWorkflowRun({
        repository: 'acme/api',
        runId: '123',
        priority: 'watcher',
      }),
    ).resolves.toMatchObject({
      changed: false,
      pollIntervalMs: 9000,
      snapshot: {
        state: { kind: 'intermediate', status: 'waiting' },
        runAttempt: 1,
        workflowName: 'CI',
      },
    });
  });

  it('preserves decimal run ids above the safe-integer limit', async () => {
    const runId = '9007199254740992';
    execute.mockImplementation(async (request) => {
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: {
            status: 'queued',
            conclusion: null,
            run_attempt: 1,
            html_url: `https://github.com/acme/api/actions/runs/${runId}`,
          },
        }),
      };
      await request(octokit, {});
      expect(octokit.request).toHaveBeenCalledWith(
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}',
        expect.objectContaining({ run_id: runId }),
      );
      return {
        kind: 'read',
        changed: true,
        status: 200,
        rateLimit: {},
        data: normalizeGitHubWorkflowRun({
          status: 'queued',
          conclusion: null,
          run_attempt: 1,
          html_url: `https://github.com/acme/api/actions/runs/${runId}`,
        }),
      };
    });

    await expect(
      fetchGitHubWorkflowRun({
        repository: 'acme/api',
        runId,
        priority: 'watcher',
      }),
    ).resolves.toMatchObject({
      snapshot: { state: { kind: 'intermediate', status: 'queued' } },
    });
  });

  it('uses and verifies the explicitly requested attempt endpoint', async () => {
    execute.mockImplementation(async (request, options) => {
      expect(options.resourceKey).toBe('workflow-run:acme/api/123/2');
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: {
            status: 'in_progress',
            conclusion: null,
            run_attempt: 2,
            html_url: 'https://github.com/acme/api/actions/runs/123/attempts/2',
          },
        }),
      };
      const response = await request(octokit, {});
      expect(octokit.request).toHaveBeenCalledWith(
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}',
        expect.objectContaining({
          run_id: '123',
          attempt_number: 2,
        }),
      );
      return {
        kind: 'read',
        changed: true,
        status: 200,
        rateLimit: {},
        data: response.data,
      };
    });

    await expect(
      fetchGitHubWorkflowRun({
        repository: 'acme/api',
        runId: '123',
        requestedAttempt: 2,
        priority: 'watcher',
      }),
    ).resolves.toMatchObject({ snapshot: { runAttempt: 2 } });
  });

  it('resolves a job to its parent run with one non-conditional read', async () => {
    execute.mockImplementation(async (request, options) => {
      expect(options).toMatchObject({
        priority: 'interactive',
        operation: 'read',
        idempotency: 'safe',
      });
      expect(options).not.toHaveProperty('resourceKey');
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: {
            id: 456,
            run_id: 123,
            run_attempt: 2,
            run_url: 'https://api.github.com/repos/acme/api/actions/runs/123',
          },
        }),
      };
      const response = await request(octokit, {});
      expect(octokit.request).toHaveBeenCalledWith(
        'GET /repos/{owner}/{repo}/actions/jobs/{job_id}',
        expect.objectContaining({ job_id: '456' }),
      );
      return {
        kind: 'read',
        changed: true,
        status: 200,
        rateLimit: {},
        data: response.data,
      };
    });

    await expect(
      resolveGitHubWorkflowRunJob({
        repository: 'acme/api',
        jobId: '456',
      }),
    ).resolves.toEqual({
      repository: 'acme/api',
      runId: '123',
      runAttempt: 2,
    });
  });

  it('fetches a bounded attempt-specific job projection without steps', async () => {
    execute.mockImplementation(async (request, options) => {
      expect(options).toMatchObject({
        priority: 'watcher',
        conditional: true,
        resourceKey: 'workflow-run-jobs:acme/api/123/2/1',
      });
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: {
            total_count: 1,
            jobs: [
              {
                id: 456,
                name: `Build\n${'macOS'.repeat(35)}`,
                status: 'completed',
                conclusion: 'success',
                html_url:
                  'https://github.com/acme/api/actions/runs/123/job/456',
                created_at: '2026-07-19T23:59:50Z',
                started_at: '2026-07-20T00:00:00Z',
                completed_at: '2026-07-20T00:03:00Z',
                steps: [{ name: 'large detail that must not escape' }],
              },
            ],
          },
        }),
      };
      const response = await request(octokit, { 'if-none-match': '"jobs"' });
      expect(octokit.request).toHaveBeenCalledWith(
        'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
        expect.objectContaining({
          run_id: '123',
          attempt_number: 2,
          per_page: 100,
          page: 1,
        }),
      );
      return {
        kind: 'read',
        changed: true,
        status: 200,
        rateLimit: {},
        data: response.data,
      };
    });

    await expect(
      fetchGitHubWorkflowRunJobs({
        repository: 'acme/api',
        runId: '123',
        runAttempt: 2,
        priority: 'watcher',
      }),
    ).resolves.toEqual({
      changed: true,
      jobs: [
        expect.objectContaining({
          jobId: '456',
          name: `Build ${'macOS'.repeat(35)}`,
          status: 'completed',
          conclusion: 'success',
          createdAt: '2026-07-19T23:59:50.000Z',
          startedAt: '2026-07-20T00:00:00.000Z',
          completedAt: '2026-07-20T00:03:00.000Z',
        }),
      ],
    });
  });

  it('pages exact-attempt jobs with independent conditional resource keys', async () => {
    const rawJobs = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      name: `Job ${index + 1}`,
      status: 'in_progress',
      conclusion: null,
      html_url: `https://github.com/acme/api/actions/runs/123/job/${index + 1}`,
    }));
    execute.mockImplementation(async (request, options) => {
      const page = execute.mock.calls.length;
      expect(options.resourceKey).toBe(
        `workflow-run-jobs:acme/api/123/2/${page}`,
      );
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: {
            total_count: rawJobs.length,
            jobs: page === 1 ? rawJobs.slice(0, 100) : rawJobs.slice(100),
          },
        }),
      };
      const response = await request(octokit, {});
      expect(octokit.request).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ page, per_page: 100 }),
      );
      return {
        kind: 'read',
        changed: page === 2,
        status: 200,
        rateLimit: {},
        data: response.data,
      };
    });

    const result = await fetchGitHubWorkflowRunJobs({
      repository: 'acme/api',
      runId: '123',
      runAttempt: 2,
      priority: 'watcher',
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.jobs).toHaveLength(101);
    expect(result.changed).toBe(true);
  });

  it('rejects workflow runs with more than 500 jobs', async () => {
    execute.mockImplementation(async (request) => {
      const octokit = {
        request: jest.fn().mockResolvedValue({
          status: 200,
          headers: {},
          data: { total_count: 501, jobs: [] },
        }),
      };
      const response: unknown = await request(octokit, {});
      return response;
    });

    await expect(
      fetchGitHubWorkflowRunJobs({
        repository: 'acme/api',
        runId: '123',
        runAttempt: 2,
        priority: 'watcher',
      }),
    ).rejects.toThrow('more than 500 jobs');
  });

  it('rejects malformed run ids before calling the broker', async () => {
    await expect(
      fetchGitHubWorkflowRun({
        repository: 'acme/api',
        runId: 'not-a-number',
        priority: 'watcher',
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    expect(execute).not.toHaveBeenCalled();
  });
});
