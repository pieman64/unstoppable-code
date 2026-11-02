/** Portable denial text shared by approval providers and transcript consumers. */
export const USER_DENIED_MESSAGE = 'The user denied this tool call.';
export const POLICY_DENIED_FALLBACK_MESSAGE = 'Denied by the approval policy.';
export const FAIL_CLOSED_MESSAGE =
  'Approval prompt unavailable; denied by default.';
export const APPROVAL_CANCELLED_MESSAGE =
  'Approval request cancelled; denied by default.';
export const APPROVAL_CHECK_FAILED_MESSAGE =
  'Approval check failed; denied by default.';
export const SAFETY_DENIED_MESSAGE_PREFIX = 'Blocked by a safety rule (';

export type SavedRuleDenialScope =
  | 'session'
  | 'project'
  | 'global'
  | 'repository';

export function userDeniedMessage(reason?: string): string {
  return reason?.trim()
    ? `The user denied this tool call: ${reason}`
    : USER_DENIED_MESSAGE;
}

export function savedRuleDeniedMessage(scope: SavedRuleDenialScope): string {
  return `Blocked by a saved deny rule (${scope} scope). This call cannot be approved from a prompt while the rule exists. Do not retry or repackage the blocked operation.`;
}

/** Accepts the existing policy's display label, without changing safety matching. */
export function safetyDeniedMessage(label: string): string {
  return `${SAFETY_DENIED_MESSAGE_PREFIX}${label}). This call cannot be approved from a prompt. Do not retry or repackage the blocked operation. Choose a safe alternative or explain the block to the user.`;
}
