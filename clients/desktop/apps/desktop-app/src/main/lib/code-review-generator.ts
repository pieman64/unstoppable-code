import { runHelperThroughWorker } from '../helper-runs/helper-runs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  isDataModelDiffGenerationResult,
  isLogicDiffDiagram,
  isReviewAnnotationSet,
  type AgentModelConfig,
  type ChatModel,
  type DataModelDiffGenerationResult,
  type LogicDiffDiagram,
  type ReviewAnnotation,
  type ReviewAnnotationSet,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { runCodexStructuredHelperQuery } from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
  LOGIC_DIFF_DIAGRAM_JSON_SCHEMA,
} from '@canopy/desktop-shared/lib/plan-diagram-prompts';
import {
  REVIEW_ANNOTATIONS_JSON_SCHEMA,
  buildCodeReviewDiagramUserPrompt,
  buildReviewAnnotationsSystemPrompt,
  buildReviewDataModelDiffSystemPrompt,
  buildReviewLogicDiffSystemPrompt,
} from '@canopy/desktop-shared/lib/code-review-prompts';
import type { HelperTranscriptObserver } from '@canopy/desktop-shared/lib/helper-transcript';
import type { HelperUsage } from '../agents/utils';
import { resolveHelperInvocation } from '../ollama/helper-invocation';
import { readLocalMemoryEnabledPreference } from './preferences-store';
import { isPathInside } from './path-safety';
import type { ReviewRepoRef } from './code-review-diff';
import {
  codexStructuredHelperRunner,
  runDesktopClaudeStructuredHelperQuery,
} from '../integration/structured-helper-dispatch';
import { spawnClaudeCodeProcessOffMain } from '../agents/claude-process-host-runner';

export interface CodeReviewGeneratorBaseOptions {
  /**
   * True when the user explicitly armed or refreshed this review, false for the
   * debounced activity trigger. Gates whether an absent native login may spend
   * AI Credits (ECW-9091 review round 8) — code review is NOT scheduler-only:
   * `armCodeReview` and `requestManualCodeReviewRefresh` are both IPC handlers
   * that call `runNow` synchronously, and denying those would spawn natively
   * with no login and silently produce nothing.
   */
  userInitiated?: boolean;
  diffBundleText: string;
  repoPath: string;
  projectId: string;
  model: ChatModel;
  modelConfig?: AgentModelConfig;
  thinkingLevel: ThinkingLevel;
  transcriptObserver?: HelperTranscriptObserver;
}

/**
 * AI Credits routing options shared by every code review helper call
 * (ECW-9091 review round 7).
 *
 * Code review runs from two kinds of trigger, and they must be treated
 * differently. `code-review-scheduler.ts` debounces on activity and fires with
 * no user action at that moment — that must never route through AI Credits
 * merely because the user has no native login, or a credits-only user's daily
 * allowance can be consumed by background work. But `armCodeReview` and
 * `requestManualCodeReviewRefresh` are IPC handlers that run immediately, and
 * those are the user asking for the work, so they keep the interactive default.
 * `options.userInitiated` carries that distinction. An explicit routing mode, a
 * session override, and gateway-only models all still route regardless.
 *
 * `workspaceId` is equally load-bearing: the user-supplied-credential guard has
 * to resolve the same Canopy Environments assignment these helpers spawn with
 * (every call below already passes `workspaceId: options.projectId`), because a
 * workspace assignment REPLACES the global one rather than merging.
 */
function buildHelperRoutingOptions(options: CodeReviewGeneratorBaseOptions): {
  allowNoNativeAuthFallback: boolean;
  workspaceId: string;
} {
  return {
    allowNoNativeAuthFallback: options.userInitiated === true,
    workspaceId: options.projectId,
  };
}

async function seedTranscript(
  options: CodeReviewGeneratorBaseOptions,
  systemPrompt: string,
  userMessage: string,
  submittedText: string,
  provider: 'claude' | 'codex' | 'ollama',
): Promise<void> {
  await options.transcriptObserver?.seed({
    provider,
    originalText: userMessage,
    submittedText,
    systemPrompt,
  });
}

