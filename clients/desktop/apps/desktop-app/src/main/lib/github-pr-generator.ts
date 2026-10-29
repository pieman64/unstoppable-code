import {
  type AgentModelConfig,
  type ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  generatePrContentWithUsage,
  type GeneratePrContentOptions,
  type PrContent,
} from '@canopy/desktop-shared/lib/github-pr-generator';
import {
  formatBranchAsTitle,
  getStructuredHelperQueryErrorUsage,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  resolveHelperInvocation,
  resolveHelperWorkOwner,
} from '../ollama/helper-invocation';
import { isModelBlockedByStoredPolicy } from './model-policy-state';
import {
  buildHelperPluginRunOptions,
  finalizeObservedHelperTask,
  markObservedHelperTaskAiCreditsRouted,
  startObservedHelperTask,
  type HelperAuditContext,
} from './helper-observed-task';
import { createHelperTranscriptObserver } from './helper-transcript-observer';
import { runWithOptionalHelperPlugins } from './helper-plugin-resolution';
import { readLocalMemoryEnabledPreference } from './preferences-store';
import {
  codexStructuredHelperRunner,
  createStructuredHelperRunner,
  structuredHelperReadOnlyPermission,
} from '../integration/structured-helper-dispatch';

export type {
  GeneratePrContentOptions,
  PrContent,
} from '@canopy/desktop-shared/lib/github-pr-generator';

export type GeneratePrContentAuditContext = HelperAuditContext;

/**
 * PR content generation ships the branch diff and commit log to an explicitly
 * configured helper model, so an organization model policy applies here exactly
 * as it does to an interactive chat turn. As a non-interactive helper it refuses
 * rather than substituting a different model, and returns the same branch-name /
 * commit-log fallback the shared generator already uses when the model produces
 * nothing — the PR flow keeps working with non-AI content.
 */
const PR_GENERATION_MODEL_POLICY_REFUSAL =
  'PR content generation was skipped: this model is blocked by your organization policy.';

export interface GenerateObservedPrContentOptions extends Omit<
  GeneratePrContentOptions,
  'localMemoryEnabled'
> {
  auditContext?: GeneratePrContentAuditContext;
  pluginSelections?: ChatTabPluginSelections;
  modelConfig?: AgentModelConfig;
}

export async function generatePrContent(
  options: GenerateObservedPrContentOptions,
): Promise<PrContent> {
  const taskKey = `helper:pr-generation:${options.repoPath}:${Date.now()}`;
  const auditContext = options.auditContext;
  startObservedHelperTask({
    taskKey,
    eventType: 'pr_generation',
    label: 'PR Content Generation',
    model: options.model,
    modelConfig: options.modelConfig,
    auditContext,
  });

  // Resolved once and used for BOTH the routing guard and the spawn below, so
  // the user-supplied-credential check reads the same Canopy Environments
  // assignment the helper actually runs with. A workspace assignment replaces
  // the global one, so a mismatch here can miss a per-workspace provider key
  // and bill AI Credits around it (ECW-9091).
  const effectiveWorkspaceId = options.workspaceId ?? auditContext?.projectId;

  // Gated before any provider resolution so no diff/commit content leaves the
  // machine.
  const workOwner = await resolveHelperWorkOwner({
    ...(effectiveWorkspaceId ? { workspaceId: effectiveWorkspaceId } : {}),
  });
  if (await isModelBlockedByStoredPolicy(options.model, workOwner)) {
    finalizeObservedHelperTask(
      taskKey,
      'failure',
      PR_GENERATION_MODEL_POLICY_REFUSAL,
    );
    return {
      title: formatBranchAsTitle(options.branchName),
      body: options.commitLog ? `## Changes\n\n${options.commitLog}` : '',
    };
  }

  let disposeInvocation: (() => void) | undefined;
  try {
    const invocation = await resolveHelperInvocation(options.model, undefined, {
      signal: options.abortController?.signal,
      ...(effectiveWorkspaceId !== undefined
        ? { workspaceId: effectiveWorkspaceId }
        : {}),
    });
    disposeInvocation = invocation.dispose;
    markObservedHelperTaskAiCreditsRouted(
      taskKey,
      invocation.aiCreditsRouted,
      invocation.accountProxyRouted === true,
    );
    // Local memory is opt-in; only an enabled preference suppresses
    // harness-native memory on the helper launch (CAN-1969).
    const localMemoryEnabled = await readLocalMemoryEnabledPreference();
    const result = await runWithOptionalHelperPlugins(
      buildHelperPluginRunOptions({
        helperName: 'pr-generation',
        model: options.model,
        pluginSelections: options.pluginSelections,
        auditContext,
      }),
      (pluginRuntime) =>
        generatePrContentWithUsage(
          {
            ...options,
            localMemoryEnabled,
            model: invocation.sdkModel ?? options.model,
            workspaceId: effectiveWorkspaceId,
            claudeEnvOverride: {
              ...options.claudeEnvOverride,
              ...invocation.envOverride,
            },
            ...(invocation.codexConfig
              ? { codexConfigOverride: invocation.codexConfig }
              : {}),
            executionHarness: invocation.harness,
            waitForQuotaRecovery: invocation.waitForQuotaRecovery,
            transcriptObserver: createHelperTranscriptObserver(taskKey),
            pluginRuntime,
            codexRunner: codexStructuredHelperRunner,
          },
          createStructuredHelperRunner({
            kind: 'pr_generation',
            label: 'PR Content Generation',
            provider:
              invocation.providerType === 'ollama' ? 'ollama' : 'claude',
            projectId: effectiveWorkspaceId,
            worktreeId: auditContext?.worktreeId,
            linkTarget: auditContext
              ? {
                  page: 'main',
                  kind: 'worktree-chat',
                  projectId: auditContext.projectId,
                  worktreeId: auditContext.worktreeId,
                  planId: auditContext.planId,
                }
              : undefined,
            permission: structuredHelperReadOnlyPermission(),
            settingSources: ['user', 'project', 'local'],
            executionHarness: invocation.harness,
          }),
        ),
    );
    if (result.source === 'model') {
      finalizeObservedHelperTask(taskKey, 'success', undefined, result.usage);
    } else {
      finalizeObservedHelperTask(taskKey, 'failure');
    }
    return result.content;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    finalizeObservedHelperTask(
      taskKey,
      'failure',
      detail,
      getStructuredHelperQueryErrorUsage(error),
    );
    throw error;
  } finally {
    disposeInvocation?.();
  }
}
