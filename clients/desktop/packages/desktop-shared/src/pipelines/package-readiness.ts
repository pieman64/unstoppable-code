import type { PipelinePackageReadiness } from '../types/pipeline';

/**
 * True when Run must be blocked: a required requirement is known-missing, or
 * the package itself failed verification. `unknown` never blocks — it is
 * surfaced honestly instead of guessed either way.
 *
 * Pure and shared on purpose (CAN-3021). The desktop renderer gates its Run
 * button on this, and Electron main applies the identical rule when Remote
 * Control dispatches a shared pipeline it never rendered a modal for, so the
 * two surfaces cannot drift into disagreeing about what "not ready" means.
 */
export function isPipelinePackageRunBlocked(
  readiness: PipelinePackageReadiness | null,
): boolean {
  if (!readiness) return false;
  if (readiness.status === 'invalid') return true;
  return readiness.requirements.some(
    (requirement) => requirement.required && requirement.status === 'missing',
  );
}

/**
 * The refusal message for a run blocked by {@link isPipelinePackageRunBlocked}
 * with no setup UI in front of the user.
 *
 * The desktop modal says "Complete the required setup above…" because the
 * requirement list and its install affordances are rendered directly above the
 * Run button. Remote Control has neither, so it names where the setup has to
 * happen instead of pointing at nothing.
 *
 * Deliberately says "the desktop app" rather than interpolating the brand
 * display name. This constant is minted on the desktop and rendered in the
 * browser, so a brand name baked in here would be the PUBLISHING device's
 * brand, not the reading surface's — wrong for exactly the cross-surface case
 * it exists to serve. A generic surface noun is not a legacy product name, so
 * it satisfies the user-facing branding scan (this file is on its list).
 */
export const PIPELINE_PACKAGE_SETUP_REQUIRED_REMOTE_MESSAGE =
  'This pipeline needs setup finished in the desktop app before it can run.';
