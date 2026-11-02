import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, chmod, open } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { z } from 'zod';
import type { CoreWorkspaceRepoRulesErrorCode } from '@canopy/protocol/canopy-core';
import type { RepoRulesStatus } from '@canopy/protocol/repo-rules';
import {
  REPO_RULES_POLICY_MAX_BYTES,
  type RepoRulesPolicyRead,
  type RepoRulesPolicyState,
  type RepoRulesStorePort,
} from '@canopy/core-runtime/node/workspace/repo-rules';
import { readBounded, validRelativePath } from './safety';

export {
  REPO_RULES_POLICY_MAX_BYTES,
  REVIEWED_HISTORY_LIMIT,
  policyStatus,
} from '@canopy/core-runtime/node/workspace/repo-rules';

const POLICY_TOO_LARGE =
  'Workspace rule policy is too large to save. Reduce the selection and scan again.';
const POLICY_SAVE_FAILED =
  'Unable to save workspace rule policy. Try again; this review remains available.';
const storeErrorCodes = new WeakMap<Error, CoreWorkspaceRepoRulesErrorCode>();
function storeError(
  message: string,
  code: CoreWorkspaceRepoRulesErrorCode,
): Error {
  const error = new Error(message);
  storeErrorCodes.set(error, code);
  return error;
}
/** The typed code of a policy save failure this store raised, if any. */
export function repoRulesStoreErrorCode(
  error: unknown,
): CoreWorkspaceRepoRulesErrorCode | undefined {
  return error instanceof Error ? storeErrorCodes.get(error) : undefined;
}
/** Count limits: array and string maximums, and the record count refinements. */
function isLimitIssue(issue: z.ZodError['issues'][number]): boolean {
  return (
    issue.code === 'too_big' ||
    (issue.code === 'custom' &&
      issue.path.length === 1 &&
      (issue.path[0] === 'reviewed' || issue.path[0] === 'nestedDirectories'))
  );
}
const relativePath = z.string().refine(validRelativePath);
// The persisted form of the core policy state.
const stateSchema: z.ZodType<RepoRulesPolicyState> = z.strictObject({
  version: z.literal(1),
  enabled: z.boolean(),
  revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  disabledRuleIds: z.array(z.string().max(4096)).max(2000),
  reviewed: z
    .record(
      z.string().max(4096),
      z.strictObject({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        reviewedAt: z.iso.datetime(),
      }),
    )
    .refine((v) => Object.keys(v).length <= 2000),
  nestedDirectories: z
    .record(
      z.string().max(128),
      z
        .array(relativePath.refine((p) => /(?:^|\/)\.cursor\/rules$/.test(p)))
        .max(200),
    )
    .refine(
      (v) =>
        Object.keys(v).length <= 32 && Object.values(v).flat().length <= 200,
    ),
  reviewedAt: z.iso.datetime().optional(),
  lastScanAt: z.iso.datetime().optional(),
});
export type RepoRulesState = RepoRulesPolicyState;
export type StateRead = RepoRulesPolicyRead;
function empty(diagnostic: RepoRulesStatus['diagnostic']): StateRead {
  return {
    version: 1,
    enabled: false,
    revision: 0,
    disabledRuleIds: [],
    reviewed: {},
    nestedDirectories: {},
    diagnostic,
  };
}
/** The single writer of `workspace_repo_rules`, behind the core store port. */
export class RepoRulesStateStore implements RepoRulesStorePort {
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly pathFor: (workspaceId: string) => string) {}
  async read(workspaceId: string): Promise<StateRead> {
    const file = this.pathFor(workspaceId);
    try {
      const value: unknown = JSON.parse(
        await readBounded(
          dirname(file),
          basename(file),
          REPO_RULES_POLICY_MAX_BYTES,
        ),
      );
      if (
        typeof value === 'object' &&
        value !== null &&
        'version' in value &&
        value.version !== 1
      )
        return empty('unsupported-version');
      const parsed = stateSchema.safeParse(value);
      return parsed.success ? parsed.data : empty('invalid');
    } catch (e) {
      if (
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        e.code === 'ENOENT'
      )
        return empty('missing');
      return empty(e instanceof SyntaxError ? 'invalid' : 'unavailable');
    }
  }
  /** One writer per workspace, including review verification and revision checks. */
  async update(
    workspaceId: string,
    operation: (current: StateRead) => Promise<RepoRulesState>,
  ): Promise<StateRead> {
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
    const pending = previous.then(async (): Promise<StateRead> => {
      const parsed = stateSchema.safeParse(
        await operation(await this.read(workspaceId)),
      );
      if (!parsed.success)
        throw parsed.error.issues.every(isLimitIssue)
          ? storeError(
              POLICY_TOO_LARGE,
              'core.workspace.repoRules.policyTooLarge',
            )
          : storeError(
              POLICY_SAVE_FAILED,
              'core.workspace.repoRules.saveFailed',
            );
      const next = parsed.data;
      const serialized = JSON.stringify(next);
      if (Buffer.byteLength(serialized) > REPO_RULES_POLICY_MAX_BYTES)
        throw storeError(
          POLICY_TOO_LARGE,
          'core.workspace.repoRules.policyTooLarge',
        );
      const file = this.pathFor(workspaceId);
      const temporary = `${file}.${randomUUID()}.tmp`;
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(serialized, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(temporary, 0o600);
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      return next;
    });
    const settled = pending.then(
      (): void => undefined,
      (): void => undefined,
    );
    this.queues.set(workspaceId, settled);
    try {
      return await pending;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        throw storeError(
          POLICY_SAVE_FAILED,
          'core.workspace.repoRules.saveFailed',
        );
      }
      throw error;
    } finally {
      if (this.queues.get(workspaceId) === settled)
        this.queues.delete(workspaceId);
    }
  }
}
