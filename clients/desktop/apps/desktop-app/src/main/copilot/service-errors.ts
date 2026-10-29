/**
 * The Copilot service refused a request because an organization or
 * enterprise policy disables the feature for this seat. GitHub's CLI reports
 * the same condition as "Access denied by policy settings"; retrying cannot
 * fix it, only an organization owner can.
 */
export class CopilotPolicyError extends Error {
  constructor() {
    super(
      "An organization policy blocks Copilot CLI for this GitHub account. Ask an organization owner to enable Copilot CLI in the organization's Copilot policies, then connect again.",
    );
    this.name = 'CopilotPolicyError';
  }
}

// Each phrase has an observed source; add one only with the same evidence.
const POLICY_REFUSAL = [
  // The Copilot service's 403 body for a seat under a disabled Copilot CLI
  // policy, as the pinned runtime (Copilot CLI 1.0.89, 2026-10-14) folds it
  // into the models.list request error.
  /not authorized to use this copilot feature/i,
  // The CLI's own wording for the same condition ("Access denied by policy
  // settings"), per GitHub's Copilot CLI authentication troubleshooting page.
  /access denied by (?:copilot )?policy/i,
];

/**
 * Recognize a policy refusal inside the SDK's error. The runtime folds the
 * HTTP status and body into the message text, so the body phrases are the
 * only stable signal; a bare 403 is left alone because a seat that does not
 * exist answers the same way.
 */
export function describeCopilotServiceRefusal(
  error: unknown,
): CopilotPolicyError | undefined {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return POLICY_REFUSAL.some((pattern) => pattern.test(message))
    ? new CopilotPolicyError()
    : undefined;
}