export type GenerateReviewAnnotationsOptions = CodeReviewGeneratorBaseOptions;

export interface GenerateReviewAnnotationsResult {
  value: ReviewAnnotationSet | null;
  usage: HelperUsage;
}

export async function generateReviewAnnotations(
  options: GenerateReviewAnnotationsOptions,
): Promise<GenerateReviewAnnotationsResult> {
  const systemPrompt = buildReviewAnnotationsSystemPrompt();
  const userMessage = buildCodeReviewDiagramUserPrompt(options.diffBundleText);
  const invocation = await resolveHelperInvocation(
    options.model,
    undefined,
    buildHelperRoutingOptions(options),
  );
  try {
    return await runHelperThroughWorker({
      kind: 'code_review_annotations',
      model: options.model,
      scope: { workspaceId: options.projectId },
      origin: options.userInitiated === true ? 'client' : 'system',
      launch: async () => {
        if (invocation.harness === 'codex') {
          const combinedPrompt = `${systemPrompt}\n\n${userMessage}`;
          await seedTranscript(
            options,
            systemPrompt,
            userMessage,
            combinedPrompt,
            invocation.providerType,
          );
          const result =
            await runCodexStructuredHelperQuery<ReviewAnnotationSet>({
              waitForQuotaRecovery: invocation.waitForQuotaRecovery,
              runner: codexStructuredHelperRunner,
              repoPath: options.repoPath,
              model: invocation.sdkModel ?? options.model,
              systemPrompt,
              userMessage,
              combinedPrompt,
              schema: REVIEW_ANNOTATIONS_JSON_SCHEMA,
              thinkingLevel: options.thinkingLevel,
              modelConfig: options.modelConfig,
              workspaceId: options.projectId,
              localMemoryEnabled: await readLocalMemoryEnabledPreference(),
              transcriptObserver: options.transcriptObserver,
              isResult: isReviewAnnotationSet,
              ...(invocation.codexConfig
                ? { codexConfigOverride: invocation.codexConfig }
                : {}),
            });
          return { value: result.value, usage: result.usage };
        }

        await seedTranscript(
          options,
          systemPrompt,
          userMessage,
          userMessage,
          invocation.providerType,
        );
        const result =
          await runDesktopClaudeStructuredHelperQuery<ReviewAnnotationSet>({
            spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
            repoPath: options.repoPath,
            model: invocation.sdkModel ?? options.model,
            provider:
              invocation.providerType === 'ollama' ? 'ollama' : 'claude',
            maxTurns: 16,
            systemPrompt,
            userMessage,
            schema: REVIEW_ANNOTATIONS_JSON_SCHEMA,
            thinkingLevel: options.thinkingLevel,
            workspaceId: options.projectId,
            localMemoryEnabled: await readLocalMemoryEnabledPreference(),
            transcriptObserver: options.transcriptObserver,
            isResult: isReviewAnnotationSet,
            claudeEnvOverride: invocation.envOverride,
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
          });
        return { value: result.value, usage: result.usage };
      },
      usageOf: (r) => r.usage,
    });
  } finally {
    invocation.dispose?.();
  }
}

export type GenerateReviewLogicDiffOptions = CodeReviewGeneratorBaseOptions;

export interface GenerateReviewLogicDiffResult {
  value: LogicDiffDiagram | null;
  usage: HelperUsage;
}

