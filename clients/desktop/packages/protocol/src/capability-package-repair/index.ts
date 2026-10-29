import { z } from 'zod';
import { isSafeCapabilityRelativePath } from '../capability-files';
import type { PipelinePackageAnalysisSummary } from '../pipelines';

// Locators must remain exact. Reject sensitive identities rather than silently
// redacting them into a different item or analysis context.
const safeLocator = (value: string): boolean =>
  sanitizeCapabilityRepairText(value) === value;
const identity = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(safeLocator, 'Identity contains sensitive host data.');
export const capabilityRepairRelativePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(isSafeCapabilityRelativePath, 'Expected a repository-relative path.')
  .refine(safeLocator, 'Path contains sensitive data.');
export const capabilityRepairSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('skill'),
    sourceId: z.literal('custom:app'),
    skillName: identity.refine(
      (value) => !/[\\/]/.test(value) && value !== '.' && value !== '..',
    ),
  }),
  z.strictObject({ kind: z.literal('user-pipeline'), pipelineId: identity }),
  z.strictObject({
    kind: z.literal('project-pipeline'),
    pipelineId: identity,
    worktreeId: identity,
    relativePath: capabilityRepairRelativePathSchema,
    repoId: identity.optional(),
  }),
]);
export const capabilityRepairDismissalSchema = z.strictObject({
  provider: z.enum(['claude', 'codex']),
  token: z
    .string()
    .min(1)
    .max(512)
    .refine(safeLocator, 'Invocation contains sensitive data.'),
});
export const capabilityRepairAnalysisContextSchema = z.strictObject({
  dismissedInvocations: z
    .array(capabilityRepairDismissalSchema)
    .max(100)
    .optional(),
  /** A locator only. The host must match this against the calling chat. */
  worktree: z
    .strictObject({ worktreeId: identity, repoId: identity.optional() })
    .optional(),
});
export type CapabilityRepairSubject = z.output<
  typeof capabilityRepairSubjectSchema
>;
export type CapabilityRepairAnalysisContext = z.output<
  typeof capabilityRepairAnalysisContextSchema
>;
export interface CapabilityPackageAnalyzeInput {
  subject: CapabilityRepairSubject;
  context?: CapabilityRepairAnalysisContext;
}

export const CAPABILITY_REPAIR_LIMITS = {
  rows: 25,
  occurrences: 10,
  field: 512,
  message: 2048,
  text: 20_000,
  result: 48_000,
} as const;
const text = z.string().max(CAPABILITY_REPAIR_LIMITS.message);
const occurrence = z.strictObject({ jobId: text, stepId: text });
export const capabilityPackageAnalysisResultSchema = z
  .strictObject({
    state: z.enum(['ready', 'blocked', 'failed']),
    blockers: z
      .array(
        z.strictObject({
          code: text,
          subject: text.optional(),
          message: text,
          relativePath: text.optional(),
          occurrences: z.array(occurrence).max(10),
          omittedOccurrences: z.number().int().nonnegative(),
          dismissal: capabilityRepairDismissalSchema.optional(),
        }),
      )
      .max(25),
    resolvedResources: z
      .array(
        z.strictObject({
          id: text,
          kind: text,
          displayName: text,
          sourceLabel: text,
        }),
      )
      .max(25),
    environmentRequirements: z
      .array(
        z.strictObject({
          id: text,
          kind: text,
          displayName: text,
          required: z.boolean(),
          setupHint: text,
          affectedSteps: z.array(occurrence).max(10),
          omittedOccurrences: z.number().int().nonnegative(),
        }),
      )
      .max(25),
    dismissedInvocations: z.array(capabilityRepairDismissalSchema).max(25),
    unpackageableSelectionLabels: z.array(text).max(25),
    omitted: z.strictObject({
      blockers: z.number().int().nonnegative(),
      resolvedResources: z.number().int().nonnegative(),
      environmentRequirements: z.number().int().nonnegative(),
      dismissedInvocations: z.number().int().nonnegative(),
      unpackageableSelectionLabels: z.number().int().nonnegative(),
    }),
    truncated: z.boolean(),
    error: text.optional(),
  })
  .refine(
    (value) => value.state !== 'failed' || Boolean(value.error?.trim()),
    'A failed analysis requires a useful error.',
  )
  .refine(
    (value) => JSON.stringify(value).length <= CAPABILITY_REPAIR_LIMITS.result,
    'Analysis exceeds the total size limit.',
  );
export type CapabilityPackageAnalysisResult = z.output<
  typeof capabilityPackageAnalysisResultSchema
