import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildNoBillingSourceError } from '../types';

/**
 * Read a desktop-app source file for the cross-surface copy guards below.
 *
 * This test lives in `packages/desktop-shared` but reads `apps/desktop-app`,
 * which inverts the usual package direction. That is deliberate — the helper
 * being guarded lives here, so the guard does too — but it means a moved or
 * renamed file would otherwise fail with a bare ENOENT. Fail with the path and
 * the reason instead, so the fix is obvious.
 */
function readDesktopSource(relativePath: string): string {
  const fullPath = path.resolve(
    __dirname,
    '../../../..',
    'apps/desktop-app',
    relativePath,
  );
  if (!existsSync(fullPath)) {
    throw new Error(
      `Cannot guard no-billing-source copy: ${fullPath} does not exist. ` +
        'If the file moved, update this test to the new path.',
    );
  }
  return readFileSync(fullPath, 'utf8');
}

/**
 * ECW-9091. The no-billing-source dead end is described in three places: the two
 * main-process backstops (now sharing {@link buildNoBillingSourceError}) and the
 * renderer's `NoBillingSourceBanner`. The banner cannot reuse the string — it
 * renders the "Get AI Credits" remedy as an interactive element rather than
 * prose — so these tests are what keep the wording from drifting apart.
 */
describe('buildNoBillingSourceError', () => {
  it('names the provider on both the problem and the remedy', () => {
    expect(buildNoBillingSourceError('Claude', 'Canopy')).toBe(
      "You're not signed in to Claude and have no Canopy AI Credits available. " +
        'Get AI Credits or sign in to Claude to start chatting.',
    );
  });

  it('differs only by provider name between the two providers', () => {
    const claude = buildNoBillingSourceError('Claude', 'Canopy');
    const codex = buildNoBillingSourceError('Codex', 'Canopy');

    expect(claude).not.toBe(codex);
    expect(claude.split('Claude').join('Codex')).toBe(codex);
  });

  // The brand name is injected, never hard-coded — a user-visible surface must
  // not embed the legacy product name (see CLAUDE.md "Branding / Whitelabeling").
  it('takes the brand display name from its caller', () => {
    expect(buildNoBillingSourceError('Claude', 'Acme')).toContain(
      'no Acme AI Credits',
    );
  });

  it('is the single source of the backstop copy for both providers', () => {
    for (const source of ['claude', 'codex'].map((provider) =>
      readDesktopSource(`src/main/agents/${provider}-session.ts`),
    )) {
      expect(source).toContain('buildNoBillingSourceError(');
      // The literal must not have been reintroduced alongside the helper.
      expect(source).not.toContain("You're not signed in to");
    }
  });

  it('stays in step with the renderer banner phrasing', () => {
    const banner = readDesktopSource(
      'src/renderer/src/components/chat/NoBillingSourceBanner.tsx',
    );

    // The banner says the same thing, phrased for a UI with buttons rather than
    // a single error string: a short title for the state, one sentence after
    // it for the other missing half, and the two remedies as button labels.
    // Assert the title, the message AND each remedy label so a reworded
    // remedy fails here instead of quietly diverging. (Matching only the bare
    // token `AI Credits` was too weak to catch drift.)
    // CAN-4764: the banner's words live in the shared recovery copy, so trace
    // main -> shared copy -> banner.
    const recoveryCopy = readFileSync(
      path.resolve(
        __dirname,
        '../../../ui-shared/src/components/creditsRecoveryCopy.ts',
      ),
      'utf8',
    );
    expect(recoveryCopy).toContain(
      'title: `Not signed in to ${providerLabel}`',
    );
    expect(recoveryCopy).toContain(
      'message: `You have no ${appName} AI Credits to cover this chat either.`',
    );
    expect(banner).toMatch(
      /import \{[^}]*\bnotSignedInCopy\b[^}]*\} from '@canopy\/ui-shared\/components';/,
    );
    // The sign-in label gains "instead" while a credits hand-off is visible
    // (`visibleHandoff !== null`); both variants must keep the same remedy.
    expect(banner).toContain(': `Sign in to ${providerLabel}`');
    expect(banner).toContain('? `Sign in to ${providerLabel} instead`');
    // The credits CTA takes its label from the shared purchase copy, so pin
    // both the reference and the shared value it resolves to.
    expect(banner).toContain('label={AI_CREDITS_PURCHASE_LABEL}');
    const purchaseCopy = readFileSync(
      path.resolve(
        __dirname,
        '../../../ui-shared/src/components/aiCreditsPurchaseCopy.ts',
      ),
      'utf8',
    );
    expect(purchaseCopy).toContain(
      "export const AI_CREDITS_PURCHASE_LABEL = 'Get AI Credits';",
    );

    // Both surfaces must name the same two remedies: get credits, or sign in.
    const error = buildNoBillingSourceError('Claude', 'Canopy');
    expect(error).toContain('Get AI Credits');
    expect(error).toContain('sign in to Claude');
    expect(banner).toContain('Get AI Credits');
  });
});
