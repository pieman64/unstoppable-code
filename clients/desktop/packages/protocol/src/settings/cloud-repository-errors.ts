// ---------------------------------------------------------------------------
// Repository-backed cloud projects: typed errors (REG-3021).
//
// Moved verbatim from `apps/web/src/lib/cloud/cloud-repository-errors.ts`,
// which re-exports it.
//
// Browser-safe: no server imports. Services throw `CloudRepositoryError` for
// expected repository outcomes and the existing `GitHubCloudConnectionError`
// for connection outcomes (never an alias of one). Routes serialize either as
// the cloud envelope `{ error: { code, message, details?, retryable? } }`
// through `toCloudRepositoryErrorBody`; the client reads it back with
// `readCloudRepositoryErrorBody`, which trusts only an allowlisted code and
// allowlisted details. Messages are fixed copy: never a provider message,
// token, credential-bearing URL or manifest content.
//
// `retryable` is attached only for known transient or repairable states:
// a busy setup, a failed setup Retry setup can resume, and GitHub's rate
// limit, outage and pending adoption. Everything else needs a different
// request or a fix outside this flow.
// ---------------------------------------------------------------------------

import { MEMBER_ORG_PROJECT_LIMIT } from '../org-projects';
import {
  GITHUB_CLOUD_ERROR_COPY,
  GITHUB_CLOUD_ERROR_STATUS,
  type GitHubCloudConnectionError,
  type GitHubCloudErrorCode,
  type GitHubCloudErrorStatus,
} from './github-cloud-errors';
import {
  isCloudRepositoryErrorCode,
  isCloudRepositoryFailureCode,
  readCloudRepositoryErrorDetails,
  type CloudRepositoryErrorCode,
  type CloudRepositoryErrorDetails,
  type CloudRepositoryFailureCode,
  type RepositoryProvisioningState,
} from './cloud-repository-contracts';

export type CloudRepositoryErrorStatus =
  | 400
  | 403
  | 404
  | 409
  | 422
  | 502
  | 503;

export const CLOUD_REPOSITORY_ERROR_STATUS: Readonly<
  Record<CloudRepositoryErrorCode, CloudRepositoryErrorStatus>
> = {
  'cloud-repository-disabled': 403,
  'cloud-repository-url-invalid': 400,
  'cloud-repository-name-invalid': 400,
  'cloud-repository-request-invalid': 400,
  'cloud-repository-not-found': 404,
  'cloud-repository-forbidden': 403,
  'cloud-repository-read-only': 403,
  'cloud-repository-archived': 409,
  'cloud-repository-empty': 409,
  'cloud-repository-owner-mismatch': 409,
  'cloud-repository-not-installed': 409,
  'cloud-repository-name-taken': 409,
  'cloud-repository-idempotency-conflict': 409,
  'cloud-repository-template-conflict': 409,
  'cloud-repository-identity-changed': 409,
  'cloud-repository-creation-uncertain': 409,
  'cloud-repository-manifest-invalid': 422,
  'cloud-repository-manifest-unsupported': 422,
  'cloud-repository-multi-repo-unsupported': 422,
  'cloud-repository-provisioning-in-progress': 503,
  'cloud-repository-provisioning-failed': 502,
  'cloud-repository-not-ready': 409,
  'cloud-repository-execution-unavailable': 409,
  'cloud-repository-org-github-not-connected': 409,
  'cloud-repository-outside-organization': 400,
  'cloud-repository-org-unavailable': 403,
  'cloud-repository-member-project-limit': 409,
  'cloud-repository-org-copy-exists': 409,
};

export const CLOUD_REPOSITORY_ERROR_COPY: Readonly<
  Record<CloudRepositoryErrorCode, string>
