import {
  normalizeGitHubRepositoryReference,
  normalizeGitHubWorkflowRunTargets,
  parseGitHubWorkflowRunReference,
} from '../lib/github-workflow-run-references';

describe('GitHub workflow-run references', () => {
  it.each([
    ['123', { runId: '123' }],
    [123, { runId: '123' }],
    ['Acme/API#123', { repository: 'acme/api', runId: '123' }],
    [
      'acme/api#123/2',
      { repository: 'acme/api', runId: '123', requestedAttempt: 2 },
    ],
    [
      'https://github.com/acme/api/actions/runs/123',
      { repository: 'acme/api', runId: '123' },
    ],
    [
      'https://github.com/acme/api/actions/runs/123/attempts/2?check_suite_focus=true',
      { repository: 'acme/api', runId: '123', requestedAttempt: 2 },
    ],
    [
      'https://github.com/acme/api/actions/runs/123/job/456#step:3:1',
      { repository: 'acme/api', runId: '123', jobId: '456' },
    ],
    [
      'https://github.com/acme/api/runs/123/jobs/456',
      { repository: 'acme/api', runId: '123', jobId: '456' },
    ],
    [
      'https://api.github.com/repos/acme/api/actions/runs/123/attempts/2',
      { repository: 'acme/api', runId: '123', requestedAttempt: 2 },
    ],
    [
      'https://api.github.com/repos/acme/api/actions/jobs/456',
      { repository: 'acme/api', jobId: '456' },
    ],
  ])('parses %p', (reference, expected) => {
    expect(parseGitHubWorkflowRunReference(reference)).toEqual({
      ok: true,
      value: expected,
    });
  });

  it.each([
    ['acme/api', 'acme/api'],
    ['https://github.com/Acme/API.git/', 'acme/api'],
    ['https://www.github.com/acme/api', 'acme/api'],
  ])('normalizes repository reference %p', (reference, expected) => {
    expect(normalizeGitHubRepositoryReference(reference)).toBe(expected);
  });

  it('uses explicit, top-level, then unambiguous trusted repository context', async () => {
    const resolved = await normalizeGitHubWorkflowRunTargets({
      items: [
        'acme/explicit#1',
        { kind: 'workflow_run', runId: '2', repository: 'acme/item' },
        '3',
      ],
      repository: 'acme/default',
      repositoryCandidates: ['acme/context'],
      resolveJob: jest.fn(),
    });
    expect(resolved).toMatchObject({
      ok: true,
      targets: [
        { repository: 'acme/default', runId: '3' },
        { repository: 'acme/explicit', runId: '1' },
        { repository: 'acme/item', runId: '2' },
      ],
    });

    await expect(
      normalizeGitHubWorkflowRunTargets({
        items: ['4'],
        repositoryCandidates: ['acme/context'],
        resolveJob: jest.fn(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      targets: [{ repository: 'acme/context', runId: '4' }],
    });
  });

  it('resolves jobs once and rejects a conflicting parent run', async () => {
    const resolveJob = jest.fn().mockResolvedValue({
      repository: 'acme/api',
      runId: '123',
      runAttempt: 1,
    });
    await expect(
      normalizeGitHubWorkflowRunTargets({
        items: [
          'https://github.com/acme/api/actions/runs/123/job/456#step:2:1',
        ],
        resolveJob,
      }),
    ).resolves.toMatchObject({
      ok: true,
      targets: [{ repository: 'acme/api', runId: '123' }],
    });
    expect(resolveJob).toHaveBeenCalledTimes(1);

    resolveJob.mockResolvedValueOnce({
      repository: 'acme/api',
      runId: '999',
      runAttempt: 1,
    });
    await expect(
      normalizeGitHubWorkflowRunTargets({
        items: ['https://github.com/acme/api/actions/runs/123/job/456'],
        resolveJob,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'reference_conflict',
      itemIndex: 0,
    });
  });

  it('rejects an explicit attempt that conflicts with a copied job', async () => {
    await expect(
      normalizeGitHubWorkflowRunTargets({
        items: [
          {
            kind: 'workflow_run',
            target: 'https://github.com/acme/api/actions/runs/123/job/456',
            runAttempt: 2,
          },
        ],
        resolveJob: jest.fn().mockResolvedValue({
          repository: 'acme/api',
          runId: '123',
          runAttempt: 3,
        }),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'reference_conflict',
      itemIndex: 0,
    });
  });

  it('validates every local item before resolving any job', async () => {
    const resolveJob = jest.fn();
    const result = await normalizeGitHubWorkflowRunTargets({
      items: [
        'https://api.github.com/repos/acme/api/actions/jobs/456',
        'https://example.com/acme/api/actions/runs/123',
      ],
      resolveJob,
    });
    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_reference',
      itemIndex: 1,
    });
    expect(resolveJob).not.toHaveBeenCalled();
  });

  it.each([
    {
      items: [Number.MAX_SAFE_INTEGER + 1],
      code: 'invalid_reference',
      message: 'Quote workflow run IDs',
    },
    {
      items: ['123'],
      repositoryCandidates: ['acme/a', 'acme/b'],
      code: 'repository_required',
      message: 'A repository is required',
    },
    {
      items: [
        {
          kind: 'workflow_run',
          target: 'https://github.com/acme/a/actions/runs/123',
          repository: 'acme/b',
        },
      ],
      code: 'reference_conflict',
      message: 'do not agree',
    },
  ])('returns an actionable item error for $code', async (input) => {
    const result = await normalizeGitHubWorkflowRunTargets({
      items: input.items,
      repositoryCandidates: input.repositoryCandidates,
      resolveJob: jest.fn(),
    });
    expect(result).toMatchObject({
      ok: false,
      code: input.code,
      itemIndex: 0,
    });
    expect(result.ok || result.message).toEqual(
      expect.stringContaining(input.message),
    );
  });

  it('rejects aliases that resolve to the same canonical target', async () => {
    await expect(
      normalizeGitHubWorkflowRunTargets({
        items: [
          'acme/api#00123',
          'https://github.com/acme/api/actions/runs/123',
        ],
        resolveJob: jest.fn(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'duplicate_item',
      itemIndex: 1,
    });
  });
});
