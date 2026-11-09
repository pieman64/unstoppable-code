import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import type {
  AgentActionCall,
  AgentCapabilityPackagePort,
  AgentCapabilityPackageAnalysisResult,
  AgentJson,
} from '@canopy/agent-actions';
import { z } from 'zod';
import {
  capabilityRepairSubjectSchema,
  capabilityRepairAnalysisContextSchema,
  failedCapabilityPackageAnalysis,
  projectCapabilityPackageAnalysis,
  sanitizeCapabilityRepairText,
  type CapabilityRepairSubject,
  type CapabilityPackageAnalyzeInput,
  type CapabilityPackageAnalysisResult,
} from '@canopy/protocol/capability-package-repair';
import type { PipelinePackageAnalysisSummary } from '@canopy/protocol/pipelines';
import type {
  PipelineShareSource,
  PipelineData,
} from '@canopy/execution-engine/types/pipeline';
import type { CanopyInjectedToolRuntime } from '../canopy-tools/core';
import { isPathInside } from '../lib/path-safety';
import type * as SkillsService from '../skills/skill-service';
import type * as PipelinesService from '../pipelines/pipeline-service';
import type * as PipelineSources from '../pipelines/pipeline-install-context';
import type * as WorktreeResolver from '../lib/resolve-worktree';
import type * as ProjectPipelines from '../pipelines/project-pipeline-discovery';
import type * as PackageAnalysis from '../pipelines/pipeline-package-service';

export interface DesktopCapabilityPackageDeps {
  createArtifacts?: (
    input: { subject: CapabilityRepairSubject; pipeline?: PipelineData },
    call: AgentActionCall<CanopyInjectedToolRuntime>,
  ) => Promise<AgentJson[]>;
  readRawSkill: typeof SkillsService.readRawSkill;
  getStoredPipelineBySource: typeof PipelinesService.getStoredPipelineBySource;
  assertStoredPipelineContext: typeof PipelineSources.assertStoredPipelineContext;
  assertPipelineShareSourceContext: typeof PipelineSources.assertPipelineShareSourceContext;
  readPipelineShareSource: typeof PipelineSources.readPipelineShareSource;
  resolveWorktreeCwd: typeof WorktreeResolver.resolveWorktreeCwd;
  discoverProjectPipelines: typeof ProjectPipelines.discoverProjectPipelines;
  analyzeSkillCapabilityPackage: typeof PackageAnalysis.analyzeSkillCapabilityPackage;
  analyzePackageRequest: typeof PackageAnalysis.analyzePackageRequest;
  cancelPackageAnalysis: (analysisId: string) => void | Promise<void>;
  projectAnalysis?: (
    summary: PipelinePackageAnalysisSummary,
  ) => CapabilityPackageAnalysisResult;
}