export async function generateReviewLogicDiff(
  options: GenerateReviewLogicDiffOptions,
): Promise<GenerateReviewLogicDiffResult> {
  const systemPrompt = buildReviewLogicDiffSystemPrompt();
  const userMessage = buildCodeReviewDiagramUserPrompt(options.diffBundleText);
  const invocation = await resolveHelperInvocation(
    options.model,
    undefined,
    buildHelperRoutingOptions(options),
  );
  try {
    return await runHelperThroughWorker({
      kind: 'code_review_diagram',
      model: options.model,
      scope: { workspaceId: options.projectId },
      origin: options.userInitiated === true ? 'client' : 'system',
      launch: async () => {
        if (invocation.harness === 'codex') {
          const combinedPrompt = `${systemPrompt}\n\n${userMessage}`;
          await seedTranscript(
            options,
            systemPrompt,
            userMessage,
            combinedPrompt,
            invocation.providerType,
          );
          const result = await runCodexStructuredHelperQuery<LogicDiffDiagram>({
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
            runner: codexStructuredHelperRunner,
            repoPath: options.repoPath,
            model: invocation.sdkModel ?? options.model,
            systemPrompt,
            userMessage,
            combinedPrompt,
            schema: LOGIC_DIFF_DIAGRAM_JSON_SCHEMA,
            thinkingLevel: options.thinkingLevel,
            modelConfig: options.modelConfig,
            workspaceId: options.projectId,
            localMemoryEnabled: await readLocalMemoryEnabledPreference(),
            transcriptObserver: options.transcriptObserver,
            isResult: isLogicDiffDiagram,
            ...(invocation.codexConfig
              ? { codexConfigOverride: invocation.codexConfig }
              : {}),
          });
          return { value: result.value, usage: result.usage };
        }

        await seedTranscript(
          options,
          systemPrompt,
          userMessage,
          userMessage,
          invocation.providerType,
        );
        const result =
          await runDesktopClaudeStructuredHelperQuery<LogicDiffDiagram>({
            spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
            repoPath: options.repoPath,
            model: invocation.sdkModel ?? options.model,
            provider:
              invocation.providerType === 'ollama' ? 'ollama' : 'claude',
            maxTurns: 50,
            systemPrompt,
            userMessage,
            schema: LOGIC_DIFF_DIAGRAM_JSON_SCHEMA,
            thinkingLevel: options.thinkingLevel,
            workspaceId: options.projectId,
            localMemoryEnabled: await readLocalMemoryEnabledPreference(),
            transcriptObserver: options.transcriptObserver,
            isResult: isLogicDiffDiagram,
            claudeEnvOverride: invocation.envOverride,
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
          });
        return { value: result.value, usage: result.usage };
      },
      usageOf: (r) => r.usage,
    });
  } finally {
    invocation.dispose?.();
  }
}

export type GenerateReviewDataModelDiffOptions = CodeReviewGeneratorBaseOptions;

export interface GenerateReviewDataModelDiffResult {
  value: DataModelDiffGenerationResult | null;
  usage: HelperUsage;
}

export async function generateReviewDataModelDiff(
  options: GenerateReviewDataModelDiffOptions,
): Promise<GenerateReviewDataModelDiffResult> {
  const systemPrompt = buildReviewDataModelDiffSystemPrompt();
  const userMessage = buildCodeReviewDiagramUserPrompt(options.diffBundleText);
  const invocation = await resolveHelperInvocation(
    options.model,
    undefined,
    buildHelperRoutingOptions(options),
  );
  try {
    return await runHelperThroughWorker({
      kind: 'code_review_diagram',
      model: options.model,
      scope: { workspaceId: options.projectId },
      origin: options.userInitiated === true ? 'client' : 'system',
      launch: async () => {
        if (invocation.harness === 'codex') {
          const combinedPrompt = `${systemPrompt}\n\n${userMessage}`;
          await seedTranscript(
            options,
            systemPrompt,
            userMessage,
            combinedPrompt,
            invocation.providerType,
          );
          const result =
            await runCodexStructuredHelperQuery<DataModelDiffGenerationResult>({
              waitForQuotaRecovery: invocation.waitForQuotaRecovery,
              runner: codexStructuredHelperRunner,
              repoPath: options.repoPath,
              model: invocation.sdkModel ?? options.model,
              systemPrompt,
              userMessage,
              combinedPrompt,
              schema: DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
              thinkingLevel: options.thinkingLevel,
              modelConfig: options.modelConfig,
              workspaceId: options.projectId,
              localMemoryEnabled: await readLocalMemoryEnabledPreference(),
              transcriptObserver: options.transcriptObserver,
              isResult: isDataModelDiffGenerationResult,
              ...(invocation.codexConfig
                ? { codexConfigOverride: invocation.codexConfig }
                : {}),
            });
          return { value: result.value, usage: result.usage };
        }

        await seedTranscript(
          options,
          systemPrompt,
          userMessage,
          userMessage,
          invocation.providerType,
        );
        const result =
          await runDesktopClaudeStructuredHelperQuery<DataModelDiffGenerationResult>(
            {
              spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
              repoPath: options.repoPath,
              model: invocation.sdkModel ?? options.model,
              provider:
                invocation.providerType === 'ollama' ? 'ollama' : 'claude',
              maxTurns: 50,
              systemPrompt,
              userMessage,
              schema: DATA_MODEL_DIFF_GENERATION_JSON_SCHEMA,
              thinkingLevel: options.thinkingLevel,
              workspaceId: options.projectId,
              localMemoryEnabled: await readLocalMemoryEnabledPreference(),
              transcriptObserver: options.transcriptObserver,
              isResult: isDataModelDiffGenerationResult,
              claudeEnvOverride: invocation.envOverride,
              waitForQuotaRecovery: invocation.waitForQuotaRecovery,
            },
          );
        return { value: result.value, usage: result.usage };
      },
      usageOf: (r) => r.usage,
    });
  } finally {
    invocation.dispose?.();
  }
}