> = {
  'cloud-repository-disabled':
    "Repository projects aren't available for your account yet.",
  'cloud-repository-url-invalid':
    'Enter a GitHub repository URL, like https://github.com/owner/repo.',
  'cloud-repository-name-invalid':
    'Choose a repository name that uses only letters, numbers, hyphens, underscores and periods.',
  'cloud-repository-request-invalid':
    "Couldn't read this project request. Reload the page and try again.",
  'cloud-repository-not-found':
    "Couldn't find that repository on GitHub. Check its name and that you can access it.",
  'cloud-repository-forbidden':
    "GitHub didn't allow access to this repository. Check your access on GitHub, then try again.",
  'cloud-repository-read-only':
    'You need write access to this repository. Ask its owner for access, then try again.',
  'cloud-repository-archived':
    'This repository is archived on GitHub. Unarchive it or choose another repository.',
  'cloud-repository-empty':
    'This repository has no commits yet. Push a first commit, then try again.',
  'cloud-repository-owner-mismatch':
    "This repository isn't in the selected GitHub account. Choose the account that owns it.",
  'cloud-repository-not-installed':
    "The GitHub app can't access this repository. Grant it access on GitHub, then try again.",
  'cloud-repository-name-taken':
    'A repository with this name already exists in that account. Choose another name.',
  'cloud-repository-idempotency-conflict':
    'This project request was already used with different details. Start again to add the project.',
  'cloud-repository-template-conflict':
    "Couldn't finish setting up this project because of a conflicting cloud setup. Remove it and add the repository again.",
  'cloud-repository-identity-changed':
    'This repository was renamed, moved or replaced on GitHub. Add it again as a new project.',
  'cloud-repository-creation-uncertain':
    'GitHub may have created the repository. Check GitHub, then add it using GitHub or URL.',
  'cloud-repository-manifest-invalid':
    "Couldn't read this repository's project configuration file. Fix it on the default branch, then try again.",
  'cloud-repository-manifest-unsupported':
    "This repository's project configuration uses script options cloud projects don't support yet. Update it, then try again.",
  'cloud-repository-multi-repo-unsupported':
    "Cloud projects don't support multi-repository configurations yet. Choose a single-repository project instead.",
  'cloud-repository-provisioning-in-progress':
    'This project is still being set up. Check again in a moment.',
  'cloud-repository-provisioning-failed':
    "Couldn't finish setting up this project. Retry setup to continue.",
  'cloud-repository-not-ready':
    "This project isn't set up yet. Finish setup in project settings, then try again.",
  // The one server refusal under this code is project-scoped file work in a
  // repository project (REG-3022, D9), whatever its setup state: a READY
  // project reads it too, so it names the files and says nothing of setup or
  // chats. Client gates for an unfinished setup or an unreadable row own
  // their copy (`cloud-workspace-execution.ts`) and never borrow this one.
  'cloud-repository-execution-unavailable':
    "Shared project files aren't available for repository projects. Use the files in a worktree.",
  'cloud-repository-org-github-not-connected':
    'Connect GitHub for this organization first. An organization admin can do that in Organization settings.',
  'cloud-repository-outside-organization':
    "This repository is outside the organization's GitHub installation. Pick one of the organization's repositories.",
  // Desktop's copy for the same refusals of a member project create.
  'cloud-repository-org-unavailable':
    "You can't create projects in this organization right now.",
  'cloud-repository-member-project-limit': `You've reached the limit of ${MEMBER_ORG_PROJECT_LIMIT} cloud projects in this organization. Delete one to make another.`,
  // Desktop gives a member one copy of an organization project; the refusal
  // carries that copy's `details.workspaceId` so a host can open it.
  'cloud-repository-org-copy-exists':
    "You already have this repository in this organization's cloud projects.",
};

export const CLOUD_REPOSITORY_ERROR_RETRYABLE: Readonly<
  Record<CloudRepositoryErrorCode, boolean>
> = {
  'cloud-repository-disabled': false,
  'cloud-repository-url-invalid': false,
  'cloud-repository-name-invalid': false,
  'cloud-repository-request-invalid': false,
  'cloud-repository-not-found': false,
  'cloud-repository-forbidden': false,
  'cloud-repository-read-only': false,
  'cloud-repository-archived': false,
  'cloud-repository-empty': false,
  'cloud-repository-owner-mismatch': false,
  'cloud-repository-not-installed': false,
  'cloud-repository-name-taken': false,
  'cloud-repository-idempotency-conflict': false,
  'cloud-repository-template-conflict': false,
  'cloud-repository-identity-changed': false,
  'cloud-repository-creation-uncertain': false,
  'cloud-repository-manifest-invalid': false,
  'cloud-repository-manifest-unsupported': false,
  'cloud-repository-multi-repo-unsupported': false,
  'cloud-repository-provisioning-in-progress': true,
  'cloud-repository-provisioning-failed': true,
  'cloud-repository-not-ready': false,
  'cloud-repository-execution-unavailable': false,
  'cloud-repository-org-github-not-connected': false,
  'cloud-repository-outside-organization': false,
  'cloud-repository-org-unavailable': false,
  'cloud-repository-member-project-limit': false,
  'cloud-repository-org-copy-exists': false,
};

