// ---------------------------------------------------------------------------
// Repository-backed cloud projects: the browser-safe vocabulary the shared
// GitHub UI reads (REG-3021).
//
// Moved verbatim from `apps/web/src/lib/cloud/cloud-repository-contracts.ts`,
// which re-exports these and keeps the create request, its parser and the
// repository DTO guards. Holds the repository failure codes, the provisioning
// states, the repository visibilities and the allowlisted error details.
// Browser-safe: it imports only the browser-safe GitHub error codes.
// ---------------------------------------------------------------------------

import {
  isGitHubCloudErrorCode,
  type GitHubCloudErrorCode,
} from './github-cloud-errors';

export const REPOSITORY_PROVISIONING_STATES = [
  'PENDING',
  'READY',
  'FAILED',
] as const;
export type RepositoryProvisioningState =
  (typeof REPOSITORY_PROVISIONING_STATES)[number];

export const GITHUB_REPOSITORY_VISIBILITIES = [
  'public',
  'private',
  'internal',
] as const;
export type GitHubRepositoryVisibility =
  (typeof GITHUB_REPOSITORY_VISIBILITIES)[number];

/**
 * Every typed repository failure. Status, copy and retryability live in
 * `cloud-repository-errors.ts`; GitHub connection failures keep their own
 * `GitHubCloudErrorCode`s instead of aliases here.
 */
export const CLOUD_REPOSITORY_ERROR_CODES = [
  'cloud-repository-disabled',
  'cloud-repository-url-invalid',
  'cloud-repository-name-invalid',
  'cloud-repository-request-invalid',
  'cloud-repository-not-found',
  'cloud-repository-forbidden',
  'cloud-repository-read-only',
  'cloud-repository-archived',
  'cloud-repository-empty',
  'cloud-repository-owner-mismatch',
  'cloud-repository-not-installed',
  'cloud-repository-name-taken',
  'cloud-repository-idempotency-conflict',
  'cloud-repository-template-conflict',
  'cloud-repository-identity-changed',
  'cloud-repository-creation-uncertain',
  'cloud-repository-manifest-invalid',
  'cloud-repository-manifest-unsupported',
  'cloud-repository-multi-repo-unsupported',
  'cloud-repository-provisioning-in-progress',
  'cloud-repository-provisioning-failed',
  'cloud-repository-not-ready',
  'cloud-repository-execution-unavailable',
  'cloud-repository-org-github-not-connected',
  'cloud-repository-outside-organization',
  'cloud-repository-org-unavailable',
  'cloud-repository-member-project-limit',
  'cloud-repository-org-copy-exists',
] as const;
export type CloudRepositoryErrorCode =
  (typeof CLOUD_REPOSITORY_ERROR_CODES)[number];

/** Any code a repository route or a stored provisioning failure reports. */
export type CloudRepositoryFailureCode =
  | CloudRepositoryErrorCode
  | GitHubCloudErrorCode;

function isOneOf<T extends string>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((candidate) => candidate === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isCloudRepositoryErrorCode(
  value: unknown,
): value is CloudRepositoryErrorCode {
  return isOneOf(CLOUD_REPOSITORY_ERROR_CODES, value);
}

export function isCloudRepositoryFailureCode(
  value: unknown,
): value is CloudRepositoryFailureCode {
  return isCloudRepositoryErrorCode(value) || isGitHubCloudErrorCode(value);
}

// ---------------------------------------------------------------------------
// Error details
// ---------------------------------------------------------------------------

/**
 * The only details an error may carry: owner-visible identifiers and digests.
 * `requestId` is the create's idempotency key; `workspaceId` the project's
 * external id once a row exists, so the client can surface and recover it.
 */
export interface CloudRepositoryErrorDetails {
  requestId?: string;
  workspaceId?: string;
  manifestCommitSha?: string;
  manifestHash?: string;
}

/** The web `isCanonicalUuid` (`apps/web/src/lib/uuid.ts`): RFC 4122, lower case. */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isCanonicalUuidValue(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID.test(value);
}

function isCommitSha(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_SHA.test(value);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * Allowlists untrusted details: keeps each known field only in its exact
 * format and drops everything else. Null when nothing survives.
 */
export function readCloudRepositoryErrorDetails(
  value: unknown,
): CloudRepositoryErrorDetails | null {
  if (!isRecord(value)) return null;
  const { requestId, workspaceId, manifestCommitSha, manifestHash } = value;
  const details: CloudRepositoryErrorDetails = {
    ...(isCanonicalUuidValue(requestId) ? { requestId } : {}),
    ...(isCanonicalUuidValue(workspaceId) ? { workspaceId } : {}),
    ...(isCommitSha(manifestCommitSha) ? { manifestCommitSha } : {}),
    ...(isSha256Hex(manifestHash) ? { manifestHash } : {}),
  };
  return Object.keys(details).length > 0 ? details : null;
}