/**
 * Drop or clamp model-returned annotations that do not resolve against the
 * actual working tree: unknown repoId, unreadable file, or inverted ranges.
 * 'new'-side ranges are clamped to the file's current line count; 'old'-side
 * ranges are kept as returned (the old content is not on disk).
 */
export async function sanitizeReviewAnnotations(
  set: ReviewAnnotationSet,
  repos: ReviewRepoRef[],
): Promise<ReviewAnnotationSet> {
  const repoById = new Map(repos.map((repo) => [repo.repoId, repo]));
  const lineCountCache = new Map<string, number | null>();
  const repoRealPathCache = new Map<string, Promise<string>>();
  const repoRealPath = (repo: ReviewRepoRef): Promise<string> => {
    let cached = repoRealPathCache.get(repo.repoId);
    if (!cached) {
      cached = realpath(repo.repoPath);
      repoRealPathCache.set(repo.repoId, cached);
    }
    return cached;
  };
  const fileLineCount = async (
    repo: ReviewRepoRef,
    filePath: string,
  ): Promise<number | null> => {
    const key = `${repo.repoId}:${filePath}`;
    const cached = lineCountCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let count: number | null = null;
    try {
      const absolutePath = join(repo.repoPath, filePath);
      const [repoRoot, fileStats, fileRealPath] = await Promise.all([
        repoRealPath(repo),
        lstat(absolutePath),
        realpath(absolutePath),
      ]);
      if (
        fileStats.isSymbolicLink() ||
        !fileStats.isFile() ||
        !isPathInside(repoRoot, fileRealPath)
      ) {
        lineCountCache.set(key, null);
        return null;
      }
      const content = await readFile(fileRealPath, 'utf8');
      const lines = content.split('\n');
      // A trailing newline produces a final empty split element that is not
      // an actual line in the file; drop it so line numbers match what the
      // diff hunks (and the model) refer to.
      count =
        lines.length > 0 && lines[lines.length - 1] === ''
          ? lines.length - 1
          : lines.length;
    } catch {
      count = null;
    }
    lineCountCache.set(key, count);
    return count;
  };
  const kept: ReviewAnnotation[] = [];
  for (const annotation of set.annotations) {
    const repo = repoById.get(annotation.repoId);
    if (!repo) {
      continue;
    }
    // Drop annotations whose filePath is absolute or escapes the repo root —
    // a model must never point a review annotation outside the checkout.
    if (
      isAbsolute(annotation.filePath) ||
      !isPathInside(repo.repoPath, join(repo.repoPath, annotation.filePath))
    ) {
      continue;
    }
    let lineStart = Math.max(1, Math.floor(annotation.lineStart));
    let lineEnd = Math.max(lineStart, Math.floor(annotation.lineEnd));
    if (annotation.side === 'new') {
      const count = await fileLineCount(repo, annotation.filePath);
      if (count === null) {
        continue;
      }
      lineStart = Math.min(lineStart, count);
      lineEnd = Math.min(lineEnd, count);
    }
    kept.push({ ...annotation, lineStart, lineEnd });
  }
  return { schemaVersion: 1, annotations: kept };
}
