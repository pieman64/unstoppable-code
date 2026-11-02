/**
 * Source-level guard for CAN-2305 ("Open app links in the built-in browser").
 *
 * `window.api.browser.openExternal` means "always external, never reroute";
 * `openLink` is the one that honors the preference. The split is deliberately
 * fail-closed: a caller that forgets to opt in goes external, which is the
 * safe direction for an authentication hand-off.
 *
 * These call sites are too store/IPC-bound to mount in jsdom, so this scans
 * the sources instead. It exists so the classification cannot silently drift —
 * flipping a sign-in link onto `openLink`, or leaving a content link behind on
 * `openExternal`, is exactly the regression this guards.
 */
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const REPO_ROOT = process.cwd();
const RENDERER = 'apps/desktop-app/src/renderer/src';

/** Ordinary content links: these follow the preference. */
const CONTENT_LINK_FILES = [
  'client/ipc-local-memory-client.ts',
  'components/chat/agent-artifact-navigation.ts',
  'components/chat/GitHubWorkflowRunArtifactCard.tsx',
  'components/github/PrMergeMultiRepoModal.tsx',
  'components/github/PrMergeWarningModal.tsx',
  'components/shared/ToastContainer.tsx',
];

/**
 * Deliberately external. Authentication hand-offs, vendor/OS hand-offs, store
 * listings, authenticated cloud sessions, and the two places where leaving the
 * app IS the feature (the browser bar's escape hatch, the App Advisor
 * `browser.open_external` action contract).
 */
const ALWAYS_EXTERNAL_FILES = [
  'components/settings/AuthLoginModal.tsx',
  'components/chat/AuthRecoveryCard.tsx',
  'components/settings/OllamaTab.tsx',
  'components/startup/WindowsGitRequiredScreen.tsx',
  'components/shared/MobileAppCtaBanner.tsx',
  'components/overview/MobileAppPromoCard.tsx',
  'components/portal/RemoteControlMobileAppsCta.tsx',
  'components/portal/CanopyPortalModal.tsx',
  'components/onboarding/LegalConsentGate.tsx',
  // The browser bars' Open in external browser action lives in their shared
  // actions hook.
  'components/browser/useBrowserBarActions.ts',
  'lib/openBillingPage.ts',
  'lib/app-actions/dispatcher.ts',
  'components/activity/devServerOpen.ts',
];

// Prettier breaks long chains as `browser\n  .openExternal(...)`, so the
// member access may be separated from `browser` by whitespace.
const OPEN_LINK_CALL = /\bbrowser\s*\.openLink\(/;
const OPEN_EXTERNAL_CALL = /\bbrowser\s*\.openExternal\(/;

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, RENDERER, relative), 'utf8');
}

describe('app-link call-site classification', () => {
  it.each(CONTENT_LINK_FILES)(
    '%s routes content links through openLink',
    (relative) => {
      const source = read(relative);
      expect(source).toMatch(OPEN_LINK_CALL);
      expect(source).not.toMatch(OPEN_EXTERNAL_CALL);
    },
  );

  it.each(ALWAYS_EXTERNAL_FILES)(
    '%s stays on the always-external openExternal path',
    (relative) => {
      const source = read(relative);
      expect(source).toMatch(OPEN_EXTERNAL_CALL);
      expect(source).not.toMatch(OPEN_LINK_CALL);
    },
  );
});
