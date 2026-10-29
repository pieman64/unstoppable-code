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

import type { GitHubWorkflowDefinitionSource } from '@canopy/desktop-shared/types';
import {
  fetchGitHubWorkflowDefinitionGraph,
  MAX_WORKFLOW_DEFINITION_BYTES,
  normalizeGitHubWorkflowFile,
  resolveGitHubWorkflowCall,
} from '../lib/github-broker/workflow-definitions';

const SHA = 'a'.repeat(40);
const CALLED_SHA = 'b'.repeat(40);
const source: GitHubWorkflowDefinitionSource = {
  path: '.github/workflows/release.yml',
  sha: SHA,
  referenced: [
    {
      repository: 'acme/api',
      path: '.github/workflows/ui.yml',
      sha: CALLED_SHA,
    },
    { repository: 'acme/shared', path: 'workflows/lint.yml', sha: CALLED_SHA },
  ],
};

const ROOT = `
jobs:
  gate:
    name: Gate
    steps: []
  ui:
    name: UI
    needs: gate
    uses: ./.github/workflows/ui.yml
  lint:
    needs: gate
    uses: acme/shared/workflows/lint.yml@main
  ship:
    needs: [ui, lint]
    steps: []
`;
const UI = `
jobs:
  e2e:
    name: E2E (\${{ matrix.shard }})
    strategy:
      matrix:
        shard: [1, 2]
    steps: []
`;

function fileResponse(text: string) {
  return {
    type: 'file',
    encoding: 'base64',
    size: Buffer.byteLength(text),
    content: Buffer.from(text).toString('base64'),
  };
}

describe('GitHub workflow definition reads', () => {
  beforeEach(() => {
    execute.mockReset();
  });

  it('resolves local and remote reusable-workflow calls to pinned files', () => {
    expect(
      resolveGitHubWorkflowCall(
        './.github/workflows/ui.yml',
        'acme/api',
        source,
      ),
    ).toEqual({
      repository: 'acme/api',
      path: '.github/workflows/ui.yml',
      sha: CALLED_SHA,
    });
    // A local file GitHub did not list is read at the run's own commit.
    expect(
      resolveGitHubWorkflowCall(
        './.github/workflows/other.yml',
        'acme/api',
        source,
      ),
    ).toEqual({
      repository: 'acme/api',
      path: '.github/workflows/other.yml',
      sha: SHA,
    });
    expect(
      resolveGitHubWorkflowCall(
        'acme/shared/workflows/lint.yml@main',
        'acme/api',
        source,
      ),
    ).toEqual({
      repository: 'acme/shared',
      path: 'workflows/lint.yml',
      sha: CALLED_SHA,
    });
    // An unlisted remote ref is only trusted when it already is a commit.
    expect(
      resolveGitHubWorkflowCall(
        `acme/other/w.yml@${CALLED_SHA}`,
        'acme/api',
        source,
      ),
    ).toMatchObject({ repository: 'acme/other', sha: CALLED_SHA });
    expect(
      resolveGitHubWorkflowCall('acme/other/w.yml@main', 'acme/api', source),
    ).toBeNull();
    expect(
      resolveGitHubWorkflowCall('./../escape.yml', 'acme/api', source),
    ).toBeNull();
    expect(
      resolveGitHubWorkflowCall('docker://x', 'acme/api', source),
    ).toBeNull();
  });

  it('decodes only bounded base64 file responses', () => {
    expect(normalizeGitHubWorkflowFile(fileResponse('jobs: {}'))).toEqual({
      text: 'jobs: {}',
    });
    expect(() => normalizeGitHubWorkflowFile({ type: 'dir' })).toThrow(
      'malformed',
    );
    expect(() =>
      normalizeGitHubWorkflowFile({
        ...fileResponse('x'),
        size: MAX_WORKFLOW_DEFINITION_BYTES + 1,
      }),
    ).toThrow('malformed');
    const { size: _unreported, ...oversized } = fileResponse(
      'y'.repeat(MAX_WORKFLOW_DEFINITION_BYTES + 1),
    );
    void _unreported;
    expect(() => normalizeGitHubWorkflowFile(oversized)).toThrow('too large');
  });

  it('reads the root and every resolvable call at their pinned commits and builds the graph', async () => {
    const requested: Array<Record<string, string>> = [];
    execute.mockImplementation(async (request, options) => {
      expect(options).toMatchObject({
        priority: 'watcher',
        conditional: true,
        operation: 'read',
      });
      const octokit = {
        request: jest.fn((_route: string, params: Record<string, string>) => {
          requested.push(params);
          const key = `${params.owner}/${params.repo}/${params.path}@${params.ref}`;
          const text =
            key === `acme/api/.github/workflows/release.yml@${SHA}`
              ? ROOT
              : key === `acme/api/.github/workflows/ui.yml@${CALLED_SHA}`
                ? UI
                : null;
          if (text === null) {
            return Promise.reject(new Error('Not Found'));
          }
          return Promise.resolve({
            status: 200,
            headers: {},
            data: fileResponse(text),
          });
        }),
      };
      const response = await request(octokit, {});
      return {
        kind: 'read',
        changed: true,
        status: 200,
        rateLimit: {},
        data: response.data,
      };
    });

    const graph = await fetchGitHubWorkflowDefinitionGraph({
      repository: 'acme/api',
      source,
      priority: 'watcher',
    });
    expect(
      requested.map(
        (params) =>
          `${params.owner}/${params.repo}/${params.path}@${params.ref}`,
      ),
    ).toEqual([
      `acme/api/.github/workflows/release.yml@${SHA}`,
      `acme/api/.github/workflows/ui.yml@${CALLED_SHA}`,
      `acme/shared/workflows/lint.yml@${CALLED_SHA}`,
    ]);
    const resourceKeys: string[] = execute.mock.calls.map(
      ([, options]: [unknown, { resourceKey: string }]) => options.resourceKey,
    );
    expect(resourceKeys).toEqual([
      `workflow-definition:acme/api/.github/workflows/release.yml@${SHA}`,
      `workflow-definition:acme/api/.github/workflows/ui.yml@${CALLED_SHA}`,
      `workflow-definition:acme/shared/workflows/lint.yml@${CALLED_SHA}`,
    ]);
    expect(graph?.sha).toBe(SHA);
    expect(
      graph?.jobs.map((job) => [job.id, job.names, job.needs, job.dynamic]),
    ).toEqual([
      ['gate', ['Gate'], [], false],
      ['ui/e2e', ['UI / E2E (1)', 'UI / E2E (2)'], ['gate'], false],
      // The lint workflow could not be read: its caller collapses to one dynamic node.
      ['lint', [], ['gate'], true],
      ['ship', ['ship'], ['ui/e2e', 'lint'], false],
    ]);
  });

  it('propagates a failed root read and returns null for an unusable root', async () => {
    execute.mockRejectedValueOnce(new Error('offline'));
    await expect(
      fetchGitHubWorkflowDefinitionGraph({
        repository: 'acme/api',
        source,
        priority: 'interactive',
      }),
    ).rejects.toThrow('offline');

    execute.mockResolvedValueOnce({
      kind: 'read',
      changed: true,
      status: 200,
      rateLimit: {},
      data: { text: 'name: nothing here\n' },
    });
    await expect(
      fetchGitHubWorkflowDefinitionGraph({
        repository: 'acme/api',
        source,
        priority: 'interactive',
      }),
    ).resolves.toBeNull();
  });
});