>;

/** Diagnostics are untrusted data. Never return dependency content or host paths. */
export function sanitizeCapabilityRepairText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g,
      '[redacted secret]',
    )
    .replace(
      /\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9_]{16,}|github_pat_[a-zA-Z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/g,
      '[redacted secret]',
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[redacted secret]',
    )
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted secret]')
    .replace(
      /\b(?:Cookie|Set-Cookie|X-Api-Key|X-Auth-Token)\s*:[^\r\n]+/gi,
      '[redacted secret]',
    )
    .replace(/\b(Bearer|Basic)\s+[a-zA-Z0-9+/_.=-]+/gi, '$1 [redacted secret]')
    .replace(
      /\b((?:[A-Z0-9_]*(?:secret|token|password|credential|api[_ -]?key)[A-Z0-9_]*)["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      '$1[redacted secret]',
    )
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi,
      '[redacted credentials]@',
    )
    .replace(
      /(["'`])(?:[a-z]:[\\/][^"'`\r\n]*|\\\\[^"'`\r\n]*|\/[^"'`\r\n]*\/[^"'`\r\n]*)\1/gi,
      '$1[redacted host path]$1',
    )
    .replace(
      /(?:\b[a-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s<>"'`),;\]}]+/gi,
      '[redacted host path]',
    )
    .replace(
      /(^|[\s("'`=:<>\[{|])\/(?:[^\s<>"'`),;\]}]+\/[^\s<>"'`),;\]}]*|(?:Users|home|tmp|var|private|etc|opt|root)(?=$|[\s),;]))/gm,
      '$1[redacted host path]',
    );
}

/** One bounded projection for action results and the later repair prompt. */
export function projectCapabilityPackageAnalysis(
  summary: PipelinePackageAnalysisSummary,
): CapabilityPackageAnalysisResult {
  let remaining = CAPABILITY_REPAIR_LIMITS.text;
  let truncated = false;
  const safe = (
    value: string,
    max: number = CAPABILITY_REPAIR_LIMITS.field,
  ): string => {
    const sanitized = sanitizeCapabilityRepairText(value);
    const limit = Math.min(max, remaining);
    const output =
      sanitized.length <= limit
        ? sanitized
        : `${sanitized.slice(0, Math.max(0, limit - 12))}[truncated]`.slice(
            0,
            limit,
          );
    truncated ||= sanitized.length > limit;
    remaining -= output.length;
    return output;
  };
  const rows = <T>(values: readonly T[]): readonly T[] => {
    truncated ||= values.length > CAPABILITY_REPAIR_LIMITS.rows;
    return values.slice(0, CAPABILITY_REPAIR_LIMITS.rows);
  };
  const locations = (
    values: Array<{ jobId: string; stepId: string }>,
  ): Array<{ jobId: string; stepId: string }> => {
    truncated ||= values.length > CAPABILITY_REPAIR_LIMITS.occurrences;
    return values
      .slice(0, CAPABILITY_REPAIR_LIMITS.occurrences)
      .map((value) => ({
        jobId: safe(value.jobId),
        stepId: safe(value.stepId),
      }));
  };
  const resources = summary.manifest?.resources ?? [];
  const requirements = summary.manifest?.environmentRequirements ?? [];
  const dismissals = summary.dismissedInvocations ?? [];
  const labels = summary.unpackageableSelectionLabels ?? [];
  const result: CapabilityPackageAnalysisResult = {
    // Match the dialog's blocking semantics even for an inconsistent summary.
    state:
      summary.state === 'ready' && summary.blockers.length === 0
        ? 'ready'
        : 'blocked',
    blockers: rows(summary.blockers).map((blocker) => ({
      code: safe(blocker.code),
      message: safe(blocker.message, CAPABILITY_REPAIR_LIMITS.message),
      ...(blocker.subject !== undefined
        ? { subject: safe(blocker.subject) }
        : {}),
      ...(blocker.relativePath !== undefined
        ? { relativePath: safe(blocker.relativePath) }
        : {}),
      occurrences: locations(blocker.occurrences),
      omittedOccurrences: Math.max(
        0,
        blocker.occurrences.length - CAPABILITY_REPAIR_LIMITS.occurrences,
      ),
      ...(blocker.dismissal && remaining > 0
        ? {
            dismissal: {
              provider: blocker.dismissal.provider,
              token: safe(blocker.dismissal.token),
            },
          }
        : {}),
    })),
    resolvedResources: rows(resources).map((resource) => ({
      id: safe(resource.id),
      kind: safe(resource.kind),
      displayName: safe(resource.displayName),
      sourceLabel: safe(resource.sourceLabel),
    })),
    environmentRequirements: rows(requirements).map((requirement) => ({
      id: safe(requirement.id),
      kind: safe(requirement.kind),
      displayName: safe(requirement.displayName),
      required: requirement.required,
      setupHint: safe(requirement.setupHint),
      affectedSteps: locations(requirement.affectedSteps),
      omittedOccurrences: Math.max(
        0,
        requirement.affectedSteps.length - CAPABILITY_REPAIR_LIMITS.occurrences,
      ),
    })),
    dismissedInvocations: rows(dismissals)
      .map((dismissal) => ({
        provider: dismissal.provider,
        token: safe(dismissal.token),
      }))
      .filter((dismissal) => dismissal.token.length > 0),
    unpackageableSelectionLabels: rows(labels).map((label) => safe(label)),
    omitted: {
      blockers: Math.max(0, summary.blockers.length - 25),
      resolvedResources: Math.max(0, resources.length - 25),
      environmentRequirements: Math.max(0, requirements.length - 25),
      dismissedInvocations: Math.max(0, dismissals.length - 25),
      unpackageableSelectionLabels: Math.max(0, labels.length - 25),
    },
    truncated,
  };
  result.omitted.dismissedInvocations =
    dismissals.length - result.dismissedInvocations.length;
  // Account for JSON escaping and structural overhead as well as text length.
  while (JSON.stringify(result).length > CAPABILITY_REPAIR_LIMITS.result) {
    const key = (
      [
        'unpackageableSelectionLabels',
        'dismissedInvocations',
        'environmentRequirements',
        'resolvedResources',
        'blockers',
      ] as const
    ).find((candidate) => result[candidate].length > 0);
    if (!key) break;
    result[key].pop();
    result.omitted[key] += 1;
    result.truncated = true;
  }
  return capabilityPackageAnalysisResultSchema.parse(result);
}

export function failedCapabilityPackageAnalysis(
  error: unknown,
): CapabilityPackageAnalysisResult {
  const message =
    sanitizeCapabilityRepairText(
      error instanceof Error
        ? error.message
        : 'Could not check share dependencies.',
    ) || 'Could not check share dependencies.';
  return {
    ...projectCapabilityPackageAnalysis({
      analysisId: '',
      pipelineContentHash: '',
      state: 'blocked',
      blockers: [],
      expiresAt: '',
    }),
    state: 'failed',
    error: message.slice(0, CAPABILITY_REPAIR_LIMITS.message),
    truncated: message.length > CAPABILITY_REPAIR_LIMITS.message,
  };
}

/** Click-time context. Audience selection is descriptive, never an authorization grant. */
export interface CapabilityPackageRepairRequest extends CapabilityPackageAnalyzeInput {
  displayName: string;
  audience: {
    /** `null` until the author picks an audience; never a guessed default. */
    scope: 'private' | 'team' | 'organization' | 'public' | null;
    selected: { id: string; name: string } | null;
  };
  analysis: CapabilityPackageAnalysisResult;
}

export const capabilityPackageRepairRequestSchema = z
  .strictObject({
    subject: capabilityRepairSubjectSchema,
    context: capabilityRepairAnalysisContextSchema.optional(),
    displayName: z.string().min(1).max(200),
    audience: z.strictObject({
      scope: z.enum(['private', 'team', 'organization', 'public']).nullable(),
      selected: z
        .strictObject({ id: identity, name: z.string().min(1).max(200) })
        .nullable(),
    }),
    analysis: capabilityPackageAnalysisResultSchema,
  })
  .refine(
    (value) => JSON.stringify(value).length <= 56_000,
    'Repair context exceeds the total size limit.',
  );

/** Portable locator for the frontend's pipeline Share dialog; never grants access. */
export const pipelineRepairShareTargetSchema = z.discriminatedUnion('source', [
  z.strictObject({
    kind: z.literal('pipeline'),
    source: z.literal('stored'),
    pipelineId: identity,
  }),
  z.strictObject({
    kind: z.literal('pipeline'),
    source: z.literal('project'),
    pipelineId: identity,
    projectId: identity,
    worktreeId: identity,
    relativePath: capabilityRepairRelativePathSchema,
    repoId: identity.optional(),
  }),
]);
export type PipelineRepairShareTarget = z.output<
  typeof pipelineRepairShareTargetSchema
>;