/** Transient GitHub connection outcomes; the rest need the user to act. */
const GITHUB_CLOUD_ERROR_RETRYABLE: Readonly<
  Record<GitHubCloudErrorCode, boolean>
> = {
  'github-cloud-disconnected': false,
  'github-cloud-needs-reauth': false,
  'github-cloud-needs-install': false,
  'github-cloud-adoption-pending': true,
  'github-cloud-state-invalid': false,
  'github-cloud-installation-not-visible': false,
  'github-cloud-operation-superseded': false,
  'github-rate-limited': true,
  'github-unavailable': true,
};

export function cloudRepositoryFailureStatus(
  code: CloudRepositoryFailureCode,
): CloudRepositoryErrorStatus | GitHubCloudErrorStatus {
  return isCloudRepositoryErrorCode(code)
    ? CLOUD_REPOSITORY_ERROR_STATUS[code]
    : GITHUB_CLOUD_ERROR_STATUS[code];
}

export function cloudRepositoryFailureCopy(
  code: CloudRepositoryFailureCode,
): string {
  return isCloudRepositoryErrorCode(code)
    ? CLOUD_REPOSITORY_ERROR_COPY[code]
    : GITHUB_CLOUD_ERROR_COPY[code];
}

export function isCloudRepositoryFailureRetryable(
  code: CloudRepositoryFailureCode,
): boolean {
  return isCloudRepositoryErrorCode(code)
    ? CLOUD_REPOSITORY_ERROR_RETRYABLE[code]
    : GITHUB_CLOUD_ERROR_RETRYABLE[code];
}

/**
 * Whether a project whose setup FAILED with this code offers Retry setup,
 * possibly after the user repairs their GitHub connection, the app
 * installation or their repository access. This is the repository DTO's
 * `provisioning.retryable`; it is deliberately broader than
 * `isCloudRepositoryFailureRetryable` (the same request may succeed without
 * any user action), which stays the error envelope's meaning.
 *
 * Never offered for a different repository (identity changed, owner
 * mismatch), a conflicting cloud setup, an uncertain Create new, or for codes
 * a retry cannot change: request-level refusals and the frozen manifest (a
 * retry replays the stored snapshot, never the branch).
 */
export const CLOUD_REPOSITORY_RETRY_SETUP_OFFERED: Readonly<
  Record<CloudRepositoryFailureCode, boolean>
> = {
  // Transient.
  'cloud-repository-provisioning-in-progress': true,
  'cloud-repository-provisioning-failed': true,
  'github-rate-limited': true,
  'github-unavailable': true,
  'github-cloud-adoption-pending': true,
  'github-cloud-operation-superseded': true,
  // Repairable connection or installation access.
  'github-cloud-disconnected': true,
  'github-cloud-needs-reauth': true,
  'github-cloud-needs-install': true,
  'github-cloud-installation-not-visible': true,
  'github-cloud-state-invalid': true,
  'cloud-repository-not-installed': true,
  'cloud-repository-forbidden': true,
  // Repairable repository access on GitHub.
  'cloud-repository-not-found': true,
  'cloud-repository-read-only': true,
  'cloud-repository-archived': true,
  // Not this repository or not this setup any more.
  'cloud-repository-identity-changed': false,
  'cloud-repository-owner-mismatch': false,
  'cloud-repository-template-conflict': false,
  'cloud-repository-creation-uncertain': false,
  'cloud-repository-idempotency-conflict': false,
  // Fixed by the stored request or snapshot, which a retry replays.
  'cloud-repository-empty': false,
  'cloud-repository-manifest-invalid': false,
  'cloud-repository-manifest-unsupported': false,
  'cloud-repository-multi-repo-unsupported': false,
  'cloud-repository-name-taken': false,
  // Request-level refusals, never a stored setup failure.
  'cloud-repository-disabled': false,
  'cloud-repository-url-invalid': false,
  'cloud-repository-name-invalid': false,
  'cloud-repository-request-invalid': false,
  'cloud-repository-org-github-not-connected': false,
  'cloud-repository-outside-organization': false,
  'cloud-repository-org-unavailable': false,
  'cloud-repository-member-project-limit': false,
  'cloud-repository-org-copy-exists': false,
  'cloud-repository-not-ready': false,
  'cloud-repository-execution-unavailable': false,
};

