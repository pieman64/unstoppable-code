import type { KnownSettingsError } from '../errors/settings-error-copy';

/**
 * Local copy for the organization GitHub connection and repository picker
 * failures, keyed by the structured `code` the routes send. It mirrors
 * `GITHUB_PICKER_ERROR_COPY` and `GITHUB_CONNECT_ERROR_COPY` in
 * `apps/web/src/lib/teams` word for word, so settings show the same sentence
 * the service writes without ever rendering the server's text. Keep the two in
 * step; `docs/ux-writing.md` lists both.
 */

/** Repository picker and project-create failures, by route `code`. */
export const GITHUB_PICKER_ERROR_COPY = {
  'github-not-connected': 'Connect GitHub first.',
  'github-installation-suspended':
    'The GitHub installation is suspended. Reconnect GitHub first.',
  'github-installation-unavailable':
    "Couldn't use the GitHub installation. Reconnect GitHub first.",
  'github-rate-limited': 'GitHub rate limit reached. Try again in a minute.',
  'github-unavailable': "Couldn't reach GitHub. Try again.",
} as const satisfies Record<string, string>;

/** A member opened the picker; the route answers 403 with no code. */
export const GITHUB_PICKER_NOT_ADMIN_COPY =
  'Only organization owners and admins can pick repositories.';

/** Connecting the GitHub App to an organization, by route `code`. */
export const GITHUB_CONNECT_ERROR_COPY = {
  'github-app-not-configured':
    "GitHub App isn't configured for this environment.",
  'github-unavailable': "Couldn't reach GitHub. Try again.",
  'github-installation-not-found':
    "Couldn't find that GitHub installation. Install the app again.",
  'github-installation-suspended':
    'The GitHub installation is suspended. Unsuspend it on GitHub, then reconnect.',
  'github-sign-in-required': 'Sign in with GitHub, then reconnect.',
  'github-installation-not-administered':
    "Your GitHub account doesn't administer that installation. Install the app as an owner of that GitHub account or organization.",
  'github-installation-already-connected':
    'That GitHub installation is already connected to another organization.',
} as const satisfies Record<string, string>;

function knownByCode(
  table: Readonly<Record<string, string>>,
): readonly KnownSettingsError[] {
  return Object.entries(table).map(([serverCode, copy]) => ({
    serverCode,
    copy,
  }));
}

/**
 * The picker's known failures for `settingsLoadErrorCopy` and
 * `settingsActionErrorCopy`. The 403 entry applies only where a call site
 * reaches it: organization routes send a lost-access 403 through
 * `isSettingsAccessLost` first.
 */
export const GITHUB_PICKER_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  ...knownByCode(GITHUB_PICKER_ERROR_COPY),
  { status: 403, copy: GITHUB_PICKER_NOT_ADMIN_COPY },
];

/** The organization connect flow's known failures, matched by `code`. */
export const GITHUB_CONNECT_KNOWN_ERRORS: readonly KnownSettingsError[] =
  knownByCode(GITHUB_CONNECT_ERROR_COPY);