/** Uses the existing unmigrated sharing services; grants and writers stay there. */
export function createDesktopCapabilityPackagePort(
  deps: DesktopCapabilityPackageDeps,
): AgentCapabilityPackagePort<CanopyInjectedToolRuntime> {
  return {
    analyze: async (
      input,
      call,
    ): Promise<AgentCapabilityPackageAnalysisResult> => {
      let summary: PipelinePackageAnalysisSummary | undefined;
      let result: AgentCapabilityPackageAnalysisResult =
        failedCapabilityPackageAnalysis(
          new Error('Dependency analysis did not complete.'),
        );
      try {
        // Validate even when the port is called without the shared surface.
        const subject = capabilityRepairSubjectSchema.parse(input.subject);
        const context = capabilityRepairAnalysisContextSchema
          .optional()
          .parse(input.context);
        const runtime = call.host.worktreeActionRuntime;
        if (
          !runtime ||
          !call.scope ||
          runtime.projectId !== call.scope.workspaceId ||
          runtime.worktreeId !== call.scope.worktreeId ||
          runtime.chatId !== call.scope.chatId
        )
          throw new Error('The calling chat context is unavailable.');
        const locator =
          subject.kind === 'project-pipeline' ? subject : context?.worktree;
        if (
          subject.kind === 'project-pipeline' &&
          context?.worktree &&
          (context.worktree.worktreeId !== subject.worktreeId ||
            context.worktree.repoId !== subject.repoId)
        )
          throw new Error(
            'Project pipeline analysis context does not match its subject.',
          );
        if (
          locator &&
          (runtime.executionScope === 'directory' ||
            locator.worktreeId !== runtime.worktreeId)
        )
          throw new Error(
            'The subject must belong to the calling chat’s worktree.',
          );
        const worktree = locator
          ? {
              projectId: runtime.projectId,
              worktreeId: runtime.worktreeId,
              ...(locator.repoId ? { repoId: locator.repoId } : {}),
            }
          : undefined;
        const dismissals = context?.dismissedInvocations;
        let pipeline: PipelineData | undefined;
        if (subject.kind === 'skill') {
          const rawSkill = await deps.readRawSkill(
            `${subject.sourceId}/${subject.skillName}`,
          );
          summary = await deps.analyzeSkillCapabilityPackage(
            {
              sourceId: subject.sourceId,
              skillName: subject.skillName,
              rawSkill,
              ...(worktree ? { worktree } : {}),
              ...(dismissals !== undefined
                ? { dismissedInvocations: dismissals }
                : {}),
            },
            { persistDismissals: false },
          );
        } else {
          let sourcePipeline: PipelineShareSource;
          if (subject.kind === 'user-pipeline') {
            await deps.assertStoredPipelineContext(
              subject.pipelineId,
              runtime.projectId,
            );
            const stored = deps.getStoredPipelineBySource(
              'user',
              subject.pipelineId,
            );
            if (
              !stored.success ||
              !stored.data ||
              stored.data.info.source !== 'user' ||
              stored.data.info.id !== subject.pipelineId
            )
              throw new Error(
                'The saved user pipeline is missing or unavailable.',
              );
            sourcePipeline = {
              kind: 'stored',
              id: subject.pipelineId,
              source: 'user',
            };
            pipeline = stored.data;
          } else {
            const cwd = deps.resolveWorktreeCwd(
              runtime.projectId,
              runtime.worktreeId,
              subject.repoId,
            );
            const file = path.resolve(cwd, subject.relativePath);
            const [canonicalRoot, canonicalFile] = await Promise.all([
              realpath(cwd),
              realpath(file),
            ]);
            if (
              !isPathInside(cwd, file) ||
              !isPathInside(canonicalRoot, canonicalFile)
            )
              throw new Error(
                'Project pipeline path is outside the calling worktree.',
              );
            const matches = (await deps.discoverProjectPipelines(cwd)).filter(
              (row) =>
                row.id === subject.pipelineId &&
                row.filePath !== undefined &&
                path.resolve(row.filePath) === file,
            );
            if (matches.length !== 1)
              throw new Error(
                'The project pipeline identity is missing or ambiguous.',
              );
            sourcePipeline = {
              kind: 'project',
              projectId: runtime.projectId,
              worktreeId: runtime.worktreeId,
              pipelineFilePath: file,
              ...(subject.repoId ? { repoId: subject.repoId } : {}),
            };
            // Content comes from the same authorized source read below.
          }
          await deps.assertPipelineShareSourceContext(sourcePipeline);
          const rawPipeline =
            await deps.readPipelineShareSource(sourcePipeline);
          if (sourcePipeline.kind === 'project') {
            const { parsePipelineText } =
              await import('@canopy/desktop-shared/pipelines/parse-pipeline');
            const content = parsePipelineText(rawPipeline);
            pipeline = {
              info: {
                id: subject.pipelineId,
                name: content.name,
                description: content.description ?? '',
                icon: content.icon ?? '',
                filename: path.basename(sourcePipeline.pipelineFilePath),
                source: 'project',
                readonly: true,
                filePath: sourcePipeline.pipelineFilePath,
                createdAt: '',
                updatedAt: '',
              },
              content,
            };
          }
          summary = await deps.analyzePackageRequest(
            {
              rawPipeline,
              sourcePipeline,
              pipelineId: subject.pipelineId,
              ...(worktree ? { worktree } : {}),
              ...(dismissals !== undefined
                ? { dismissedInvocations: dismissals }
                : {}),
            },
            { persistDismissals: false },
          );
        }
        result = (deps.projectAnalysis ?? projectCapabilityPackageAnalysis)(
          summary,
        );
        if (result.state !== 'failed' && deps.createArtifacts)
          result = {
            ...result,
            agentArtifacts: await deps.createArtifacts(
              { subject, ...(pipeline ? { pipeline } : {}) },
              call,
            ),
          };
      } catch (error) {
        result = failedCapabilityPackageAnalysis(error);
      } finally {
        if (summary) {
          try {
            await deps.cancelPackageAnalysis(summary.analysisId);
          } catch {
            // Never report readiness after a failed read-only lifecycle.
            // The original analysis/projection failure remains authoritative.
            if (result.state !== 'failed')
              result = failedCapabilityPackageAnalysis(
                new Error(
                  'Could not release temporary dependency analysis. Recheck dependencies.',
                ),
              );
          }
        }
      }
      return result;
    },
  };
}