/**
 * The repository DTO's `provisioning.retryable`: Retry setup is offered only
 * for a FAILED setup whose stored code the table above marks repairable.
 * Never while PENDING (setup is running) or READY (the template is frozen).
 */
export function isCloudRepositoryProvisioningRetryable(
  state: RepositoryProvisioningState,
  errorCode: CloudRepositoryFailureCode | null,
): boolean {
  return (
    state === 'FAILED' &&
    errorCode !== null &&
    CLOUD_REPOSITORY_RETRY_SETUP_OFFERED[errorCode]
  );
}

export interface CloudRepositoryErrorOptions {
  /** Sanitized through the allowlist; anything else is dropped. */
  readonly details?: CloudRepositoryErrorDetails;
  /** Seconds for a `Retry-After` header; kept only as a positive integer. */
  readonly retryAfterSeconds?: number;
}

/** An expected, typed outcome of repository project creation or setup. */
export class CloudRepositoryError extends Error {
  readonly code: CloudRepositoryErrorCode;
  readonly status: CloudRepositoryErrorStatus;
  readonly retryable: boolean;
  readonly details: CloudRepositoryErrorDetails | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: CloudRepositoryErrorCode,
    options: CloudRepositoryErrorOptions = {},
  ) {
    super(CLOUD_REPOSITORY_ERROR_COPY[code]);
    this.name = 'CloudRepositoryError';
    this.code = code;
    this.status = CLOUD_REPOSITORY_ERROR_STATUS[code];
    this.retryable = CLOUD_REPOSITORY_ERROR_RETRYABLE[code];
    this.details = readCloudRepositoryErrorDetails(options.details);
    const { retryAfterSeconds } = options;
    this.retryAfterSeconds =
      retryAfterSeconds !== undefined &&
      Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds > 0
        ? retryAfterSeconds
        : null;
  }
}

export function isCloudRepositoryError(
  error: unknown,
): error is CloudRepositoryError {
  return error instanceof CloudRepositoryError;
}

export interface CloudRepositoryErrorBody {
  readonly error: {
    readonly code: CloudRepositoryFailureCode;
    readonly message: string;
    readonly details?: CloudRepositoryErrorDetails;
    readonly retryable?: true;
  };
}

/**
 * The route response body for a repository or GitHub connection error. Route
 * `details` (for example the `workspaceId` of a row created before the
 * failure) are merged over the error's own; the result is re-allowlisted.
 */
export function toCloudRepositoryErrorBody(
  error: CloudRepositoryError | GitHubCloudConnectionError,
  details?: CloudRepositoryErrorDetails,
): CloudRepositoryErrorBody {
  const ownDetails = isCloudRepositoryError(error)
    ? error.details
    : { repositoryFullName: error.repositoryFullName };
  const merged = readCloudRepositoryErrorDetails({
    ...ownDetails,
    ...details,
  });
  return {
    error: {
      code: error.code,
      message: cloudRepositoryFailureCopy(error.code),
      ...(merged === null ? {} : { details: merged }),
      ...(isCloudRepositoryFailureRetryable(error.code)
        ? { retryable: true }
        : {}),
    },
  };
}

export interface CloudRepositoryErrorReading {
  readonly code: CloudRepositoryFailureCode;
  readonly details: CloudRepositoryErrorDetails | null;
  /** From the fixed table, not from the body. */
  readonly retryable: boolean;
}

/**
 * The allowlisted code and details of an untrusted error body, or null. With
 * `status`, the code must also carry its contract status. Display the local
 * copy for the code (`cloudRepositoryFailureCopy`), never the body's message.
 */
export function readCloudRepositoryErrorBody(
  body: unknown,
  status?: number,
): CloudRepositoryErrorReading | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return null;
  }
  const envelope: unknown = Reflect.get(body, 'error');
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    Array.isArray(envelope)
  ) {
    return null;
  }
  const code: unknown = Reflect.get(envelope, 'code');
  if (!isCloudRepositoryFailureCode(code)) return null;
  if (status !== undefined && cloudRepositoryFailureStatus(code) !== status) {
    return null;
  }
  return {
    code,
    details: readCloudRepositoryErrorDetails(Reflect.get(envelope, 'details')),
    retryable: isCloudRepositoryFailureRetryable(code),
  };
}
