import { assertStoredPipelineContext } from '../pipelines/pipeline-install-context';
let mockContextEnabled = false;
const mockAuthorizeProject = jest.fn();
jest.mock('../pipelines/resource-lanes', () => ({
  pipelineResourceContextEnabled: (): boolean => mockContextEnabled,
}));
jest.mock('../pipelines/pipeline-install-context', () => ({
  authorizeProjectPipelineRequest: (...args: unknown[]): unknown =>
    mockAuthorizeProject(...args),
  assertStoredPipelineContext: jest.fn(() => Promise.resolve()),
}));
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const mockGetManagedCuratedPipeline = jest.fn();
jest.mock('../pipelines/curated-pipeline-catalog', () => ({
  // Lazy so the hoisted factory never reads the mock before its declaration runs.
  getManagedCuratedPipeline: (...args: unknown[]): unknown =>
    mockGetManagedCuratedPipeline(...args),
}));

const mockGetPipelineText = jest.fn();
const mockGetPipelinePath = jest.fn();
const mockListPipelines = jest.fn();
const mockDiscoverProjectPipelines = jest.fn();

jest.mock('../pipelines/pipeline-service', () => ({
  get getPipelineText(): typeof mockGetPipelineText {
    return mockGetPipelineText;
  },
  get getPipelinePath(): typeof mockGetPipelinePath {
    return mockGetPipelinePath;
  },
  get listPipelines(): typeof mockListPipelines {
    return mockListPipelines;
  },
}));

jest.mock('../pipelines/project-pipeline-discovery', () => ({
  get discoverProjectPipelines(): typeof mockDiscoverProjectPipelines {
    return mockDiscoverProjectPipelines;
  },
}));

jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/mock/worktree'),
}));

import { readWorktreePipelineYaml } from '../canopy-tools/pipeline-yaml-reader';

describe('readWorktreePipelineYaml', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockContextEnabled = false;
    mockGetPipelinePath.mockReturnValue({
      success: true,
      data: '/mock/pipelines/review.yaml',
    });
    mockListPipelines.mockReturnValue({
      success: true,
      data: [
        {
          id: 'review',
          name: 'Review',
          source: 'user',
          filename: 'review.yaml',
        },
      ],
    });
    mockDiscoverProjectPipelines.mockResolvedValue([]);
  });

  it('binds stored YAML authorization to the request project', async (): Promise<void> => {
    mockContextEnabled = true;
    mockGetPipelineText.mockReturnValue({
      success: true,
      data: 'name: Secret\non: dispatch\njobs: {}',
    });
    const check = jest.mocked(assertStoredPipelineContext);
    check.mockImplementation(
      (_id, projectId): Promise<void> =>
        projectId === 'personal'
          ? Promise.reject(new Error('Workflow unavailable (context-mismatch)'))
          : Promise.resolve(),
    );
    try {
      const result = await readWorktreePipelineYaml({
        projectId: 'personal',
        worktreeId: 'wt',
        pipelineId: 'review',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('context-mismatch');
      expect(mockGetPipelineText).not.toHaveBeenCalled();
    } finally {
      check.mockResolvedValue();
    }
  });

  it('authorizes project YAML reads before returning bytes', async (): Promise<void> => {
    mockContextEnabled = true;
    const dir = await mkdtemp(join(tmpdir(), 'project-yaml-'));
    const filePath = join(dir, 'review.yaml');
    try {
      await writeFile(filePath, 'name: Secret');
      mockGetPipelineText.mockReturnValue({ success: false });
      mockDiscoverProjectPipelines.mockResolvedValue([
        {
          id: 'project--review.yaml',
          name: 'Secret',
          source: 'project',
          filePath,
        },
      ]);
      mockAuthorizeProject.mockRejectedValue(
        new Error('Workflow unavailable (context-mismatch)'),
      );
      const result = await readWorktreePipelineYaml({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pipelineId: 'project--review.yaml',
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('context-mismatch');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('materializes curated YAML before serving exact raw lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'curated-yaml-'));
    const filePath = join(dir, 'verified.yaml');
    try {
      await writeFile(
        filePath,
        '# preserved comment\npipeline:\n  name: Curated review\n',
      );
      mockGetManagedCuratedPipeline.mockResolvedValue({
        info: {
          id: 'curated:review',
          name: 'Curated review',
          source: 'curated',
          filename: 'verified.yaml',
          filePath,
        },
      });
      mockGetPipelineText.mockReturnValue({ success: false });
      const result = await readWorktreePipelineYaml({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        pipelineId: 'curated:review',
      });
      expect(result.ok).toBe(true);
      expect(mockGetManagedCuratedPipeline).toHaveBeenCalledWith(
        'curated:review',
      );
      expect(result.text).toContain('Source: curated');
      expect(result.text).toContain('1: # preserved comment');
      expect(mockGetPipelineText).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads raw YAML with line ranges and grep-like fixed-string context', async () => {
    mockGetPipelineText.mockReturnValue({
      success: true,
      data: [
        'pipeline:',
        '  name: Review',
        '  jobs:',
        '    review:',
        '      steps:',
        '        - run: npm test',
      ].join('\n'),
    });

    const result = await readWorktreePipelineYaml({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      pipelineId: 'review',
      startLine: 2,
      endLine: 6,
      pattern: 'steps',
      fixedString: true,
      beforeContext: 1,
      afterContext: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain('Pipeline YAML: Review (review)');
    expect(result.text).toContain('Pattern: steps');
    expect(result.text).toContain('Matched lines: 1');
    expect(result.text).toContain('4:     review:');
    expect(result.text).toContain('5:       steps:');
    expect(result.text).toContain('6:         - run: npm test');
    expect(result.text).not.toContain('1: pipeline:');
  });

  it('returns an invalid grep pattern error for malformed regex input', async () => {
    mockGetPipelineText.mockReturnValue({
      success: true,
      data: 'pipeline:\n  name: Review',
    });

    const result = await readWorktreePipelineYaml({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      pipelineId: 'review',
      pattern: '[',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Invalid grep pattern');
  });

  it('rejects regex patterns above the length cap', async () => {
    mockGetPipelineText.mockReturnValue({
      success: true,
      data: 'pipeline:\n  name: Review',
    });

    const result = await readWorktreePipelineYaml({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      pipelineId: 'review',
      pattern: 'a'.repeat(1001),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      'Regex pattern must be at most 1000 characters',
    );
  });
});
