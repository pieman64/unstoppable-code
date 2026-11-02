import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { AgentActionCall } from '@canopy/agent-actions';
import type { CapabilityPackageAnalyzeInput } from '@canopy/protocol/capability-package-repair';
import type {
  PipelinePackageAnalysisSummary,
  PipelineInfo,
} from '@canopy/protocol/pipelines';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import {
  createDesktopCapabilityPackagePort,
  type DesktopCapabilityPackageDeps,
} from '../desktop-capability-package-port';

const ready: PipelinePackageAnalysisSummary = {
  analysisId: 'temporary',
  pipelineContentHash: 'hash',
  state: 'ready',
  blockers: [],
  expiresAt: '',
};
const skill: CapabilityPackageAnalyzeInput = {
  subject: { kind: 'skill', sourceId: 'custom:app', skillName: 'broken' },
};
function setup(
  cwd: string,
  executionScope: 'worktree' | 'directory' = 'worktree',
): {
  deps: DesktopCapabilityPackageDeps;
  call: AgentActionCall<CanopyInjectedToolRuntime>;
  port: ReturnType<typeof createDesktopCapabilityPackagePort>;
} {
  const deps: DesktopCapabilityPackageDeps = {
    readRawSkill: jest.fn(() => Promise.resolve('saved skill')),
    getStoredPipelineBySource: jest.fn(() => ({ success: false })),
    assertStoredPipelineContext: jest.fn(() => Promise.resolve()),
    assertPipelineShareSourceContext: jest.fn(() => Promise.resolve()),
    readPipelineShareSource: jest.fn(() =>
      Promise.resolve(
        'name: Saved pipeline\non: dispatch\njobs:\n  repair:\n    steps:\n      - run: echo ready\n',
      ),
    ),
    resolveWorktreeCwd: jest.fn(() => cwd),
    discoverProjectPipelines: jest.fn(() => Promise.resolve([])),
    analyzeSkillCapabilityPackage: jest.fn(() => Promise.resolve(ready)),
    analyzePackageRequest: jest.fn(() => Promise.resolve(ready)),
    cancelPackageAnalysis: jest.fn(),
  };
  const call: AgentActionCall<CanopyInjectedToolRuntime> = {
    host: {
      requestUserAnswers: () => Promise.resolve([]),
      loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
      worktreeActionRuntime: {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        cwd,
        executionScope,
        getWindow: () => null,
      },
    },
    scope: { workspaceId: 'project', worktreeId: 'worktree', chatId: 'chat' },
  };
  return { deps, call, port: createDesktopCapabilityPackagePort(deps) };
}
describe('desktop capability package port', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'can3488-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each(['worktree', 'directory'] as const)(
    'reads current custom skill on %s and releases analysis',
    async (scope) => {
      const h = setup(root, scope);
      const input = {
        ...skill,
        context: {
          dismissedInvocations: [
            { provider: 'claude' as const, token: '/ignored' },
          ],
        },
      };
      expect(await h.port.analyze(input, h.call)).toMatchObject({
        state: 'ready',
      });
      expect(h.deps.readRawSkill).toHaveBeenCalledWith('custom:app/broken');
      expect(h.deps.analyzeSkillCapabilityPackage).toHaveBeenCalledWith(
        {
          sourceId: 'custom:app',
          skillName: 'broken',
          rawSkill: 'saved skill',
          dismissedInvocations: input.context.dismissedInvocations,
        },
        { persistDismissals: false },
      );
      expect(h.deps.cancelPackageAnalysis).toHaveBeenCalledWith('temporary');
    },
  );
  it('retains blockers from the existing analyzer', async () => {
    const h = setup(root);
    jest.mocked(h.deps.analyzeSkillCapabilityPackage).mockResolvedValue({
      ...ready,
      state: 'blocked',
      blockers: [
        {
          code: 'UNRESOLVED_INVOCATION',
          message: 'Run /missing.',
          occurrences: [],
        },
      ],
    });
    expect(await h.port.analyze(skill, h.call)).toMatchObject({
      state: 'blocked',
      blockers: [{ message: 'Run /missing.' }],
    });
    expect(h.deps.cancelPackageAnalysis).toHaveBeenCalledTimes(1);
  });
  it('rejects missing/unavailable stored pipelines without a fallback', async () => {
    const h = setup(root);
    expect(
      await h.port.analyze(
        { subject: { kind: 'user-pipeline', pipelineId: 'missing' } },
        h.call,
      ),
    ).toMatchObject({ state: 'failed' });
    expect(h.deps.readPipelineShareSource).not.toHaveBeenCalled();
    expect(h.deps.analyzePackageRequest).not.toHaveBeenCalled();
  });
  it('emits the original stored item artifact on ready without any root save', async () => {
    const h = setup(root);
    const { parsePipelineText } =
      await import('@canopy/desktop-shared/pipelines/parse-pipeline');
    const content = parsePipelineText(
      'name: Saved\non: dispatch\njobs:\n  repair:\n    steps:\n      - run: echo ready\n',
    );
    jest.mocked(h.deps.getStoredPipelineBySource).mockReturnValue({
      success: true,
      data: {
        info: {
          id: 'saved',
          name: 'Saved',
          description: '',
          icon: '',
          filename: 'saved.yaml',
          source: 'user',
          readonly: false,
          createdAt: '',
          updatedAt: '',
        },
        content,
      },
    });
    h.deps.createArtifacts = jest.fn(() =>
      Promise.resolve([{ kind: 'pipeline', localId: 'saved' }]),
    );
    const result = await h.port.analyze(
      { subject: { kind: 'user-pipeline', pipelineId: 'saved' } },
      h.call,
    );
    expect(result).toMatchObject({
      state: 'ready',
      agentArtifacts: [{ localId: 'saved' }],
    });
    expect(h.deps.assertStoredPipelineContext).toHaveBeenCalledWith(
      'saved',
      'project',
    );
    expect(h.deps.createArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { kind: 'user-pipeline', pipelineId: 'saved' },
      }),
      h.call,
    );
    expect(h.deps.cancelPackageAnalysis).toHaveBeenCalledWith('temporary');
  });
  it('keeps the original item reachable when a dependency-only repair is still blocked', async () => {
    const h = setup(root);
    jest.mocked(h.deps.analyzeSkillCapabilityPackage).mockResolvedValue({
      ...ready,
      state: 'blocked',
      blockers: [
        {
          code: 'UNRESOLVED_INVOCATION',
          message: 'Choose a replacement for /missing.',
          occurrences: [],
        },
      ],
    });
    h.deps.createArtifacts = jest.fn(() =>
      Promise.resolve([{ kind: 'skill', installedName: 'broken' }]),
    );
    expect(await h.port.analyze(skill, h.call)).toMatchObject({
      state: 'blocked',
      agentArtifacts: [{ installedName: 'broken' }],
    });
    expect(h.deps.cancelPackageAnalysis).toHaveBeenCalledWith('temporary');
  });
  it('does not analyze an unauthorized skill', async () => {
    const h = setup(root);
    jest
      .mocked(h.deps.readRawSkill)
      .mockRejectedValue(new Error('Skill unavailable (context-mismatch)'));
    expect(await h.port.analyze(skill, h.call)).toMatchObject({
      state: 'failed',
      error: 'Skill unavailable (context-mismatch)',
    });
    expect(h.deps.analyzeSkillCapabilityPackage).not.toHaveBeenCalled();
  });
  it('preserves the original failure when cleanup also fails', async () => {
    const h = setup(root);
    h.deps.projectAnalysis = (): never => {
      throw new Error('Projection failed');
    };
    jest
      .mocked(h.deps.cancelPackageAnalysis)
      .mockRejectedValue(new Error('cleanup'));
    expect(await h.port.analyze(skill, h.call)).toMatchObject({
      state: 'failed',
      error: 'Projection failed',
    });
    expect(h.deps.cancelPackageAnalysis).toHaveBeenCalledWith('temporary');
  });
  it('does not report readiness if cleanup fails', async () => {
    const h = setup(root);
    jest
      .mocked(h.deps.cancelPackageAnalysis)
      .mockRejectedValue(new Error('cleanup'));
    expect(await h.port.analyze(skill, h.call)).toMatchObject({
      state: 'failed',
    });
  });
  it('rejects context outside the calling chat before reading anything', async () => {
    const h = setup(root);
    expect(
      await h.port.analyze(
        { ...skill, context: { worktree: { worktreeId: 'other' } } },
        h.call,
      ),
    ).toMatchObject({ state: 'failed' });
    expect(h.deps.readRawSkill).not.toHaveBeenCalled();
    expect(
      await h.port.analyze(skill, { ...h.call, scope: undefined }),
    ).toMatchObject({ state: 'failed' });
  });
  async function projectFixture(): Promise<
    ReturnType<typeof setup> & {
      cwd: string;
      input: CapabilityPackageAnalyzeInput;
      info: PipelineInfo;
      filePath: string;
    }
  > {
    const cwd = path.join(root, 'worktree');
    const relativePath = '.canopy/pipelines/fix.yaml';
    const filePath = path.join(cwd, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'pipeline: {}');
    const h = setup(cwd);
    const info: PipelineInfo = {
      id: 'project--fix.yaml',
      name: 'Fix',
      filename: 'fix.yaml',
      source: 'project',
      readonly: true,
      filePath,
      description: '',
      icon: '',
      createdAt: '',
      updatedAt: '',
    };
    jest.mocked(h.deps.discoverProjectPipelines).mockResolvedValue([info]);
    const input: CapabilityPackageAnalyzeInput = {
      subject: {
        kind: 'project-pipeline',
        pipelineId: info.id,
        worktreeId: 'worktree',
        relativePath,
      },
    };
    return { ...h, cwd, input, info, filePath };
  }
  it('uses the calling worktree and exact project-file identity', async () => {
    const h = await projectFixture();
    expect(await h.port.analyze(h.input, h.call)).toMatchObject({
      state: 'ready',
    });
    expect(h.deps.readPipelineShareSource).toHaveBeenCalledWith({
      kind: 'project',
      projectId: 'project',
      worktreeId: 'worktree',
      pipelineFilePath: h.filePath,
    });
    expect(h.deps.analyzePackageRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: 'project--fix.yaml',
        rawPipeline:
          'name: Saved pipeline\non: dispatch\njobs:\n  repair:\n    steps:\n      - run: echo ready\n',
        worktree: { projectId: 'project', worktreeId: 'worktree' },
      }),
      { persistDismissals: false },
    );
  });
  it('rejects symlink escapes before discovery or analysis', async () => {
    const h = await projectFixture();
    await rm(h.filePath);
    const outside = path.join(root, 'outside.yaml');
    await writeFile(outside, 'private');
    await symlink(outside, h.filePath);
    expect(await h.port.analyze(h.input, h.call)).toMatchObject({
      state: 'failed',
    });
    expect(h.deps.discoverProjectPipelines).not.toHaveBeenCalled();
    expect(h.deps.readPipelineShareSource).not.toHaveBeenCalled();
  });
  it('rejects ambiguous identities and project requests in Cowork', async () => {
    const h = await projectFixture();
    jest
      .mocked(h.deps.discoverProjectPipelines)
      .mockResolvedValue([h.info, h.info]);
    expect(await h.port.analyze(h.input, h.call)).toMatchObject({
      state: 'failed',
    });
    const cowork = setup(h.cwd, 'directory');
    expect(await cowork.port.analyze(h.input, cowork.call)).toMatchObject({
      state: 'failed',
    });
    expect(cowork.deps.discoverProjectPipelines).not.toHaveBeenCalled();
  });
});