// Load the service graph only when this action runs, never at tool discovery or startup.
let productionPort:
  | Promise<AgentCapabilityPackagePort<CanopyInjectedToolRuntime>>
  | undefined;
async function loadProductionPort(): Promise<
  AgentCapabilityPackagePort<CanopyInjectedToolRuntime>
> {
  const [skills, pipelines, source, resolver, discovery, analysis] =
    await Promise.all([
      import('../skills/skill-service'),
      import('../pipelines/pipeline-service'),
      import('../pipelines/pipeline-install-context'),
      import('../lib/resolve-worktree'),
      import('../pipelines/project-pipeline-discovery'),
      import('../pipelines/pipeline-package-service'),
    ]);
  return createDesktopCapabilityPackagePort({
    createArtifacts: createRepairArtifacts,
    readRawSkill: skills.readRawSkill,
    getStoredPipelineBySource: pipelines.getStoredPipelineBySource,
    assertStoredPipelineContext: source.assertStoredPipelineContext,
    assertPipelineShareSourceContext: source.assertPipelineShareSourceContext,
    readPipelineShareSource: source.readPipelineShareSource,
    resolveWorktreeCwd: resolver.resolveWorktreeCwd,
    discoverProjectPipelines: discovery.discoverProjectPipelines,
    analyzeSkillCapabilityPackage: analysis.analyzeSkillCapabilityPackage,
    analyzePackageRequest: analysis.analyzePackageRequest,
    cancelPackageAnalysis: analysis.cancelPackageAnalysis,
  });
}
export const desktopCapabilityPackagePort: AgentCapabilityPackagePort<CanopyInjectedToolRuntime> =
  {
    analyze: async (
      input: CapabilityPackageAnalyzeInput,
      call: AgentActionCall<CanopyInjectedToolRuntime>,
    ): Promise<AgentCapabilityPackageAnalysisResult> => {
      productionPort ??= loadProductionPort().catch((error) => {
        productionPort = undefined;
        throw error;
      });
      return (await productionPort).analyze(input, call);
    },
  };

async function createRepairArtifacts(
  input: { subject: CapabilityRepairSubject; pipeline?: PipelineData },
  call: AgentActionCall<CanopyInjectedToolRuntime>,
): Promise<AgentJson[]> {
  const runtime = call.host.worktreeActionRuntime;
  if (!runtime) throw new Error('The calling chat context is unavailable.');
  const { skillReceipt, pipelineReceipt } =
    await import('../canopy-tools/resource-actions');
  const { serializeAgentArtifactReceipt } =
    await import('@canopy/desktop-shared/lib/agent-artifacts');
  const subject = input.subject;
  const receipt =
    subject.kind === 'skill'
      ? skillReceipt({
          operation: 'capability_package.analyze',
          sourceId: subject.sourceId,
          installedName: subject.skillName,
          name: sanitizeCapabilityRepairText(subject.skillName),
          canUpdate: true,
        })
      : input.pipeline
        ? await pipelineReceipt(
            'capability_package.analyze',
            {
              ...input.pipeline,
              content: {
                ...input.pipeline.content,
                name: sanitizeCapabilityRepairText(input.pipeline.content.name),
                description: sanitizeCapabilityRepairText(
                  input.pipeline.content.description ?? '',
                ),
              },
            },
            subject.kind === 'project-pipeline'
              ? {
                  ...runtime,
                  cwd: (
                    await import('../lib/resolve-worktree')
                  ).resolveWorktreeCwd(
                    runtime.projectId,
                    runtime.worktreeId,
                    subject.repoId,
                  ),
                  repoId: subject.repoId,
                }
              : runtime,
          )
        : null;
  const serialized = serializeAgentArtifactReceipt(receipt);
  if (!serialized)
    throw new Error('Could not prepare the original item’s artifact receipt.');
  return [z.json().parse(serialized)];
}
