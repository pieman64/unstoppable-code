import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../common';
import { defineCanopyQuery, defineCanopyQueryRegistry } from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';
import { WORKER_GIT_GRANTS } from './git';

/**
 * How the host resolved the Git it reports. `cache`, `auto-detected`,
 * `browse` and `winget-install` are the saved or discovered macOS and Windows
 * sources; `user-selected`, `login-path` and `system` are Linux x64's;
 * `not-found` means no Git is known.
 */
export const WORKER_GIT_EXECUTABLE_SOURCES = [
  'cache',
  'auto-detected',
  'browse',
  'user-selected',
  'login-path',
  'system',
  'winget-install',
  'not-found',
] as const;

export type WorkerGitExecutableSource =
  (typeof WORKER_GIT_EXECUTABLE_SOURCES)[number];

/**
 * Why Git is not ready: none was found, the explicit choice (a saved
 * selection or an environment override) cannot be used, or every Git found
 * failed validation.
 */
export const WORKER_GIT_EXECUTABLE_ISSUES = [
  'not-found',
  'selected-unusable',
  'candidate-unusable',
] as const;

export type WorkerGitExecutableIssue =
  (typeof WORKER_GIT_EXECUTABLE_ISSUES)[number];

export const WORKER_GIT_EXECUTABLE_ERROR_CODES = [
  'worker.git.executable.detectionFailed',
] as const;

/** Git selection is per machine: a scope selects only the authority and target. */
export const WorkerGitExecutableScopeSchema = CanopyWorkspaceScopeSchema.pick({
  authorityId: true,
  targetId: true,
});

export const WorkerGitExecutableGetParamsSchema = z.strictObject({
  scope: WorkerGitExecutableScopeSchema,
  /** Probe again instead of sharing a detection already running. */
  recheck: z.boolean(),
});

export type WorkerGitExecutableGetParams = z.output<
  typeof WorkerGitExecutableGetParamsSchema
>;

// Codes and facts only: the executable path and status messages stay on the
// host, which keeps them for its own compatibility projection.
export const WorkerGitExecutableGetResultSchema = z.strictObject({
  /** The host's Node.js platform name, for example `darwin`. */
  platform: z.string().min(1).max(64),
  /** Whether the host requires a validated Git on this platform. */
  required: z.boolean(),
  ready: z.boolean(),
  /** The `git version …` text the selected Git printed, when one was validated. */
  version: z.string().nullable(),
  source: z.enum(WORKER_GIT_EXECUTABLE_SOURCES),
  /** Windows: `winget` can install Git. */
  wingetAvailable: z.boolean(),
  checkedAt: z.iso.datetime({ offset: true }),
  /** Set only when `ready` is false. */
  issue: z.enum(WORKER_GIT_EXECUTABLE_ISSUES).nullable(),
});

export type WorkerGitExecutableGetResult = z.output<
  typeof WorkerGitExecutableGetResultSchema
>;

export const WorkerGitExecutableGetErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(WORKER_GIT_EXECUTABLE_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('worker', {
    'worker.git.executable.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'git',
      version: 1,
      placement: 'target-selectable',
      params: WorkerGitExecutableGetParamsSchema,
      result: WorkerGitExecutableGetResultSchema,
      error: WorkerGitExecutableGetErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_GIT_GRANTS.read],
    }),
  });
